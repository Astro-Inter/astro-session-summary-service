import { JobError } from "./config.ts";
import { ObservedFailure } from "./diagnostics.ts";

export type Fetcher = typeof fetch;
export async function requestJson(url: string, init: RequestInit, code: string,
  fetcher: Fetcher = fetch, timeout = 20000): Promise<any> {
  try {
    // Workers não implementa redirect:error. manual impede reenviar credenciais.
    const response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      const raw = Number(response.headers.get("retry-after") ?? "1");
      const delay = Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.ceil(raw))) : 1;
      throw new JobError(`${code}_http_${response.status}`, delay);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new JobError(`${code}_invalid_response`);
    let size = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 512000) throw new JobError(`${code}_response_too_large`);
        parts.push(result.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { buffer.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error instanceof JobError) throw error;
    // Não propagar mensagens HTTP/driver: podem conter URIs, tokens ou conteúdo.
    throw new JobError(`${code}_unavailable`);
  }
}

export function safeCode(error: unknown): string {
  if (error instanceof ObservedFailure) return safeCode(error.cause);
  return error instanceof JobError && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : "internal_error";
}
