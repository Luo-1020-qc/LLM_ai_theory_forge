import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databaseDir = resolve(import.meta.dirname);
const curatedDir = join(databaseDir, "curated");
const exportsDir = join(databaseDir, "exports");
const sqlitePath = join(databaseDir, "ai_question_bank.sqlite3");

await mkdir(exportsDir, { recursive: true });

const files = (await readdir(curatedDir))
  .filter((name) => /^ai-\d{8}\.json$/.test(name))
  .sort();

const packages = [];
for (const file of files) {
  const content = await readFile(join(curatedDir, file), "utf8");
  packages.push(JSON.parse(content));
}

const issues = [];
const seenIds = new Set();
const allQuestions = [];

for (const pkg of packages) {
  const source = pkg.source;
  const validQuestions = pkg.questions.filter((question) => !question.error);
  if (source.parsed_choice_count !== validQuestions.length) {
    issues.push(`${source.id}: parsed_choice_count 与实际题数不一致`);
  }
  for (const question of validQuestions) {
    if (seenIds.has(question.id)) issues.push(`${question.id}: 稳定编号重复`);
    seenIds.add(question.id);
    if (!question.stem?.trim()) issues.push(`${question.id}: 缺题干`);
    if (!Array.isArray(question.options) || question.options.length < 2) {
      issues.push(`${question.id}: 选项不足`);
    }
    const labels = new Set(question.options.map((option) => option.label));
    if (labels.size !== question.options.length) {
      issues.push(`${question.id}: 选项标签重复`);
    }
    if (!question.answer?.length || question.answer.some((answer) => !labels.has(answer))) {
      issues.push(`${question.id}: 答案不在选项中`);
    }
    if (!question.explanation?.trim()) issues.push(`${question.id}: 缺讲解`);
    if (question.type === "single" && question.answer.length !== 1) {
      issues.push(`${question.id}: 单选题答案数不是 1`);
    }
    allQuestions.push({
      ...question,
      source_id: source.id,
      exam_date: source.exam_date,
      job_track: source.job_track,
      source_url: source.url,
    });
  }
}

if (issues.length) {
  throw new Error(`题库校验失败：\n${issues.join("\n")}`);
}

const exported = {
  metadata: {
    title: "互联网公司 AI 大模型基础理论试题题库",
    collected_at: "2026-08-12",
    source_count: packages.length,
    question_count: allQuestions.length,
    usable_count: allQuestions.filter((q) => q.review_status === "usable").length,
    needs_review_count: allQuestions.filter((q) => q.review_status === "needs_review").length,
    license_note:
      "公开题目沿用来源许可；原创强化题按其题组说明使用。本项目保留逐组来源信息，仅用于个人学习。",
  },
  sources: packages.map((pkg) => pkg.source),
  questions: allQuestions,
};

const json = `${JSON.stringify(exported, null, 2)}\n`;
await writeFile(join(exportsDir, "questions.json"), json, "utf8");
await writeFile(
  join(exportsDir, "questions.sha256"),
  `${createHash("sha256").update(json).digest("hex")}  questions.json\n`,
  "utf8",
);

const db = new DatabaseSync(sqlitePath);
db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
DROP TABLE IF EXISTS options;
DROP TABLE IF EXISTS questions;
DROP TABLE IF EXISTS sources;
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  exam_date TEXT NOT NULL,
  job_track TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  license TEXT NOT NULL,
  advertised_choice_count INTEGER NOT NULL,
  parsed_choice_count INTEGER NOT NULL,
  source_completeness TEXT NOT NULL,
  collected_at TEXT NOT NULL
);
CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_number INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('single', 'multiple')),
  stem TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  topic TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  is_calculation INTEGER NOT NULL CHECK(is_calculation IN (0, 1)),
  prompt_formulas_json TEXT NOT NULL,
  solution_formulas_json TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK(review_status IN ('usable', 'needs_review')),
  review_note TEXT NOT NULL DEFAULT '',
  UNIQUE(source_id, source_number)
);
CREATE TABLE options (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(question_id, label)
);
CREATE INDEX idx_questions_source ON questions(source_id, source_number);
CREATE INDEX idx_questions_topic ON questions(topic);
CREATE INDEX idx_questions_review ON questions(review_status);
CREATE INDEX idx_questions_calculation ON questions(is_calculation) WHERE is_calculation = 1;
`);

const insertSource = db.prepare(`
  INSERT INTO sources (
    id, exam_date, job_track, url, license, advertised_choice_count,
    parsed_choice_count, source_completeness, collected_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertQuestion = db.prepare(`
  INSERT INTO questions (
    id, source_id, source_number, type, stem, answer_json, explanation,
    topic, difficulty, is_calculation, prompt_formulas_json,
    solution_formulas_json, review_status, review_note
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertOption = db.prepare(`
  INSERT INTO options (question_id, label, text, position) VALUES (?, ?, ?, ?)
`);

db.exec("BEGIN IMMEDIATE");
try {
  for (const pkg of packages) {
    const source = pkg.source;
    insertSource.run(
      source.id,
      source.exam_date,
      source.job_track,
      source.url,
      source.license,
      source.advertised_choice_count,
      source.parsed_choice_count,
      source.source_completeness,
      source.collected_at,
    );
  }
  for (const question of allQuestions) {
    insertQuestion.run(
      question.id,
      question.source_id,
      question.source_number,
      question.type,
      question.stem,
      JSON.stringify(question.answer),
      question.explanation,
      question.topic,
      question.difficulty,
      question.is_calculation ? 1 : 0,
      JSON.stringify(question.prompt_formulas),
      JSON.stringify(question.solution_formulas),
      question.review_status,
      question.review_note,
    );
    question.options.forEach((option, index) => {
      insertOption.run(question.id, option.label, option.text, index);
    });
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
db.exec("PRAGMA optimize");

const coverage = packages.map((pkg) => ({
  id: pkg.source.id,
  exam_date: pkg.source.exam_date,
  advertised: pkg.source.advertised_choice_count,
  parsed: pkg.source.parsed_choice_count,
  usable: pkg.questions.filter((q) => q.review_status === "usable").length,
  needs_review: pkg.questions.filter((q) => q.review_status === "needs_review").length,
  completeness: pkg.source.source_completeness,
  source_numbers: pkg.questions.filter((q) => !q.error).map((q) => q.source_number),
  url: pkg.source.url,
}));

await writeFile(
  join(exportsDir, "coverage-report.json"),
  `${JSON.stringify({ totals: exported.metadata, sources: coverage }, null, 2)}\n`,
  "utf8",
);

const table = coverage
  .map(
    (row) =>
      `| ${row.exam_date} | ${row.advertised} | ${row.parsed} | ${row.usable} | ${row.needs_review} | ${row.completeness} |`,
  )
  .join("\n");
const report = `# 题库覆盖报告

采集日期：2026-08-12

| 题组 | 计划题数 | 实际收录 | 默认可练 | 待复核 | 完整性 |
|---|---:|---:|---:|---:|---|
${table}

总计：${allQuestions.length} 道选择题；${exported.metadata.usable_count} 道进入默认练习池；${exported.metadata.needs_review_count} 道保留但默认排除。

说明：2026-04-08 页面只公开题号 1、2、4、6、10、12 六道精选，因此标记为 excerpt，没有补造缺失题目。
`;
await writeFile(join(exportsDir, "coverage-report.md"), report, "utf8");

console.log(
  JSON.stringify(
    {
      sources: packages.length,
      questions: allQuestions.length,
      usable: exported.metadata.usable_count,
      needsReview: exported.metadata.needs_review_count,
      sqlitePath,
    },
    null,
    2,
  ),
);
