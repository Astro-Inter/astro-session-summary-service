import { JobError } from "./config.ts";
import type { Env } from "./config.ts";
import { requestJson } from "./http.ts";
import type { Fetcher } from "./http.ts";

export function retryable(error: unknown): error is JobError {
  return error instanceof JobError && /^openrouter_(?:unavailable|http_(408|429|500|502|503|504|524|529))$/.test(error.code);
}

export async function requestModel(env: Env, path: "/chat/completions" | "/embeddings",
  payload: Record<string, unknown>, fetcher: Fetcher = fetch, attempts = 2): Promise<any> {
  if (!env.OPENROUTER_API_KEY?.trim()) throw new JobError("missing_openrouter_api_key");
  if (!["/chat/completions", "/embeddings"].includes(path)) throw new JobError("invalid_openrouter_endpoint");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const start = Date.now();
    try {
      const data = await requestJson("https://openrouter.ai/api/v1" + path, {
        method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ ...payload, provider: { require_parameters: true, data_collection: "deny" } }),
      }, "openrouter", fetcher, 30000);
      if (!data || typeof data !== "object") throw new JobError("openrouter_invalid_response");
      if (data.error) {
        const code = Number(data.error.code);
        throw new JobError(Number.isInteger(code) && code >= 400 && code <= 599 ? `openrouter_http_${code}` : "openrouter_invalid_response");
      }
      const usage = Object.fromEntries(Object.entries(data.usage ?? {}).filter(([k, v]) =>
        ["prompt_tokens", "completion_tokens", "total_tokens", "cost"].includes(k) && typeof v === "number" && Number.isFinite(v)));
      console.log(JSON.stringify({ event: "openrouter_usage", model: payload.model, durationMs: Date.now() - start, usage }));
      return data;
    } catch (error) {
      if (attempt + 1 >= attempts || !retryable(error) || (error.retryAfter ?? 1) > 2) throw error;
      await new Promise(resolve => setTimeout(resolve, (error.retryAfter ?? 1) * 1000));
    }
  }
  throw new JobError("openrouter_unavailable");
}
