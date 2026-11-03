import { WorkerEntrypoint } from "cloudflare:workers";
import { cleanupRun } from "./cleanup.ts";
import type { CleanupEnv } from "./cleanup.ts";
export { default } from "./cleanup.ts";
export class CleanupJob extends WorkerEntrypoint<CleanupEnv> {
  async run() { await cleanupRun(this.env); return { service: "astro-session-cleanup-service", enabled: this.env.CLEANUP_ENABLED === "true" }; }
}
