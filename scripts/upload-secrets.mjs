import { spawnSync } from "node:child_process";
process.loadEnvFile(".dev.vars");
const names = ["MONGODB_URI", "MONGODB_DATABASE", "GROQ_API_KEY", "MISTRAL_API_KEY",
  "QDRANT_URL", "QDRANT_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS"];
const secrets = Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]]));
for (const name of ["MONGODB_URI", "MONGODB_DATABASE", "GROQ_API_KEY", "MISTRAL_API_KEY", "QDRANT_URL"]) {
  if (!secrets[name]) { console.error(`Credencial ausente: ${name}`); process.exit(1); }
}
// JSON pelo stdin, nunca pela linha de comando nem por arquivo versionável.
const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "secret", "bulk"], {
  input: JSON.stringify(secrets), encoding: "utf8", stdio: ["pipe", "inherit", "inherit"],
});
process.exit(result.status ?? 1);
