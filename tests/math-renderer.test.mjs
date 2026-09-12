import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(PROJECT_ROOT, "dashboard", "app.js"), "utf8");

function loadRenderer(katex) {
  const sandbox = { console, globalThis: null };
  sandbox.globalThis = sandbox;
  if (katex) sandbox.katex = katex;
  runInNewContext(source, sandbox, { filename: "dashboard/app.js" });
  return sandbox.AITheoryMath;
}

test("fallback renderer hides markdown and TeX commands", () => {
  const math = loadRenderer();
  const result = math.renderRichText("**$IG=H(Y)-H(Y\\mid X)$** 与 $Q^TQ=I$");
  assert.match(result, /<strong>/);
  assert.match(result, /IG=H\(Y\)-H\(Y∣ X\)/);
  assert.match(result, /Q<sup>T<\/sup>Q=I/);
  assert.doesNotMatch(result, /\*\*|\\mid|\$IG/);
});

test("renderer repairs legacy formulas without math delimiters", () => {
  const math = loadRenderer();
  for (const source of ["**IG=H(Y)-H(Y\\mid X)", "IG=H(Y)-H(Y\\mid X)"]) {
    const result = math.renderRichText(source);
    assert.match(result, /IG=H\(Y\)-H\(Y∣ X\)/);
    assert.doesNotMatch(result, /\*\*|\\mid/);
  }
});

test("renderer supports all local math delimiters and complete formula extraction", () => {
  const math = loadRenderer();
  const result = math.renderRichText("行内 \\(a\\mid b\\)；展示 \\[x=\\frac{1}{2}\\]；普通 $y=2$");
  assert.equal((result.match(/math-/g) ?? []).length >= 3, true);
  assert.doesNotMatch(result, /\\\(|\\\)|\\\[|\\\]|\\frac|\\mid/);

  const entries = math.formulaEntries(["说明 \\(a=1\\)，再看 \\[b=2\\] 和 $c=3$", "纯文本公式说明"]);
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    { text: "说明 \\(a=1\\)，再看 \\[b=2\\] 和 $c=3$" },
    { text: "纯文本公式说明" },
  ]);
});

test("KaTeX renderer receives the raw information-gain formula", () => {
  const calls = [];
  const math = loadRenderer({
    renderToString(value, options) {
      calls.push({ value, options });
      return `<span class="katex">${value.replaceAll("\\mid", "∣")}</span>`;
    },
  });
  const result = math.renderRichText("$IG=H(Y)-H(Y\\mid X)$");
  assert.match(result, /class="katex"/);
  assert.equal(calls[0].value, "IG=H(Y)-H(Y\\mid X)");
  assert.equal(calls[0].options.throwOnError, true);
});

test("every delimited expression in the question bank parses with bundled KaTeX", () => {
  const katexSource = readFileSync(join(PROJECT_ROOT, "dashboard", "vendor", "katex", "katex.min.js"), "utf8");
  const sandbox = { console, globalThis: null };
  sandbox.globalThis = sandbox;
  runInNewContext(katexSource, sandbox, { filename: "dashboard/vendor/katex/katex.min.js" });
  const math = loadRenderer(sandbox.katex);
  const exportRoot = JSON.parse(readFileSync(join(PROJECT_ROOT, "database", "exports", "questions.json"), "utf8"));
  const failures = [];
  let expressionCount = 0;

  for (const question of exportRoot.questions) {
    const values = [
      question.stem,
      ...question.options.map((option) => option.text),
      question.explanation,
      ...question.prompt_formulas,
      ...question.solution_formulas,
    ];
    for (const value of values) {
      for (const token of math.flattenedTokens(value)) {
        if (token.type !== "inline-math" && token.type !== "display-math") continue;
        expressionCount += 1;
        try {
          sandbox.katex.renderToString(math.normalizeMathSource(token.value), {
            displayMode: token.type === "display-math",
            throwOnError: true,
            strict: "ignore",
            trust: false,
          });
        } catch (error) {
          failures.push({ id: question.id, expression: token.value, message: error.message });
        }
      }
    }
  }

  assert.equal(expressionCount > 2000, true);
  assert.deepEqual(failures, []);
});

test("formula hints include bold and legacy expressions from each source field", () => {
  const math = loadRenderer();
  const combined = math.combinedFormulaEntries([], [
    "提示 **$x=1$** 和 **\\(y=2\\)**",
    "IG=H(Y)-H(Y\\mid X)",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(math.formulaEntries(combined))), [
    { math: "x=1", display: false },
    { math: "y=2", display: false },
    { math: "IG=H(Y)-H(Y\\mid X)", display: false },
  ]);
});

test("hints preserve descriptions and deduplicate equivalent TeX spellings", () => {
  const math = loadRenderer();
  const combined = math.combinedFormulaEntries([
    "条件 **$x = 1$**，单位为米。", "\\[y = \\left(a+b\\right)\\]",
  ], ["$x=1$", "**$y=(a+b)$**", "$z=3$"]);
  assert.deepEqual(JSON.parse(JSON.stringify(math.formulaEntries(combined))), [
    { text: "条件 **$x = 1$**，单位为米。" },
    { math: "y = \\left(a+b\\right)", display: true },
    { math: "z=3", display: false },
  ]);
  assert.notEqual(math.formulaKey("\\alpha x"), math.formulaKey("\\alphax"));
  assert.notEqual(math.formulaKey("\\text{a b}"), math.formulaKey("\\text{ab}"));
  assert.notEqual(math.formulaKey("x\\leftarrow y"), math.formulaKey("x y"));
});

test("escaped currency and multiline parentheses do not corrupt formulas", () => {
  const math = loadRenderer();
  const tokens = math.flattenedTokens("价格 \\$5 与 \\$10；$x=2$；\\(a=\nb\\)");
  assert.deepEqual(JSON.parse(JSON.stringify(tokens.filter(token => token.type === "inline-math").map(token => token.value))), ["x=2", "a=\nb"]);
  assert.equal(math.normalizeMathSource("$x=2$"), "x=2");
  assert.equal(math.normalizeMathSource("$$x=2$$"), "x=2");
  assert.equal(math.normalizeMathSource("$x=2"), "$x=2");
});

test("rendering failure preserves unsupported math instead of deleting operators", () => {
  const math = loadRenderer({ renderToString() { throw new Error("parse failed"); } });
  const result = math.renderRichText("$\\int_0^1 x dx$");
  assert.match(result, /\\int_0\^1 x dx/);
  assert.match(result, /显示原始公式/);
  assert.doesNotMatch(math.renderRichText("$x\\leftarrow y$"), /arrow|\\leftarrow/);
  assert.doesNotMatch(math.renderRichText('<img src=x onerror="alert(1)">'), /<img/);
});

test("all question-bank expressions reach their prompt or solution hint section", () => {
  const math = loadRenderer();
  const { questions } = JSON.parse(readFileSync(join(PROJECT_ROOT, "database", "exports", "questions.json"), "utf8"));
  for (const question of questions) {
    for (const [primary, supporting] of [
      [question.prompt_formulas, [question.stem, ...question.options.map(option => option.text)]],
      [question.solution_formulas, [question.explanation]],
    ]) {
      const entries = math.formulaEntries(math.combinedFormulaEntries(primary, supporting));
      const keys = entries.flatMap(entry => entry.math != null
        ? [math.formulaKey(entry.math)]
        : math.flattenedTokens(entry.text).filter(token => /math$/.test(token.type)).map(token => math.formulaKey(token.value)));
      for (const text of [...primary, ...supporting]) {
        for (const token of math.flattenedTokens(text).filter(token => /math$/.test(token.type))) {
          assert.ok(keys.includes(math.formulaKey(token.value)), `${question.id}: missing ${token.value}`);
        }
      }
      const standaloneKeys = entries.filter(entry => entry.math != null).map(entry => math.formulaKey(entry.math));
      assert.equal(new Set(standaloneKeys).size, standaloneKeys.length, question.id);
    }
  }
});
