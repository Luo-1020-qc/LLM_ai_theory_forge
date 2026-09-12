import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUESTION_DB = join(PROJECT_ROOT, "database", "ai_question_bank.sqlite3");

async function json(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function waitForAddress(child) {
  return new Promise((resolveAddress, rejectAddress) => {
    let output = "";
    const timer = setTimeout(() => rejectAddress(new Error(`服务器启动超时：${output}`)), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/访问地址：(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveAddress(match[1]);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectAddress(new Error(`服务器提前退出（${code}）：${output}`));
    });
  });
}

function answerFor(database, questionId) {
  const row = database.prepare("SELECT answer_json FROM questions WHERE id = ?").get(questionId);
  return JSON.parse(row.answer_json);
}

test("local server supports a complete ten-question practice round", { timeout: 30_000 }, async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-theory-forge-"));
  const practiceDb = join(temporaryDirectory, "practice.sqlite3");
  const child = spawn(
    process.execPath,
    [
      "local_server.mjs",
      "--no-browser",
      "--port",
      String(randomInt(20_000, 50_000)),
      "--practice-db",
      practiceDb,
    ],
    { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const questionDatabase = new DatabaseSync(QUESTION_DB, { readOnly: true });

  try {
    const baseUrl = await waitForAddress(child);
    const health = await json(`${baseUrl}/api/health`);
    assert.deepEqual(health, { ok: true, questionCount: 366 });

    const pageResponse = await fetch(`${baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-type") ?? "", /^text\/html\b/i);
    const page = await pageResponse.text();
    assert.match(page, /AI Theory Forge/);
    assert.match(page, /href="\/vendor\/katex\/katex\.min\.css"/);
    assert.match(page, /src="\/vendor\/katex\/katex\.min\.js"/);
    assert.match(page, /href="\/styles\.css"/);
    assert.match(page, /src="\/app\.js"/);

    const clientResponse = await fetch(`${baseUrl}/app.js`);
    assert.equal(clientResponse.status, 200);
    const client = await clientResponse.text();
    assert.match(client, /每十题/);
    assert.match(client, /function tokenizeRichText/);
    assert.match(client, /function combinedFormulaEntries/);
    assert.match(client, /function renderRichText/);

    const katexResponse = await fetch(`${baseUrl}/vendor/katex/katex.min.js`);
    assert.equal(katexResponse.status, 200);
    assert.match(katexResponse.headers.get("content-type") ?? "", /^text\/javascript\b/i);
    assert.ok((await katexResponse.arrayBuffer()).byteLength > 200_000);

    const katexCssResponse = await fetch(`${baseUrl}/vendor/katex/katex.min.css`);
    assert.equal(katexCssResponse.status, 200);
    assert.match(await katexCssResponse.text(), /KaTeX_Main-Regular\.woff2/);

    const katexFontResponse = await fetch(`${baseUrl}/vendor/katex/fonts/KaTeX_Main-Regular.woff2`);
    assert.equal(katexFontResponse.status, 200);
    assert.equal(katexFontResponse.headers.get("content-type"), "font/woff2");
    assert.ok((await katexFontResponse.arrayBuffer()).byteLength > 20_000);

    const stylesResponse = await fetch(`${baseUrl}/styles.css`);
    assert.equal(stylesResponse.status, 200);
    const styles = await stylesResponse.text();
    assert.match(styles, /\.math-inline/);
    assert.match(styles, /Cambria Math/);

    const catalog = await json(`${baseUrl}/api/catalog`);
    assert.equal(catalog.metadata.usable_count, 360);
    assert.equal(catalog.sources.length, 19);
    const reinforcementBank = catalog.sources.find((source) => source.id === "AIFORGE-S01");
    assert.equal(reinforcementBank.parsed_choice_count, 20);
    assert.equal(JSON.stringify(catalog).match(new RegExp(`${String.fromCharCode(21326, 20026)}|hua${"wei"}`, "gi")), null);

    const formulaQuestion = await json(`${baseUrl}/api/quiz/start`, {
      method: "POST",
      body: JSON.stringify({ count: 10, mode: "random", topic: "机器学习—决策树/信息增益" }),
    });
    assert.equal(formulaQuestion.question.id, "AIFORGE-S01-Q010");
    assert.deepEqual(formulaQuestion.question.prompt_formulas, [
      "$H(Y)=-\\sum_k p_k\\log_2p_k$",
      "$IG=H(Y)-H(Y\\mid X)$",
    ]);

    const started = await json(`${baseUrl}/api/quiz/start`, {
      method: "POST",
      body: JSON.stringify({ count: 10, mode: "random" }),
    });
    assert.equal(started.session.total, 10);
    assert.equal("answer" in started.question, false, "出题响应不得泄露答案");
    assert.match(started.question.id, /^(?:AIEXAM-|AIFORGE-)/);

    let question = started.question;
    let lastAnswer;
    let wrongQuestionId;
    for (let index = 0; index < 10; index += 1) {
      const answer = answerFor(questionDatabase, question.id);
      let selected = answer;
      if (index === 0) {
        wrongQuestionId = question.id;
        selected = answer.length > 1
          ? [answer[0]]
          : [question.options.find((option) => option.label !== answer[0]).label];
      }
      lastAnswer = await json(`${baseUrl}/api/quiz/answer`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: started.session.id,
          questionId: question.id,
          selected,
        }),
      });
      if (index < 9) {
        assert.equal(lastAnswer.roundSummary, null);
        question = lastAnswer.nextQuestion;
      }
    }

    assert.equal(lastAnswer.session.completed, true);
    assert.equal(lastAnswer.session.correct, 9);
    assert.equal(lastAnswer.session.accuracy, 90);
    assert.equal(lastAnswer.roundSummary.correct, 9);
    assert.deepEqual(lastAnswer.roundSummary.mistakeIds, [wrongQuestionId]);

    const active = await json(`${baseUrl}/api/mistakes?status=active`);
    assert.equal(active.mistakes.length, 1);
    assert.equal(active.mistakes[0].id, wrongQuestionId);

    const review = await json(`${baseUrl}/api/quiz/start`, {
      method: "POST",
      body: JSON.stringify({ count: 10, mode: "mistakes" }),
    });
    assert.equal(review.session.total, 1);
    assert.equal(review.question.id, wrongQuestionId);
    const reviewed = await json(`${baseUrl}/api/quiz/answer`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: review.session.id,
        questionId: review.question.id,
        selected: answerFor(questionDatabase, review.question.id),
      }),
    });
    assert.equal(reviewed.feedback.correct, true);
    assert.equal(reviewed.session.completed, true);
    const activeAfterReview = await json(`${baseUrl}/api/mistakes?status=active`);
    assert.equal(activeAfterReview.mistakes[0].correctReviewCount, 1);

    await json(`${baseUrl}/api/mistakes`, {
      method: "POST",
      body: JSON.stringify({ questionId: wrongQuestionId, status: "mastered" }),
    });
    const mastered = await json(`${baseUrl}/api/mistakes?status=mastered`);
    assert.equal(mastered.mistakes[0].id, wrongQuestionId);

    const stats = await json(`${baseUrl}/api/stats`);
    assert.equal(stats.totals.attempts, 11);
    assert.equal(stats.totals.correct, 10);
    assert.equal(stats.totals.sessions, 3);
    assert.equal(stats.rounds.length, 1);

    const cssResponse = await fetch(`${baseUrl}/styles.css`);
    assert.equal(cssResponse.status, 200);
    const css = await cssResponse.text();
    assert.equal(css.includes('@import "tailwindcss"'), false);
  } finally {
    questionDatabase.close();
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", resolveExit);
    });
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
