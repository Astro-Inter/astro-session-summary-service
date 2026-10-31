import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterSummarizer, parseSummary, segments, redact } from "../src/summarizer.ts";
import { QdrantVectors } from "../src/vectors.ts";
import { otelHeaders, exportTelemetry } from "../src/telemetry.ts";
import { requestJson } from "../src/http.ts";
import type { Env } from "../src/config.ts";
import type { Fetcher } from "../src/http.ts";
import type { Session } from "../src/repository.ts";
import worker from "../src/worker.ts";

const env = { MONGODB_URI: "mongodb://localhost", MONGODB_DATABASE: "test", OPENROUTER_API_KEY: "secret",
  QDRANT_URL: "https://qdrant.example", QDRANT_API_KEY: "q-secret" } as Env;

test("JSON inválido, vazio, com campos extras e longo é rejeitado", () => {
  for (const content of ["", "texto", '{}', '{"resumo":""}', '{"resumo":"a","outro":1}',
    JSON.stringify({ resumo: "a".repeat(4001) })]) assert.throws(() => parseSummary(content));
  assert.equal(parseSummary('{"resumo":" válido "}'), "válido");
});

test("redação remove credenciais óbvias e segmentos preservam todo o texto", () => {
  assert.equal(redact("senha: segredo"), "senha: [SEGREDO_REMOVIDO]");
  assert.ok(!redact("gsk_12345678901234567890").includes("1234567890"));
  const parts = segments([{ papel: "human", conteudo: "a".repeat(13000) }]);
  assert.equal(parts.map(p => p.content).join("").length, 13000);
  assert.equal(parts.length, 3);
  assert.throws(() => segments([{ role: "tool", content: "a" }] as any));
});

test("OpenRouter repete 429 com a mesma chave e exige termino stop", async () => {
  const keys: string[] = [];
  const fetcher = (async (_url, init) => {
    assert.equal(init!.redirect, "manual");
    keys.push((init!.headers as any).Authorization);
    if (keys.length === 1) return new Response("cota", { status: 429 });
    const body = JSON.parse(init!.body as string);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.response_format.type, "json_object");
    assert.equal(body.model, "openai/gpt-6-luna");
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.temperature, undefined);
    assert.equal(body.tools, undefined);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"resumo":"ok"}' } }] });
  }) as Fetcher;
  assert.equal(await new OpenRouterSummarizer(env, fetcher).complete("", [], new Date()), "ok");
  assert.deepEqual(keys, ["Bearer secret", "Bearer secret"]);
  for (const status of [401, 402, 403, 404, 400]) {
    let calls = 0;
    const rejected = (async () => { calls++; return new Response("segredo", { status }); }) as Fetcher;
    await assert.rejects(new OpenRouterSummarizer(env, rejected).complete("", [], new Date()));
    assert.equal(calls, 1);
  }
  const truncated = (async () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{"resumo":"ok"}' } }] })) as Fetcher;
  await assert.rejects(new OpenRouterSummarizer(env, truncated).complete("", [], new Date()));
});

test("Qdrant usa UUID estável e mantém namespace do usuário", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/collections/memoria_resumos_openai_te3s_v1")) return Response.json({ result: { config: { params: { vectors: { dense: { size: 1536, distance: "Cosine" } } } } } });
    if (String(url).includes("embeddings")) return Response.json({ data: [{ embedding: Array(1536).fill(0.1) }] });
    return Response.json({ status: "ok", result: { status: "completed" } });
  }) as Fetcher;
  const doc = { _id: "9021d386-41e5-4746-9b83-eee90a3148c2", usuario_id: "owner", iniciada_em: new Date(), atualizada_em: new Date(), mensagens: [] } as unknown as Session;
  await new QdrantVectors(env, fetcher).upsert(doc, "Resumo");
  const point = JSON.parse(requests[2].init!.body as string).points[0];
  assert.equal(point.id, doc._id);
  assert.equal(point.payload.id_user, "owner");
  assert.equal(point.payload.modelo_embedding, "openai/text-embedding-3-small");
  assert.equal(point.vector.dense.length, 1536);
});

test("Qdrant rejeita embeddings inválidos e coleção incompatível", async () => {
  const doc = { _id: "9021d386-41e5-4746-9b83-eee90a3148c2", usuario_id: "owner", iniciada_em: new Date(), atualizada_em: new Date(), mensagens: [] } as unknown as Session;
  for (const dimension of [384, 1536]) {
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
import { PrivacyMap, redactForEmbedding } from "../src/privacy.ts";
import { memoryCollection, config } from "../src/config.ts";

test("pseudonimizacao para vetores usa os mesmos marcadores da API", () => {
  const value = "CPF 123.456.789-01; contato ana@privado.example; NR-12 em 20/10/2026 às 10:30";
  assert.equal(redactForEmbedding(value), "CPF [CPF]; contato [EMAIL]; NR-12 em 20/10/2026 às 10:30");
  const privacy = new PrivacyMap();
  assert.equal(privacy.restore(privacy.mask(value)), value);
  assert.throws(() => privacy.restore("[ASTRO_PII_012345abcdef_EMAIL_1]"));
});

test("colecao antiga e rejeitada antes de qualquer embedding ou gravacao", async () => {
  let calls = 0;
  const legacy = { ...env, QDRANT_MEMORY_COLLECTION: "memoria_resumos" };
  assert.throws(() => memoryCollection(legacy));
  assert.throws(() => config({ ...legacy, ENABLED: "true" }));
  await assert.rejects(new QdrantVectors(legacy, (async () => { calls++; return Response.json({}); }) as Fetcher)
    .upsert({ _id: "9021d386-41e5-4746-9b83-eee90a3148c2" } as Session, "Resumo"));
  assert.equal(calls, 0);
});

test("resumo usa tokens privados no provedor e restaura dados somente no backend", async () => {
  const fetcher = (async (_url, init) => {
    assert.equal(String(_url), "https://openrouter.ai/api/v1/chat/completions");
    const payload = JSON.parse(String(init?.body));
    assert.ok(!JSON.stringify(payload).includes("ana@privado.example"));
    const input = JSON.parse(payload.messages[1].content);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ resumo: input.mensagens[0].content }) } }] });
  }) as Fetcher;
  assert.equal(await new OpenRouterSummarizer(env, fetcher).complete("", [{ role: "human", content: "Contato ana@privado.example" }], new Date()), "Contato ana@privado.example");
});

test("invalidos nao sao persistidos e truncamento permite somente uma nova tentativa", async () => {
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, calls === 1 ? 4096 : 8192);
    return Response.json({ choices: [{ finish_reason: calls === 1 ? "length" : "stop", message: { content: calls === 1 ? "" : '{"resumo":"ok"}' } }] });
  }) as Fetcher;
  assert.equal(await new OpenRouterSummarizer(env, fetcher).complete("", [], new Date()), "ok");
  assert.equal(calls, 2);
});
