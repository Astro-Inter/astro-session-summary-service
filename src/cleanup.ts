import type { Collection, Document, Filter, MongoClient } from "mongodb";
import { JobError, INACTIVITY_MS } from "./config.ts";
import { safeCode } from "./http.ts";
import { requestJson } from "./http.ts";
import type { Fetcher } from "./http.ts";

export interface CleanupEnv {
  MONGODB_URI: string;
  MONGODB_DATABASE: string;
  CLEANUP_ENABLED?: string;
  CLEANUP_BATCH_SIZE?: string;
  QDRANT_URL: string;
  QDRANT_API_KEY?: string;
  QDRANT_MEMORY_COLLECTION?: string;
}

// Exige array realmente vazio, não campo ausente/nulo ou documento malformado.
// A idade vem da criação, nunca da última atualização interna.
export function emptySessionFilter(now: Date): Filter<Document> {
  return {
    status: "ativa", mensagens: { $type: "array", $size: 0 },
    iniciada_em: { $type: "date", $lt: new Date(now.getTime() - INACTIVITY_MS) },
    resumo: { $in: [null, ""] }, acao_pendente: null,
    usuario_id: { $type: "string", $ne: "" },
    $and: ["reserva_ate", "lock_ate", "resumo_tarefa_ate", "resumo_job_ate"].map(field => ({
      $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: { $lte: now } }],
    })),
  };
}

export async function cleanEmptySessions(collection: Collection<Document>, limit: number,
  clock: () => Date = () => new Date(),
  remove: (filter: Filter<Document>) => Promise<{ deletedCount: number }> = filter => collection.deleteOne(filter)) {
  const start = clock();
  const docs = await collection.find(emptySessionFilter(start), {
    projection: { _id: 1, iniciada_em: 1 },
  }).sort({ iniciada_em: 1, _id: 1 }).limit(limit).toArray();
  const stats = { selected: docs.length, deleted: 0, preserved: 0, deferred: 0 };
  for (const doc of docs) {
    const now = clock();
    if (now.getTime() - start.getTime() > 45000) { stats.deferred++; continue; }
    // Revalida todos os predicados na exclusão atômica: não basta selecionar IDs.
    // Se o chat adquiriu uma reserva ou gravou uma mensagem, a sessão é preservada.
    const result = await remove({ ...emptySessionFilter(now),
      _id: doc._id, iniciada_em: doc.iniciada_em });
    if (result.deletedCount === 1) stats.deleted++;
    else stats.preserved++;
  }
  return stats;
}

export async function removeSessionVectors(env: CleanupEnv, sessionId: string, owner: string, fetcher: Fetcher = fetch) {
  if (!owner || typeof owner !== "string") throw new JobError("invalid_session_owner");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) throw new JobError("invalid_session_id");
  const base = new URL(env.QDRANT_URL);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new JobError("invalid_qdrant_url");
  const names = [...new Set(["memoria_resumos", env.QDRANT_MEMORY_COLLECTION ?? "memoria_resumos_openai_te3s_v1"])];
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new JobError("invalid_vector_collection");
    try {
      const result = await requestJson(`${base.href.replace(/\/$/, "")}/collections/${name}/points/delete?wait=true`, {
        method: "POST", headers: { "content-type": "application/json", ...(env.QDRANT_API_KEY ? { "api-key": env.QDRANT_API_KEY } : {}) },
        body: JSON.stringify({ filter: { must: [ { has_id: [sessionId] },
          { should: [{ key: "id_user", match: { value: owner } }, { key: "usuario_id", match: { value: owner } }] } ] } }),
      }, "cleanup_qdrant", fetcher);
      if (result?.status !== "ok" || result?.result?.status !== "completed") throw new JobError("cleanup_qdrant_not_completed");
    } catch (error) {
      // Coleção inexistente não contém vetor; demais falhas mantêm a pendência.
      if (safeCode(error) !== "cleanup_qdrant_http_404") throw error;
    }
  }
}

export async function drainCleanupQueue(sessions: Collection<Document>, queue: Collection<Document>,
  removeVectors: (id: string, owner: string) => Promise<void>, limit: number) {
  const jobs = await queue.find({}).sort({ criada_em: 1 }).limit(limit).toArray();
  const start = Date.now();
  let completed = 0, failed = 0;
  for (const job of jobs) {
    if (Date.now() - start > 90000) break;
    try {
      // Um UUID recriado não deve perder seus vetores novos.
      if (!await sessions.findOne({ _id: job.session_id }, { projection: { _id: 1 } })) {
        await removeVectors(job.session_id, job.usuario_id);
      }
      await queue.deleteOne({ _id: job._id }); completed++;
    } catch (error) {
      failed++;
      await queue.updateOne({ _id: job._id }, { $set: { erro: safeCode(error) }, $inc: { tentativas: 1 } });
    }
  }
  return { vectors_completed: completed, vectors_failed: failed };
}

export async function cleanupRun(env: CleanupEnv) {
  let client: MongoClient | undefined;
  const start = Date.now();
  try {
    if (env.CLEANUP_ENABLED !== "true") {
      console.log(JSON.stringify({ event: "empty_session_cleanup", status: "disabled" }));
      return;
    }
    const limit = Number(env.CLEANUP_BATCH_SIZE ?? "100");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new JobError("invalid_cleanup_batch_size");
    if (!env.MONGODB_URI || !env.MONGODB_DATABASE || !env.QDRANT_URL) throw new JobError("missing_cleanup_credentials");
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 1, minPoolSize: 0, maxConnecting: 1,
      serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, timeoutMS: 15000,
      appName: "astro-session-cleanup-service", w: "majority",
    });
    await client.connect();
    const sessions = client.db(env.MONGODB_DATABASE).collection("sessoes");
    const queue = client.db(env.MONGODB_DATABASE).collection("sessoes_limpeza_pendencias");
    const stats = await cleanEmptySessions(sessions, limit, () => new Date(), async filter => {
      // Outbox e exclusão são atômicos: uma falha nunca perde o retry do Qdrant.
      return client!.withSession(session => session.withTransaction(async () => {
        const doc = await sessions.findOne(filter, { session, projection: { _id: 1, usuario_id: 1 } });
        if (!doc) return { deletedCount: 0 };
        const result = await sessions.deleteOne(filter, { session });
        if (result.deletedCount) await queue.insertOne({ session_id: doc._id,
          usuario_id: doc.usuario_id, criada_em: new Date(), tentativas: 0 }, { session });
        return result;
      }, { writeConcern: { w: "majority" }, maxCommitTimeMS: 5000 }));
    });
    const vectors = await drainCleanupQueue(sessions, queue, (id, owner) => removeSessionVectors(env, id, owner), limit);
    console.log(JSON.stringify({ event: "empty_session_cleanup", status: vectors.vectors_failed ? "partial" : "completed", ...stats, ...vectors,
      durationMs: Date.now() - start }));
  } catch (error) {
    console.error(JSON.stringify({ event: "empty_session_cleanup", status: "failed", code: safeCode(error) }));
    throw new Error(safeCode(error));
  } finally { await client?.close(); }
}

export default {
  async scheduled(_event: ScheduledController, env: CleanupEnv) { await cleanupRun(env); },
  async fetch(request: Request) {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ service: "astro-session-cleanup-service", status: "ok" },
      { headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<CleanupEnv>;
