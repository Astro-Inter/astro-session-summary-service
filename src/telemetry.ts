import type { Env } from "./config.ts";
import { JobError } from "./config.ts";
import type { RunStats } from "./job.ts";
import type { Fetcher } from "./http.ts";

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (ms: number) => (BigInt(Math.floor(ms)) * 1000000n).toString();

export function otelHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const item of value.split(",").filter(Boolean)) {
    const equals = item.indexOf("=");
    if (equals <= 0) throw new JobError("invalid_otel_headers");
    const key = item.slice(0, equals).trim();
    const decoded = decodeURIComponent(item.slice(equals + 1).trim());
    if (!/^[a-zA-Z0-9-]+$/.test(key) || /[\r\n]/.test(decoded)) throw new JobError("invalid_otel_headers");
    headers[key] = decoded;
  }
  return headers;
}

export async function exportTelemetry(env: Env, stats: RunStats, start: number,
  status: string, fetcher: Fetcher = fetch, runId?: string): Promise<void> {
  // Um lote pequeno por execução horária. Nunca exporta mensagens, resumo, UID ou URI do Mongo.
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  try {
    const base = new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT);
    if (base.protocol !== "https:" || !base.hostname.endsWith(".grafana.net") ||
      base.username || base.password || base.search || base.hash) throw new JobError("invalid_otel_endpoint");
    const end = start + stats.durationMs;
    const resource = { attributes: [attr("service.name", "astro-session-summary-service"),
      attr("service.version", "0.1.0"), attr("deployment.environment.name", env.APP_ENV ?? "development")] };
    const scope = { name: "astro.summary", version: "0.1.0" };
    const point = (value: number, attributes: ReturnType<typeof attr>[] = []) => ({
      timeUnixNano: nanos(end), asDouble: value, attributes,
    });
    const metrics = [
      { name: "astro.summary.sessions", description: "Sessões do último lote horário, por resultado", unit: "{session}",
        gauge: { dataPoints: ["selected", "completed", "failed", "stale", "deferred"].map(key =>
          point(stats[key as keyof RunStats] as number, [attr("result", key)])) } },
      { name: "astro.summary.llm_calls", description: "Chamadas lógicas de resumo no último lote", unit: "{call}",
        gauge: { dataPoints: [point(stats.llmCalls)] } },
      { name: "astro.summary.run_duration", unit: "s", gauge: { dataPoints: [point(stats.durationMs / 1000)] } },
      { name: "astro.summary.last_run", unit: "s", gauge: { dataPoints: [point(end / 1000)] } },
    ];
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const payloads: Record<string, unknown> = {
      metrics: { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }] },
      traces: { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [{ traceId, spanId,
        name: "summary.hourly_run", kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
        attributes: [attr("job.status", status)], status: { code: status === "failed" || status === "partial" || stats.failed > 0 ? 2 : 1 },
      }] }] }] },
      logs: { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [{
        timeUnixNano: nanos(end), observedTimeUnixNano: nanos(end), traceId, spanId,
        severityNumber: status === "failed" || status === "partial" || stats.failed > 0 ? 17 : 9,
        severityText: status === "failed" || status === "partial" || stats.failed > 0 ? "ERROR" : "INFO",
        body: { stringValue: JSON.stringify({ event: "summary_run", status, run_id: runId, ...stats }) },
      }] }] }] },
    };
    for (const [signal, body] of Object.entries(payloads)) {
      const response = await fetcher(`${base.href.replace(/\/$/, "")}/v1/${signal}`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
        headers: { ...otelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS ?? ""), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // Não imprimir body/headers; o resultado da telemetria não altera o resumo salvo.
      if (!response.ok) console.warn(JSON.stringify({ event: "telemetry_export_failed", signal, http_status: response.status }));
      else if (response.status !== 204) {
        const result = await response.json() as { partialSuccess?: { rejectedDataPoints?: number; rejectedSpans?: number; rejectedLogRecords?: number } };
        if (result.partialSuccess && Object.values(result.partialSuccess).some(value => typeof value === "number" && value > 0)) {
          console.warn(JSON.stringify({ event: "telemetry_export_partial", signal }));
        }
      }
      await response.body?.cancel().catch(() => {});
    }
  } catch { console.warn(JSON.stringify({ event: "telemetry_unavailable" })); }
}
