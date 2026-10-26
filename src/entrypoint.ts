import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./config.ts";
import { hourlyRun } from "./worker.ts";

export { default } from "./worker.ts";

// Invocação interna pelo astro-shared-scheduler; sem endpoint HTTP de execução.
export class ScheduledJob extends WorkerEntrypoint<Env> {
  async run() {
    await hourlyRun(this.env);
    return { service: "astro-session-summary-service",
      status: this.env.ENABLED === "true" ? "executed" : "skipped" };
  }

  async status() {
    return { service: "astro-session-summary-service", enabled: this.env.ENABLED === "true" };
  }
}
