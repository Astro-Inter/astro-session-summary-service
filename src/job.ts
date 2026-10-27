import { diagnostic, observe } from "./diagnostics.ts";
import { JobError, RUN_BUDGET_MS } from "./config.ts";
import { safeCode } from "./http.ts";
import { sourceDate, summaryCurrent } from "./repository.ts";
import type { Repository, Session } from "./repository.ts";
import { segments } from "./summarizer.ts";
import type { Summarizer } from "./summarizer.ts";
import type { Vectors } from "./vectors.ts";

export interface RunStats { selected: number; completed: number; failed: number; stale: number;
  deferred: number; llmCalls: number; errors: Record<string, number>; durationMs: number }

export async function runJob(repo: Repository, ai: Summarizer, vectors: Vectors,
  limit: number, now = new Date(), clock: () => number = Date.now, runId?: string): Promise<RunStats> {
  const start = clock();
  const stats: RunStats = { selected: 0, completed: 0, failed: 0, stale: 0,
    deferred: 0, llmCalls: 0, errors: {}, durationMs: 0 };
  const ids = await observe("select_candidates", "mongodb", () => repo.candidates(now, limit));
  stats.selected = ids.length;
  for (const id of ids) {
    if (clock() - start >= RUN_BUDGET_MS - 30000) { stats.deferred++; continue; }
    let doc: Session | null = null;
    try {
      doc = await observe("claim_session", "mongodb", () => repo.claim(id, new Date(clock())));
      if (!doc) { stats.stale++; continue; }
      let summary = doc.resumo ?? "";
      if (!summaryCurrent(doc)) {
        const parts = segments(doc.mensagens);
        const validCheckpoint = doc.resumo_automatico_base_em instanceof Date &&
          doc.resumo_automatico_base_em.getTime() === sourceDate(doc).getTime() &&
          doc.resumo_automatico_base_total === doc.mensagens.length &&
          Number.isInteger(doc.resumo_automatico_ate) && doc.resumo_automatico_ate! > 0 &&
          doc.resumo_automatico_ate! <= parts.length && !!doc.resumo_automatico_parcial?.trim();
        let offset = validCheckpoint ? doc.resumo_automatico_ate! : 0;
        summary = validCheckpoint ? doc.resumo_automatico_parcial! : "";
        while (offset < parts.length) {
          if (clock() - start >= RUN_BUDGET_MS - 30000) throw new JobError("run_budget_exhausted");
          if (!await repo.current(doc)) throw new JobError("snapshot_changed");
          const chunk = parts.slice(offset, offset + 2);
          stats.llmCalls++;
          summary = await observe("summarize_chunk", "llm", () => ai.complete(summary, chunk, doc!.iniciada_em));
          offset += chunk.length;
          if (!await repo.checkpoint(doc, summary, offset)) throw new JobError("snapshot_changed");
        }
        if (!await repo.save(doc, summary)) throw new JobError("snapshot_changed");
      }
      if (!await repo.current(doc)) throw new JobError("snapshot_changed");
      await observe("upsert_vectors", "qdrant", () => vectors.upsert(doc!, summary));
      if (!await repo.indexed(doc)) throw new JobError("snapshot_changed");
      stats.completed++;
    } catch (error) {
      const code = safeCode(error);
      const deferred = code === "snapshot_changed" || code === "run_budget_exhausted";
      console[deferred ? "log" : "error"](JSON.stringify({ event: deferred ? "summary_item_deferred" : "summary_item_failed", run_id: runId, ...diagnostic(error) }));
      if (code === "snapshot_changed") stats.stale++;
      else if (code === "run_budget_exhausted") stats.deferred++;
      else { stats.failed++; stats.errors[code] = (stats.errors[code] ?? 0) + 1; }
      if (doc && code !== "snapshot_changed" && code !== "run_budget_exhausted") {
        await repo.fail(doc, code).catch(() => { stats.errors.mongodb_failure_record = (stats.errors.mongodb_failure_record ?? 0) + 1; });
      }
    } finally {
      if (doc) await repo.release(doc).catch(() => {
        stats.errors.mongodb_release = (stats.errors.mongodb_release ?? 0) + 1;
      });
    }
  }
  stats.durationMs = Math.max(0, clock() - start);
  return stats;
}
