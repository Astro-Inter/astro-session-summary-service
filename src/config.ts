export interface Env {
  MONGODB_URI: string;
  MONGODB_DATABASE: string;
  OPENROUTER_API_KEY: string;
  QDRANT_MEMORY_COLLECTION?: string;
  QDRANT_URL: string;
  QDRANT_API_KEY?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  ENABLED?: string;
  BATCH_SIZE?: string;
  APP_ENV?: string;
}

export const INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const LEASE_MS = 10 * 60 * 1000;
export const RUN_BUDGET_MS = 4 * 60 * 1000;
export const COLLECTION = "sessoes";

export class JobError extends Error {
  readonly code: string;
  retryAfter?: number;
  constructor(code: string, retryAfter?: number) { super(code); this.code = code; this.retryAfter = retryAfter; }
}

export function config(env: Env) {
  const enabled = env.ENABLED === "true";
  const batchSize = Number(env.BATCH_SIZE ?? "5");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) {
    throw new JobError("invalid_batch_size");
  }
  if (enabled) {
    for (const name of ["MONGODB_URI", "MONGODB_DATABASE", "OPENROUTER_API_KEY", "QDRANT_URL"] as const) {
      if (!env[name]?.trim()) throw new JobError("missing_" + name.toLowerCase());
    }
    if (!/^mongodb(\+srv)?:\/\//.test(env.MONGODB_URI)) throw new JobError("invalid_mongodb_uri");
    memoryCollection(env);
    const url = new URL(env.QDRANT_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new JobError("invalid_qdrant_url");
    }
  }
  return { enabled, batchSize };
}

export function memoryCollection(env: Env): string {
  const name = env.QDRANT_MEMORY_COLLECTION ?? "memoria_resumos_openai_te3s_v1";
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || !name.includes("_openai_te3s_")) {
    throw new JobError("invalid_memory_collection");
  }
  return name;
}
