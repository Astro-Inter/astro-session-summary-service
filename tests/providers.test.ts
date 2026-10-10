import test from "node:test";
import assert from "node:assert/strict";
import { GroqSummarizer, parseSummary, segments, redact } from "../src/summarizer.ts";
import { QdrantVectors } from "../src/vectors.ts";
import { otelHeaders, exportTelemetry } from "../src/telemetry.ts";
import { requestJson } from "../src/http.ts";
import type { Env } from "../src/config.ts";
import type { Fetcher } from "../src/http.ts";
import type { Session } from "../src/repository.ts";
import worker from "../src/worker.ts";

const env = { GROQ_API_KEY: "one| two |one", MISTRAL_API_KEY: "secret",
  QDRANT_URL: "https://qdrant.example", QDRANT_API_KEY: "q-secret" } as Env;

test("JSON inválido, vazio, com campos extras e longo é rejeitado", () => {
  for (const content of ["", "texto", '{}', '{"resumo":""}', '{"resumo":"a","outro":1}',
    JSON.stringify({ resumo: "a".repeat(4001) })]) assert.throws(() => parseSummary(content));
  assert.equal(parseSummary('{"resumo":" válido "}'), "válido");
});

test("redação remove credenciais óbvias e segmentos preservam todo o texto", () => {
  assert.equal(redact("senha: segredo"), "senha: [credencial removida]");
  assert.ok(!redact("gsk_12345678901234567890").includes("1234567890"));
  const parts = segments([{ role: "human", content: "a".repeat(13000) }]);
  assert.equal(parts.map(p => p.content).join("").length, 13000);
  assert.equal(parts.length, 3);
  assert.throws(() => segments([{ role: "tool", content: "a" }] as any));
});

test("Groq troca chave somente após 429 e exige término stop", async () => {
  const keys: string[] = [];
  const fetcher = (async (_url, init) => {
    assert.equal(init!.redirect, "manual");
    keys.push((init!.headers as any).Authorization);
    if (keys.length === 1) return new Response("cota", { status: 429 });
    const body = JSON.parse(init!.body as string);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.response_format.type, "json_object");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"resumo":"ok"}' } }] });
  }) as Fetcher;
  assert.equal(await new GroqSummarizer(env, fetcher).complete("", [], new Date()), "ok");
  assert.deepEqual(keys, ["Bearer one", "Bearer two"]);
  for (const status of [401, 403, 400]) {
    let calls = 0;
    const rejected = (async () => { calls++; return new Response("segredo", { status }); }) as Fetcher;
    await assert.rejects(new GroqSummarizer(env, rejected).complete("", [], new Date()));
    assert.equal(calls, 1);
  }
  const truncated = (async () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{"resumo":"ok"}' } }] })) as Fetcher;
  await assert.rejects(new GroqSummarizer(env, truncated).complete("", [], new Date()));
});

test("Qdrant usa UUID estável e mantém namespace do usuário", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/collections/memoria_resumos")) return Response.json({ result: { config: { params: { vectors: { dense: { size: 1024, distance: "Cosine" } } } } } });
    if (String(url).includes("embeddings")) return Response.json({ data: [{ embedding: Array(1024).fill(0.1) }] });
    return Response.json({ status: "ok", result: { status: "completed" } });
  }) as Fetcher;
  const doc = { _id: "9021d386-41e5-4746-9b83-eee90a3148c2", id_user: "owner", iniciada_em: new Date(), atualizada_em: new Date(), mensagens: [] } as unknown as Session;
  await new QdrantVectors(env, fetcher).upsert(doc, "Resumo");
  const point = JSON.parse(requests[2].init!.body as string).points[0];
  assert.equal(point.id, doc._id);
  assert.equal(point.payload.id_user, "owner");
  assert.equal(point.payload.modelo_embedding, "mistral-embed");
  assert.equal(point.vector.dense.length, 1024);
});

test("Qdrant rejeita embeddings inválidos e coleção incompatível", async () => {
  const doc = { _id: "9021d386-41e5-4746-9b83-eee90a3148c2", id_user: "owner", iniciada_em: new Date(), atualizada_em: new Date(), mensagens: [] } as unknown as Session;
  for (const dimension of [384, 1024]) {
    const fetcher = (async (url) => String(url).includes("embeddings")
      ? Response.json({ data: [{ embedding: [0] }] })
      : Response.json({ result: { config: { params: { vectors: { size: dimension, distance: "Cosine" } } } } })) as Fetcher;
    await assert.rejects(new QdrantVectors(env, fetcher).upsert(doc, "Resumo"));
  }
});

test("OTLP decodifica Basic%20 e exporta somente contagens, sem conteúdo de conversa", async () => {
  assert.equal(otelHeaders("Authorization=Basic%20abc=").Authorization, "Basic abc=");
  assert.throws(() => otelHeaders("Authorization=abc%0Adef"));
  const requests: string[] = [];
  await exportTelemetry({ ...env, OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway-prod-sa-east-1.grafana.net/otlp",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc=" }, {
    selected: 1, completed: 1, failed: 0, stale: 0, deferred: 0, llmCalls: 1, errors: {}, durationMs: 20,
  }, Date.now(), "completed", (async (url, init) => {
    assert.equal(init!.redirect, "manual");
    requests.push(String(url));
    const body = init!.body as string;
    assert.ok(!body.includes("owner") && !body.includes("q-secret") && !body.includes("mensagens"));
    assert.equal((init!.headers as any).Authorization, "Basic abc=");
    return Response.json({});
  }) as Fetcher);
  assert.equal(requests.length, 3);
  assert.ok(requests[0].endsWith("/otlp/v1/metrics"));
});

test("erros HTTP e respostas grandes não expõem o body", async () => {
  let redirects = 0;
  await assert.rejects(requestJson("https://example.test", {}, "provider", (async (_url, init) => {
    redirects++;
    assert.equal(init!.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://other.test" } });
  }) as Fetcher), { message: "provider_http_302" });
  assert.equal(redirects, 1);
  await assert.rejects(requestJson("https://example.test", {}, "provider", (async () => new Response("segredo", { status: 503 })) as Fetcher), { message: "provider_http_503" });
  await assert.rejects(requestJson("https://example.test", {}, "provider", (async () => new Response("a".repeat(512001))) as Fetcher), { message: "provider_response_too_large" });
});

test("Grafana pode aceitar logs com HTTP 204 sem JSON", async () => {
  let calls = 0;
  await exportTelemetry({ ...env, OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway-prod-sa-east-1.grafana.net/otlp" }, {
    selected: 0, completed: 0, failed: 0, stale: 0, deferred: 0, llmCalls: 0, errors: {}, durationMs: 1,
  }, Date.now(), "disabled", (async () => { calls++; return new Response(null, { status: 204 }); }) as Fetcher);
  assert.equal(calls, 3);
});

test("não há endpoint público para gerar resumos ou encerrar", async () => {
  assert.equal((await worker.fetch(new Request("https://example.test/health"))).status, 200);
  assert.equal((await worker.fetch(new Request("https://example.test/run", { method: "POST" }))).status, 404);
  assert.equal((await worker.fetch(new Request("https://example.test/encerrar"))).status, 404);
});
