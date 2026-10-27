import { diagnostic, observe } from "./diagnostics.ts";
import { config } from "./config.ts";
import type { Env } from "./config.ts";
import { safeCode } from "./http.ts";
import { runJob } from "./job.ts";
import type { RunStats } from "./job.ts";
import { MongoRepository } from "./repository.ts";
import { OpenRouterSummarizer } from "./summarizer.ts";
import { QdrantVectors } from "./vectors.ts";
import { exportTelemetry } from "./telemetry.ts";

export async function hourlyRun(env: Env) {
  const start = Date.now();
  const runId = crypto.randomUUID();
  let repo: MongoRepository | undefined;
  let stats: RunStats = { selected: 0, completed: 0, failed: 0, stale: 0, deferred: 0,
    llmCalls: 0, errors: {}, durationMs: 0 };
  let status = "disabled";
  try {
    const options = config(env);
    if (!options.enabled) return;
    status = "completed";
    repo = await observe("connect", "mongodb", () => MongoRepository.connect(env));
    stats = await runJob(repo, new OpenRouterSummarizer(env), new QdrantVectors(env), options.batchSize, new Date(), Date.now, runId);
    if (stats.failed > 0 || Object.keys(stats.errors).length) status = "partial";
  } catch (error) {
    status = "failed";
    stats.errors[safeCode(error)] = 1;
    console.error(JSON.stringify({ event: "summary_run_failed", run_id: runId, ...diagnostic(error) }));
    throw error instanceof Error ? new Error(safeCode(error)) : new Error("internal_error");
  } finally {
    await repo?.close().catch(() => { stats.errors.mongodb_close = 1; });
    if (status === "completed" && Object.keys(stats.errors).length) status = "partial";
    stats.durationMs = Date.now() - start;
    console.log(JSON.stringify({ event: "summary_run", status, run_id: runId, ...stats }));
    await exportTelemetry(env, stats, start, status, fetch, runId);
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _context: ExecutionContext) {
    // Aguarda o lote na execução do Cron; não usa o limite de 30s do HTTP waitUntil.
    await hourlyRun(env);
  },
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/health" || request.method !== "GET") {
      return new Response("Not found", { status: 404 });
    }
    // Liveness apenas, sem acesso ao banco e sem endpoint público para disparar resumos.
    return Response.json({ service: "astro-session-summary-service", status: "ok" },
      { headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<Env>;
