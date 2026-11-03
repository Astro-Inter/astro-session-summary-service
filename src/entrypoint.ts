import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./config.ts";
import { hourlyRun } from "./worker.ts";

export { default } from "./worker.ts";

// Invocação interna pelo astro-shared-scheduler; sem endpoint HTTP de execução.
export class ScheduledJob extends WorkerEntrypoint<Env> {
  async run() {
    const jobs = [hourlyRun(this.env)];
    if (new Date().getUTCHours() % 6 === 0 && this.env.CLEANUP) jobs.push(this.env.CLEANUP.run().then(() => {}));
    const results = await Promise.allSettled(jobs);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return { service: "astro-session-summary-service",
      status: this.env.ENABLED === "true" ? "executed" : "skipped" };
  }

  async status() {
    return { service: "astro-session-summary-service", enabled: this.env.ENABLED === "true" };
  }
}
