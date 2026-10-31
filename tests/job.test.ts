import test from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../src/job.ts";
import { JobError, INACTIVITY_MS, RUN_BUDGET_MS } from "../src/config.ts";
import { sourceDate, summaryCurrent } from "../src/repository.ts";
import type { Repository, Session } from "../src/repository.ts";

function fixture() {
  const doc: Session = { _id: "9021d386-41e5-4746-9b83-eee90a3148c2", usuario_id: "owner", status: "ativa",
    iniciada_em: new Date(Date.now() - 2 * INACTIVITY_MS), atualizada_em: new Date(Date.now() - INACTIVITY_MS),
    mensagens: [{ papel: "human", conteudo: "Preciso revisar treinamento" }, { papel: "assistant", conteudo: "Orientação" }],
    resumo: "", resumo_indexado: false };
  let claimed = false, calls = 0, embeddings = 0;
  const same = (snapshot: Session) => snapshot.mensagens.length === doc.mensagens.length &&
    sourceDate(snapshot).getTime() === sourceDate(doc).getTime();
  const repo: Repository = {
    async candidates() { return summaryCurrent(doc) && doc.resumo_indexado ? [] : [doc._id]; },
    async claim() { if (claimed) return null; claimed = true; return structuredClone(doc); },
    async current(snapshot) { return same(snapshot); },
    async checkpoint(snapshot, summary, offset) {
      if (!same(snapshot)) return false;
      Object.assign(doc, { resumo_automatico_parcial: summary, resumo_automatico_ate: offset,
        resumo_automatico_base_em: sourceDate(snapshot), resumo_automatico_base_total: snapshot.mensagens.length });
      return true;
    },
    async save(snapshot, summary) {
      if (!same(snapshot)) return false;
      Object.assign(doc, { resumo: summary, resumo_mensagens: snapshot.mensagens.length,
        resumo_ultima_mensagem_em: sourceDate(snapshot), resumo_indexado: false });
      return true;
    },
    async indexed(snapshot) { if (!same(snapshot)) return false; doc.resumo_indexado = true; return true; },
    async fail(_snapshot, code) { doc.resumo_tarefa_erro = code; },
    async release() { claimed = false; }, async close() {},
  };
  const ai = { async complete() { calls++; return "Resumo fiel"; } };
  const vectors = { async upsert() { embeddings++; } };
  return { doc, repo, ai, vectors, counts: () => ({ calls, embeddings }) };
}

test("resume sem encerrar e não paga novamente na próxima execução", async () => {
  const f = fixture(), originalDate = f.doc.atualizada_em;
  assert.equal((await runJob(f.repo, f.ai, f.vectors, 5)).completed, 1);
  assert.equal(f.doc.status, "ativa");
  assert.equal(f.doc.atualizada_em, originalDate);
  assert.equal(f.doc.resumo_indexado, true);
  assert.equal((await runJob(f.repo, f.ai, f.vectors, 5)).selected, 0);
  assert.deepEqual(f.counts(), { calls: 1, embeddings: 1 });
});

test("mensagem durante a IA impede salvar resumo obsoleto", async () => {
  const f = fixture();
  f.ai.complete = async () => { f.doc.mensagens.push({ papel: "human", conteudo: "Mensagem nova" }); return "Velho"; };
  const stats = await runJob(f.repo, f.ai, f.vectors, 5);
  assert.equal(stats.stale, 1);
  assert.equal(f.doc.resumo, "");
  assert.equal(f.counts().embeddings, 0);
});

test("mensagem durante Qdrant não marca índice obsoleto como atual", async () => {
  const f = fixture();
  f.vectors.upsert = async () => { f.doc.mensagens.push({ papel: "human", conteudo: "Nova" }); };
  assert.equal((await runJob(f.repo, f.ai, f.vectors, 5)).stale, 1);
  assert.equal(f.doc.resumo_indexado, false);
  assert.equal(summaryCurrent(f.doc), false);
});

test("falha do índice reutiliza resumo salvo sem repetir a IA", async () => {
  const f = fixture(), original = f.vectors.upsert;
  f.vectors.upsert = async () => { throw new JobError("qdrant_http_503"); };
  assert.equal((await runJob(f.repo, f.ai, f.vectors, 5)).failed, 1);
  assert.equal(f.doc.resumo, "Resumo fiel");
  assert.equal(f.doc.resumo_tarefa_erro, "qdrant_http_503");
  f.vectors.upsert = original;
  assert.equal((await runJob(f.repo, f.ai, f.vectors, 5)).completed, 1);
  assert.equal(f.counts().calls, 1);
});

test("checkpoints retomam todos os trechos após falha, sem truncar", async () => {
  const f = fixture();
  f.doc.mensagens = [{ papel: "human", conteudo: "a".repeat(30000) }];
  let seen = 0, attempts = 0;
  const ai = { async complete(_previous: string, messages: { content: string }[]) {
    attempts++;
    if (attempts === 2) throw new JobError("groq_http_429");
    seen += messages.reduce((total, m) => total + m.content.length, 0);
    return "Checkpoint";
  } };
  assert.equal((await runJob(f.repo, ai, f.vectors, 5)).failed, 1);
  assert.equal(f.doc.resumo_automatico_ate, 2);
  assert.equal((await runJob(f.repo, ai, f.vectors, 5)).completed, 1);
  assert.equal(seen, 30000);
});

test("nova mensagem invalida também o checkpoint", async () => {
  const f = fixture();
  Object.assign(f.doc, { resumo_automatico_parcial: "Memória antiga", resumo_automatico_ate: 2,
    resumo_automatico_base_em: sourceDate(f.doc), resumo_automatico_base_total: 2 });
  f.doc.mensagens.push({ papel: "human", conteudo: "Novo" });
  let first = "";
  const ai = { async complete(previous: string) { first ||= previous || "vazio"; return "Novo resumo"; } };
  await runJob(f.repo, ai, f.vectors, 5);
  assert.equal(first, "vazio");
});

test("duas execuções simultâneas não resumem a mesma sessão", async () => {
  const f = fixture();
  const results = await Promise.all([runJob(f.repo, f.ai, f.vectors, 5), runJob(f.repo, f.ai, f.vectors, 5)]);
  assert.equal(results.reduce((n, stats) => n + stats.completed, 0), 1);
  assert.equal(f.counts().calls, 1);
});

test("lease perdido e orçamento esgotado não geram indexação", async () => {
  const f = fixture();
  f.repo.current = async () => false;
  assert.equal((await runJob(f.repo, f.ai, f.vectors, 5)).stale, 1);
  let tick = 0;
  assert.equal((await runJob(f.repo, f.ai, f.vectors, 5, new Date(), () => (tick++ ? RUN_BUDGET_MS : 0))).deferred, 1);
  assert.equal(f.counts().calls, 0);
});

test("erro externo é sanitizado, não grava credenciais no documento", async () => {
  const f = fixture();
  f.ai.complete = async () => { throw new Error("mongodb://usuario:segredo@host conteúdo privado"); };
  const stats = await runJob(f.repo, f.ai, f.vectors, 5);
  assert.deepEqual(stats.errors, { internal_error: 1 });
  assert.equal(f.doc.resumo_tarefa_erro, "internal_error");
});
