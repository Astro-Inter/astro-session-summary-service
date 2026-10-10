import { MongoClient } from "mongodb";

process.loadEnvFile(".dev.vars");
const client = new MongoClient(process.env.MONGODB_URI, {
  maxPoolSize: 1, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000,
  socketTimeoutMS: 5000, appName: "astro-summary-read-only-check",
});
let failed = false;
try {
  await client.connect();
  await client.db(process.env.MONGODB_DATABASE).command({ ping: 1 });
  console.log("MongoDB: ping OK; nenhum documento lido ou alterado.");
} catch { console.error("MongoDB: indisponível; verificar rede, TLS e credenciais."); failed = true; }
finally { await client.close().catch(() => {}); }
try {
  const url = new URL(process.env.QDRANT_URL);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error();
  const response = await fetch(url.href.replace(/\/$/, "") + "/collections/memoria_resumos", {
    headers: process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {},
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  console.log(`Qdrant: HTTP ${response.status}; consulta somente da configuração da coleção.`);
  if (!response.ok) failed = true;
  await response.body?.cancel();
} catch { console.error("Qdrant: indisponível; verificar rede e credenciais."); failed = true; }
process.exitCode = failed ? 1 : 0;
