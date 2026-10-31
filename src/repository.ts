import type { Collection, Filter, MongoClient } from "mongodb";
import { COLLECTION, INACTIVITY_MS, LEASE_MS, JobError } from "./config.ts";
import type { Env } from "./config.ts";

export interface Message { role: "human" | "assistant"; content: string }
export interface StoredMessage { papel: "human" | "assistant"; conteudo: string }
export interface Session {
  _id: string; usuario_id: string; status: string; iniciada_em: Date;
  atualizada_em: Date; ultima_mensagem_em?: Date; mensagens: StoredMessage[];
  resumo?: string; resumo_indexado?: boolean; resumo_mensagens?: number;
  resumo_ultima_mensagem_em?: Date;
  resumo_automatico_parcial?: string; resumo_automatico_ate?: number;
  resumo_automatico_base_em?: Date; resumo_automatico_base_total?: number;
  resumo_tarefa_token?: string; resumo_tarefa_ate?: Date; resumo_tarefa_tentativas?: number;
  resumo_tarefa_proxima_tentativa?: Date; resumo_tarefa_erro?: string;
  reserva_ate?: Date;
}

const lastMessage = { $ifNull: ["$ultima_mensagem_em", "$atualizada_em"] };
const totalMessages = { $size: { $ifNull: ["$mensagens", []] } };
const leaseAvailable = (field: string, now: Date) => ({ $or: [
  { [field]: { $exists: false } }, { [field]: { $lte: now } },
] });

export function eligibility(now: Date): Filter<Session> {
  return {
    status: { $in: ["ativa", "encerrada"] },
    "mensagens.0": { $exists: true },
    $and: [
      { $or: [
        { ultima_mensagem_em: { $lte: new Date(now.getTime() - INACTIVITY_MS) } },
        { ultima_mensagem_em: { $exists: false }, atualizada_em: { $lte: new Date(now.getTime() - INACTIVITY_MS) } },
      ] },
      leaseAvailable("reserva_ate", now), leaseAvailable("resumo_tarefa_ate", now),
      leaseAvailable("resumo_tarefa_proxima_tentativa", now),
      { $expr: { $or: [
        { $ne: [{ $ifNull: ["$resumo_mensagens", -1] }, totalMessages] },
        { $ne: [{ $ifNull: ["$resumo_ultima_mensagem_em", null] }, lastMessage] },
        { $ne: [{ $ifNull: ["$resumo_indexado", false] }, true] },
      ] } },
    ],
  } as Filter<Session>;
}

export function sourceDate(doc: Session): Date {
  const value = doc.ultima_mensagem_em ?? doc.atualizada_em;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new JobError("invalid_session_date");
  return value;
}

export function snapshotFilter(doc: Session, token: string, now: Date): Filter<Session> {
  return {
    _id: doc._id, usuario_id: doc.usuario_id, status: { $in: ["ativa", "encerrada"] },
    resumo_tarefa_token: token, resumo_tarefa_ate: { $gt: now },
    $expr: { $and: [
      { $eq: [lastMessage, sourceDate(doc)] },
      { $eq: [totalMessages, doc.mensagens.length] },
    ] },
    ...leaseAvailable("reserva_ate", now),
  } as Filter<Session>;
}

export function summaryCurrent(doc: Session): boolean {
  return !!doc.resumo?.trim() && doc.resumo_mensagens === doc.mensagens.length &&
    doc.resumo_ultima_mensagem_em instanceof Date &&
    doc.resumo_ultima_mensagem_em.getTime() === sourceDate(doc).getTime();
}

export interface Repository {
  candidates(now: Date, limit: number): Promise<string[]>;
  claim(id: string, now: Date): Promise<Session | null>;
  checkpoint(doc: Session, summary: string, offset: number): Promise<boolean>;
  save(doc: Session, summary: string): Promise<boolean>;
  current(doc: Session): Promise<boolean>;
  indexed(doc: Session): Promise<boolean>;
  fail(doc: Session, code: string): Promise<void>;
  release(doc: Session): Promise<void>;
  close(): Promise<void>;
}

export class MongoRepository implements Repository {
  private readonly client: MongoClient;
  private readonly collection: Collection<Session>;
  constructor(client: MongoClient, collection: Collection<Session>) {
    this.client = client; this.collection = collection;
  }

  static async connect(env: Env): Promise<MongoRepository> {
    // Import dentro da execução: o driver não deve usar aleatoriedade no escopo global do Worker.
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 1, minPoolSize: 0, maxConnecting: 1, retryWrites: true,
      serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000,
      timeoutMS: 15000, appName: "astro-session-summary-service", w: "majority",
    });
    try {
      await client.connect();
      return new MongoRepository(client, client.db(env.MONGODB_DATABASE).collection<Session>(COLLECTION));
    } catch {
      await client.close().catch(() => {});
      throw new JobError("mongodb_unavailable");
    }
  }

  async candidates(now: Date, limit: number): Promise<string[]> {
    const docs = await this.collection.find(eligibility(now), { projection: { _id: 1 } })
      .sort({ ultima_mensagem_em: 1, atualizada_em: 1, _id: 1 }).limit(limit).toArray();
    return docs.map(doc => doc._id);
  }

  async claim(id: string, now: Date): Promise<Session | null> {
    return this.collection.findOneAndUpdate({ _id: id, ...eligibility(now) }, {
      $set: { resumo_tarefa_token: crypto.randomUUID(), resumo_tarefa_ate: new Date(now.getTime() + LEASE_MS) },
    }, { returnDocument: "after" });
  }

  private async patch(doc: Session, fields: Record<string, unknown>): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(snapshotFilter(doc, doc.resumo_tarefa_token!, now), {
      $set: { ...fields, resumo_tarefa_ate: new Date(now.getTime() + LEASE_MS) },
    });
    return result.matchedCount === 1;
  }

  checkpoint(doc: Session, summary: string, offset: number) {
    return this.patch(doc, { resumo_automatico_parcial: summary, resumo_automatico_ate: offset,
      resumo_automatico_base_em: sourceDate(doc), resumo_automatico_base_total: doc.mensagens.length });
  }

  save(doc: Session, summary: string) {
    return this.patch(doc, { resumo: summary, resumo_indexado: false, resumo_mensagens: doc.mensagens.length,
      resumo_ultima_mensagem_em: sourceDate(doc), resumo_gerado_em: new Date(), resumo_origem: "automatico" });
  }

  async current(doc: Session) {
    return !!await this.collection.findOne(snapshotFilter(doc, doc.resumo_tarefa_token!, new Date()),
      { projection: { _id: 1 } });
  }

  async indexed(doc: Session) {
    return this.patch(doc, { resumo_indexado: true, resumo_tarefa_tentativas: 0,
      resumo_tarefa_proxima_tentativa: new Date(0), resumo_tarefa_erro: "",
      resumo_automatico_parcial: "", resumo_automatico_ate: 0 });
  }

  async fail(doc: Session, code: string) {
    const attempts = Math.min((doc.resumo_tarefa_tentativas ?? 0) + 1, 10);
    await this.patch(doc, { resumo_tarefa_tentativas: attempts, resumo_tarefa_erro: code,
      resumo_tarefa_proxima_tentativa: new Date(Date.now() + Math.min(2 ** attempts * 60000, 6 * 3600000)) });
  }

  async release(doc: Session) {
    await this.collection.updateOne({ _id: doc._id, usuario_id: doc.usuario_id, resumo_tarefa_token: doc.resumo_tarefa_token },
      { $unset: { resumo_tarefa_token: "", resumo_tarefa_ate: "" } });
  }

  async close() { await this.client.close(); }
}
