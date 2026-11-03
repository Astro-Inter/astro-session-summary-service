import test from "node:test";
import assert from "node:assert/strict";
import type { Collection, Document } from "mongodb";
import worker, { cleanEmptySessions, emptySessionFilter, cleanupRun, drainCleanupQueue, removeSessionVectors } from "../src/cleanup.ts";
import type { Fetcher } from "../src/http.ts";

const now = new Date("2026-11-02T12:00:00Z");
test("Qdrant apaga apenas UUID e dono nas coleções de memória, nunca FAQ", async () => {
  const id = "9021d386-41e5-4746-9b83-eee90a3148c2";
  const urls: string[] = [];
  await removeSessionVectors({ MONGODB_URI: "", MONGODB_DATABASE: "", QDRANT_URL: "https://qdrant.test" }, id, "owner", (async (url, init) => {
    urls.push(String(url));
    assert.equal(init!.redirect, "manual");
    const filter = JSON.parse(init!.body as string).filter;
    assert.deepEqual(filter.must[0], { has_id: [id] });
    assert.equal(filter.must[1].should[0].match.value, "owner");
    assert.equal(filter.must[1].should[1].match.value, "owner");
    return urls.length === 1 ? new Response(null, { status: 404 }) : Response.json({ status: "ok", result: { status: "completed" } });
  }) as Fetcher);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => !url.includes("faq")));
  await assert.rejects(removeSessionVectors({ MONGODB_URI: "", MONGODB_DATABASE: "", QDRANT_URL: "https://qdrant.test" }, id, "owner",
    (async () => new Response(null, { status: 401 })) as Fetcher), /cleanup_qdrant_http_401/);
});
test("limpeza exige mais de 24h de criação, array vazio e ausência de reservas", () => {
  const filter = emptySessionFilter(now);
  assert.equal(filter.status, "ativa");
  assert.deepEqual(filter.mensagens, { $type: "array", $size: 0 });
  assert.deepEqual(filter.iniciada_em, { $type: "date", $lt: new Date("2026-11-01T12:00:00Z") });
  assert.equal(filter.acao_pendente, null);
  const encoded = JSON.stringify(filter);
  for (const field of ["reserva_ate", "lock_ate", "resumo_tarefa_ate", "resumo_job_ate"]) assert.ok(encoded.includes(field));
  assert.ok(!encoded.includes("atualizada_em"));
});
test("exclusão revalida vazio e reservas na mesma operação, preservando corrida", async () => {
  const filters: Document[] = [];
  let appliedLimit = 0;
  const doc = { _id: "empty", iniciada_em: new Date("2026-10-30T00:00:00Z") };
  const collection = {
    find: () => ({ sort: () => ({ limit: (limit: number) => { appliedLimit = limit; return { toArray: async () => [doc, { ...doc, _id: "new-message" }] }; } }) }),
    deleteOne: async (filter: Document) => { filters.push(filter); return { deletedCount: filter._id === "empty" ? 1 : 0 }; },
  } as unknown as Collection<Document>;
  assert.deepEqual(await cleanEmptySessions(collection, 100, () => now), { selected: 2, deleted: 1, preserved: 1, deferred: 0 });
  assert.equal(appliedLimit, 100);
  assert.equal(filters.length, 2);
  for (const filter of filters) {
    assert.deepEqual(filter.mensagens, { $type: "array", $size: 0 });
    assert.deepEqual(filter.$and, emptySessionFilter(now).$and);
    assert.equal(filter.iniciada_em, doc.iniciada_em);
  }
});
test("orçamento adia exclusões e execução desativada dispensa credenciais", async () => {
  let calls = 0;
  const collection = { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [{ _id: "a" }] }) }) }),
    deleteOne: async () => { throw new Error("não deve excluir"); } } as unknown as Collection<Document>;
  assert.deepEqual(await cleanEmptySessions(collection, 1, () => new Date(now.getTime() + (calls++ ? 46000 : 0))),
    { selected: 1, deleted: 0, preserved: 0, deferred: 1 });
  await cleanupRun({ MONGODB_URI: "", MONGODB_DATABASE: "", QDRANT_URL: "", CLEANUP_ENABLED: "false" });
  await assert.rejects(cleanupRun({ MONGODB_URI: "", MONGODB_DATABASE: "", QDRANT_URL: "", CLEANUP_ENABLED: "true", CLEANUP_BATCH_SIZE: "0" }), /invalid_cleanup_batch_size/);
});

test("Qdrant indisponível mantém pendência para retry; UUID recriado é preservado", async () => {
  const removed: string[] = [], retried: string[] = [], vectorCalls: string[] = [];
  const jobs = ["ok", "failed", "recreated"].map(id => ({ _id: id, session_id: id, usuario_id: "owner" }));
  const queue = {
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => jobs }) }) }),
    deleteOne: async (filter: Document) => { removed.push(filter._id); },
    updateOne: async (filter: Document, update: Document) => { retried.push(filter._id); assert.equal(update.$set.erro, "internal_error"); },
  } as unknown as Collection<Document>;
  const sessions = { findOne: async (filter: Document) => filter._id === "recreated" ? { _id: "recreated" } : null } as unknown as Collection<Document>;
  assert.deepEqual(await drainCleanupQueue(sessions, queue, async id => {
    vectorCalls.push(id); if (id === "failed") throw new Error("secret must not be logged");
  }, 100), { vectors_completed: 2, vectors_failed: 1 });
  assert.deepEqual(vectorCalls, ["ok", "failed"]);
  assert.deepEqual(removed, ["ok", "recreated"]);
  assert.deepEqual(retried, ["failed"]);
});
test("não expõe endpoint público de exclusão", async () => {
  assert.equal((await worker.fetch(new Request("https://test/health"))).status, 200);
  assert.equal((await worker.fetch(new Request("https://test/run", { method: "POST" }))).status, 404);
});
