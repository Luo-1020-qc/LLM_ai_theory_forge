import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const databaseDir = resolve(import.meta.dirname);
const exportRoot = JSON.parse(await readFile(resolve(databaseDir, "exports", "questions.json"), "utf8"));
const questions = exportRoot.questions;
const mathPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|\$([^$\n]+?)\$/g;

function mathExpressions(value) {
  const expressions = [];
  String(value ?? "").replace(mathPattern, (_match, displayDollar, displayBracket, inlineParen, inlineDollar) => {
    expressions.push(displayDollar ?? displayBracket ?? inlineParen ?? inlineDollar);
    return _match;
  });
  return expressions;
}

function normalized(value) {
  return String(value ?? "").replace(/\s+/g, "").replace(/\\(?:left|right)/g, "");
}

function missingFromFields(text, fields) {
  const available = normalized((Array.isArray(fields) ? fields : []).join("\n"));
  return mathExpressions(text).filter((expression) => !available.includes(normalized(expression)));
}

const brokenDelimiters = [];
const promptGaps = [];
const solutionGaps = [];
for (const question of questions) {
  const searchable = [question.stem, ...question.options.map((option) => option.text)].join("\n");
  const promptMissing = missingFromFields(searchable, question.prompt_formulas);
  const solutionMissing = missingFromFields(question.explanation, question.solution_formulas);
  if (promptMissing.length) promptGaps.push({ id: question.id, expressions: promptMissing });
  if (solutionMissing.length) solutionGaps.push({ id: question.id, expressions: solutionMissing });

  const texts = [
    question.stem,
    ...question.options.map((option) => option.text),
    question.explanation,
    ...question.prompt_formulas,
    ...question.solution_formulas,
  ];
  for (const text of texts) {
    const source = String(text ?? "");
    const dollars = (source.match(/(?<!\\)\$/g) ?? []).length;
    const displayOpen = (source.match(/\\\[/g) ?? []).length;
    const displayClose = (source.match(/\\\]/g) ?? []).length;
    const inlineOpen = (source.match(/\\\(/g) ?? []).length;
    const inlineClose = (source.match(/\\\)/g) ?? []).length;
    if (
      dollars % 2 !== 0 ||
      (source.match(/\*\*/g) ?? []).length % 2 !== 0 ||
      displayOpen !== displayClose ||
      inlineOpen !== inlineClose
    ) {
      brokenDelimiters.push({ id: question.id, source });
    }
  }
}

assert.deepEqual(brokenDelimiters, [], "题库中存在未闭合的数学或粗体定界符");

console.log(JSON.stringify({
  questions: questions.length,
  formulaEntries: questions.reduce((count, question) => count + question.prompt_formulas.length + question.solution_formulas.length, 0),
  promptBodiesMerged: promptGaps.length,
  solutionBodiesMerged: solutionGaps.length,
  note: "看板会把题干/选项与讲解中的公式分别合并到公式提示区，因此字段差异不会再造成漏显示。",
  promptSamples: promptGaps.slice(0, 5).map((item) => item.id),
  solutionSamples: solutionGaps.slice(0, 5).map((item) => item.id),
}, null, 2));
