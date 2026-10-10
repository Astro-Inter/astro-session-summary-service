import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Configuração local explícita; copia somente os segredos necessários, sem imprimi-los.
const source = process.argv[2];
if (!source) { console.error("Uso: npm run configure:local -- CAMINHO_DA_API/.env"); process.exit(1); }
const suppliedHeaders = process.env.SUMMARY_OTEL_HEADERS;
process.loadEnvFile(resolve(source));
const names = ["MONGODB_URI", "MONGODB_DATABASE", "GROQ_API_KEY", "MISTRAL_API_KEY",
  "QDRANT_URL", "QDRANT_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS"];
const values = { ENABLED: "false", APP_ENV: "development", BATCH_SIZE: "5",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway-prod-sa-east-1.grafana.net/otlp" };
for (const name of names) values[name] = process.env[name] ?? "";
if (suppliedHeaders) values.OTEL_EXPORTER_OTLP_HEADERS = suppliedHeaders;
const output = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
// wx impede sobrescrever uma configuração local existente sem decisão explícita.
writeFileSync(resolve(".dev.vars"), output, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(".dev.vars criado; ENABLED=false; nenhum segredo exibido.");
for (const name of names) console.log(`${name}: ${values[name] ? "configurado" : "ausente"}`);
