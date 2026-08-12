import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const databaseDir = resolve(import.meta.dirname);
const curatedDir = join(databaseDir, "curated");
const files = (await readdir(curatedDir)).filter((name) => /^ai-\d{8}\.json$/.test(name));
const packages = await Promise.all(
  files.map(async (file) => JSON.parse(await readFile(join(curatedDir, file), "utf8"))),
);

const target = packages.find((pkg) => pkg.source.id === "AIFORGE-S01");
assert.ok(target, "未找到 AIFORGE-S01");
assert.equal(target.questions.length, 20, "强化题库应恰好包含 20 题");
assert.equal(target.questions.filter((question) => question.type === "single").length, 10);
assert.equal(target.questions.filter((question) => question.type === "multiple").length, 10);
assert.equal(target.questions.filter((question) => question.is_calculation).length, 10);

function normalized(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function features(text) {
  const compact = normalized(text);
  const result = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    result.add(compact.slice(index, index + 2));
  }
  return result;
}

function jaccard(leftText, rightText) {
  const left = features(leftText);
  const right = features(rightText);
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

const existing = packages
  .filter((pkg) => pkg.source.id !== target.source.id)
  .flatMap((pkg) => pkg.questions.filter((question) => !question.error));
const existingNormalized = new Set(existing.map((question) => normalized(question.stem)));
const targetIds = new Set();
const targetStems = new Set();

for (const question of target.questions) {
  assert.match(question.id, /^AIFORGE-S01-Q\d{3}$/);
  assert.equal(targetIds.has(question.id), false, `${question.id}: ID 重复`);
  targetIds.add(question.id);
  const stem = normalized(question.stem);
  assert.equal(targetStems.has(stem), false, `${question.id}: 新题库内部题干重复`);
  targetStems.add(stem);
  assert.equal(existingNormalized.has(stem), false, `${question.id}: 与旧题库题干完全重复`);
  assert.ok(question.explanation.length >= 70, `${question.id}: 讲解过短`);
  assert.equal(question.review_status, "usable", `${question.id}: 未进入练习池`);
  if (question.is_calculation) {
    assert.ok(question.prompt_formulas.length > 0, `${question.id}: 计算题缺少题面公式`);
    assert.ok(question.solution_formulas.length > 0, `${question.id}: 计算题缺少解题公式`);
  }
}

const closestPairs = target.questions
  .map((question) => {
    const matches = existing.map((candidate) => ({
      id: candidate.id,
      score: jaccard(question.stem, candidate.stem),
    }));
    matches.sort((left, right) => right.score - left.score);
    return { id: question.id, nearest: matches[0].id, score: matches[0].score };
  })
  .sort((left, right) => right.score - left.score);

assert.ok(closestPairs[0].score < 0.72, `疑似近重复：${JSON.stringify(closestPairs[0])}`);

const singleAnswerDistribution = Object.fromEntries(
  ["A", "B", "C", "D"].map((label) => [
    label,
    target.questions.filter((question) => question.type === "single" && question.answer[0] === label).length,
  ]),
);
assert.ok(Object.values(singleAnswerDistribution).every((count) => count > 0), "单选正确答案位置分布不完整");

console.log(JSON.stringify({
  source: target.source.id,
  questions: target.questions.length,
  single: 10,
  multiple: 10,
  calculations: 10,
  singleAnswerDistribution,
  highestSimilarity: Number(closestPairs[0].score.toFixed(3)),
  closestPairs: closestPairs.slice(0, 5).map((pair) => ({
    ...pair,
    score: Number(pair.score.toFixed(3)),
  })),
}, null, 2));
