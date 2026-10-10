import { JobError } from "./config.ts";
import type { Env } from "./config.ts";
import { requestJson } from "./http.ts";
import type { Fetcher } from "./http.ts";
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
    if (this.vectorName === undefined) {
      const data = await requestJson(this.url("/collections/memoria_resumos"), { headers: this.headers() }, "qdrant", this.fetcher);
      let vector = data?.result?.config?.params?.vectors;
      let vectorName: string | null = null;
      if (vector && typeof vector.size !== "number") {
        const names = Object.keys(vector);
        if (names.length !== 1) throw new JobError("invalid_vector_collection");
        vectorName = names[0]; vector = vector[vectorName];
      }
      if (vector?.size !== 1024 || vector?.distance !== "Cosine") {
        throw new JobError("invalid_vector_collection");
      }
      this.vectorName = vectorName;
    }
    const data = await requestJson("https://api.mistral.ai/v1/embeddings", {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${this.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({ model: "mistral-embed", input: [summary], encoding_format: "float" }),
    }, "embedding", this.fetcher);
    const vector = data?.data?.[0]?.embedding;
    if (data?.data?.length !== 1 || !Array.isArray(vector) || vector.length !== 1024 ||
      vector.some(value => typeof value !== "number" || !Number.isFinite(value)) || !vector.some(Boolean)) {
      throw new JobError("invalid_embedding");
    }
    const result = await requestJson(this.url("/collections/memoria_resumos/points?wait=true"), {
      method: "PUT", headers: this.headers(), body: JSON.stringify({ points: [{
        id: doc._id, vector: this.vectorName ? { [this.vectorName]: vector } : vector,
        payload: { id_user: doc.id_user, session_id: doc._id, resumo: summary,
          modelo_embedding: "mistral-embed", iniciada_em: doc.iniciada_em.toISOString(),
          resumo_mensagens: doc.mensagens.length, resumo_ultima_mensagem_em: sourceDate(doc).toISOString() },
      }] }),
    }, "qdrant", this.fetcher);
    if (result?.status !== "ok" || result?.result?.status !== "completed") throw new JobError("qdrant_not_completed");
  }
}
