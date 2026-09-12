import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "database");
test("curated sources, JSON export, checksum and SQLite remain synchronized", () => {
  const json = readFileSync(join(root, "exports/questions.json"), "utf8");
  const { questions } = JSON.parse(json);
  // Git may check out text with CRLF on Windows.
  const digest = createHash("sha256").update(json.replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(readFileSync(join(root, "exports/questions.sha256"), "utf8").split(/\s/)[0], digest);
  const curated = readdirSync(join(root, "curated")).filter(name => /^ai-\d{8}\.json$/.test(name))
    .flatMap(name => JSON.parse(readFileSync(join(root, "curated", name), "utf8")).questions.filter(q => !q.error));
  assert.equal(curated.length, questions.length);
  const exported = new Map(questions.map(q => [q.id, q]));
  const db = new DatabaseSync(join(root, "ai_question_bank.sqlite3"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions").get().n, questions.length);
    for (const q of curated) {
      const item = exported.get(q.id);
      for (const key of Object.keys(q)) assert.deepEqual(item[key], q[key], `${q.id}: ${key}`);
      const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(q.id);
      for (const field of ["stem", "explanation", "type", "topic", "difficulty", "review_status", "review_note"])
        assert.equal(row[field], q[field], `${q.id}: SQLite ${field}`);
      for (const field of ["answer", "prompt_formulas", "solution_formulas"])
        assert.deepEqual(JSON.parse(row[`${field}_json`]), q[field], `${q.id}: SQLite ${field}`);
      assert.deepEqual(db.prepare("SELECT label, text FROM options WHERE question_id = ? ORDER BY position").all(q.id).map(row => ({ ...row })), q.options);
    }
  } finally { db.close(); }
});
