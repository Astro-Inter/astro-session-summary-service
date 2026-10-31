import test from "node:test";
import assert from "node:assert/strict";
import { INACTIVITY_MS, config } from "../src/config.ts";
import type { Env } from "../src/config.ts";
import { eligibility, snapshotFilter, summaryCurrent, sourceDate } from "../src/repository.ts";
import type { Session } from "../src/repository.ts";

const now = new Date("2026-10-10T19:00:00Z");
const doc: Session = { _id: "id", usuario_id: "owner", status: "ativa", iniciada_em: now,
  atualizada_em: now, ultima_mensagem_em: new Date(now.getTime() - INACTIVITY_MS),
  mensagens: [{ papel: "human", conteudo: "Oi" }] };

test("elegibilidade usa 24 horas completas, estados permitidos e leases independentes", () => {
  const query = JSON.stringify(eligibility(now));
  assert.ok(query.includes("2026-10-09T19:00:00.000Z"));
  assert.ok(query.includes('"$lte"'));
  assert.ok(query.includes("resumo_tarefa_ate"));
  assert.ok(query.includes("reserva_ate"));
  assert.ok(query.includes("resumo_tarefa_proxima_tentativa"));
  assert.deepEqual(eligibility(now).status, { $in: ["ativa", "encerrada"] });
});

test("snapshot revalida dono, data, quantidade e token", () => {
  const query = snapshotFilter(doc, "token", now);
  assert.equal(query.usuario_id, "owner");
  assert.equal(query.resumo_tarefa_token, "token");
  assert.ok(JSON.stringify(query).includes('"$size"'));
  assert.ok(JSON.stringify(query).includes('"$eq"'));
});

test("resumo só está atual se data e quantidade corresponderem", () => {
  const summarized = { ...doc, resumo: "Saudação", resumo_mensagens: 1,
    resumo_ultima_mensagem_em: sourceDate(doc) };
  assert.equal(summaryCurrent(summarized), true);
  assert.equal(summaryCurrent({ ...summarized, mensagens: [...doc.mensagens, ...doc.mensagens] }), false);
  assert.equal(summaryCurrent({ ...summarized, ultima_mensagem_em: now }), false);
  assert.equal(summaryCurrent({ ...summarized, resumo: " " }), false);
});

test("legado usa atualizada_em sem exigir migração destrutiva", () => {
  assert.equal(sourceDate({ ...doc, ultima_mensagem_em: undefined }), now);
});

test("configuração é desativada por padrão e lotes são limitados", () => {
  assert.equal(config({} as Env).enabled, false);
  assert.throws(() => config({ BATCH_SIZE: "11" } as Env));
  assert.throws(() => config({ ENABLED: "true" } as Env));
});
