import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnostic, observe } from "./src/diagnostics.ts";

test("preserva etapa e SQLSTATE sem mensagem, valores ou caminho local", async () => {
  const failure = Object.assign(new Error("password=secret email=pessoa@example.com SELECT private"), { code: "53300" });
  failure.stack = "Error: private\n    at query (C:/private/user/project/database.ts:42:7)\nprivate payload\n    at run (worker.js:18:2)";
  await assert.rejects(observe("connect_legacy", "postgresql_legacy", () => { throw failure; }), error => {
    const fields = diagnostic(error);
    assert.equal(fields.stage, "connect_legacy");
    assert.equal(fields.error_code, "53300");
    assert.equal(fields.error_frames, "database.ts:42:7 > worker.js:18:2");
    assert.match(String(fields.error_message), /conexões/);
    assert.doesNotMatch(JSON.stringify(fields), /private|secret|pessoa@|SELECT|C:/);
    return true;
  });
});

test("preserva sucesso e etapa interna, limita causas cíclicas e rejeita código arbitrário", async () => {
  assert.equal(await observe("read", "database", async () => 42), 42);
  const original = Object.assign(new Error("sensitive"), { code: "private@example.com" });
  original.cause = original;
  assert.equal(diagnostic(original).error_code, "UNCLASSIFIED_ERROR");
  assert.equal(diagnostic(original).error_causes, "Error:UNCLASSIFIED_ERROR");
  await assert.rejects(observe("outer", "service", () => observe("inner", "database", () => { throw original; })), error => {
    assert.equal(diagnostic(error).stage, "inner");
    return true;
  });
});
