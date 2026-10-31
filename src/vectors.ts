import { JobError, memoryCollection } from "./config.ts";
import type { Env } from "./config.ts";
import { requestJson } from "./http.ts";
import type { Fetcher } from "./http.ts";
import { requestModel } from "./openrouter.ts";
import { redactForEmbedding } from "./privacy.ts";
import type { Session } from "./repository.ts";
import { sourceDate } from "./repository.ts";

export interface Vectors { upsert(doc: Session, summary: string): Promise<void> }
export class QdrantVectors implements Vectors {
  private readonly env: Env;
  private readonly fetcher: Fetcher;
  private vectorName: string | null | undefined;
  constructor(env: Env, fetcher: Fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  private url(path: string) { return this.env.QDRANT_URL.replace(/\/$/, "") + path; }
  private headers() {
    return { "content-type": "application/json", ...(this.env.QDRANT_API_KEY ? { "api-key": this.env.QDRANT_API_KEY } : {}) };
  }
  async upsert(doc: Session, summary: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(doc._id)) {
      throw new JobError("invalid_session_id");
    }
    const collection = memoryCollection(this.env);
    if (this.vectorName === undefined) {
      const data = await requestJson(this.url(`/collections/${collection}`), { headers: this.headers() }, "qdrant", this.fetcher);
      let vector = data?.result?.config?.params?.vectors;
      let vectorName: string | null = null;
      if (vector && typeof vector.size !== "number") {
        const names = Object.keys(vector);
        if (names.length !== 1) throw new JobError("invalid_vector_collection");
        vectorName = names[0]; vector = vector[vectorName];
      }
      if (vector?.size !== 1536 || vector?.distance !== "Cosine") {
        throw new JobError("invalid_vector_collection");
      }
      this.vectorName = vectorName;
    }
    const data = await requestModel(this.env, "/embeddings", {
      model: "openai/text-embedding-3-small", input: [redactForEmbedding(summary)],
      encoding_format: "float", dimensions: 1536,
    }, this.fetcher);
    const vector = data?.data?.[0]?.embedding;
    if (data?.data?.length !== 1 || (data.data[0].index !== undefined && data.data[0].index !== 0) || !Array.isArray(vector) || vector.length !== 1536 ||
      vector.some(value => typeof value !== "number" || !Number.isFinite(value)) || !vector.some(Boolean)) {
      throw new JobError("invalid_embedding");
    }
    const result = await requestJson(this.url(`/collections/${collection}/points?wait=true`), {
      method: "PUT", headers: this.headers(), body: JSON.stringify({ points: [{
        id: doc._id, vector: this.vectorName !== null ? { [this.vectorName]: vector } : vector,
        payload: { id_user: doc.usuario_id, session_id: doc._id, resumo: summary,
          modelo_embedding: "openai/text-embedding-3-small", iniciada_em: doc.iniciada_em.toISOString(),
          resumo_mensagens: doc.mensagens.length, resumo_ultima_mensagem_em: sourceDate(doc).toISOString() },
      }] }),
    }, "qdrant", this.fetcher);
    if (result?.status !== "ok" || result?.result?.status !== "completed") throw new JobError("qdrant_not_completed");
  }
}
