#!/usr/bin/env node

/**
 * AI Theory Forge - local-only server.
 *
 * Runtime dependencies: Node.js 24 standard library only.
 * The question bank is read-only; practice progress is stored in a separate
 * SQLite database so rebuilding the question bank never removes user history.
 */

import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const LOCAL_WEB_ROOT = join(PROJECT_ROOT, "dashboard");
const GLOBAL_STYLES_PATH = join(LOCAL_WEB_ROOT, "styles.css");
const DEFAULT_QUESTION_DB = join(PROJECT_ROOT, "database", "ai_question_bank.sqlite3");
const DEFAULT_PRACTICE_DB = join(PROJECT_ROOT, "database", "ai_practice.sqlite3");
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1_000_000;
const PORT_ATTEMPTS = 30;
const FALLBACK_TOPIC = "综合基础";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const PRACTICE_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS practice_sessions (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('random', 'mistakes')),
    question_ids_json TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL,
    correct_count INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    max_streak INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    selected_json TEXT NOT NULL,
    correct INTEGER NOT NULL CHECK(correct IN (0, 1)),
    score INTEGER NOT NULL,
    answered_at TEXT NOT NULL,
    UNIQUE(session_id, question_id)
  );

  CREATE TABLE IF NOT EXISTS mistakes (
    question_id TEXT PRIMARY KEY,
    first_wrong_at TEXT NOT NULL,
    last_wrong_at TEXT NOT NULL,
    wrong_count INTEGER NOT NULL DEFAULT 1,
    correct_review_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'mastered'))
  );

  CREATE TABLE IF NOT EXISTS round_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    start_position INTEGER NOT NULL,
    end_position INTEGER NOT NULL,
    correct_count INTEGER NOT NULL,
    question_ids_json TEXT NOT NULL,
    mistake_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, round_number)
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_session_position
    ON attempts(session_id, position);
  CREATE INDEX IF NOT EXISTS idx_attempts_question
    ON attempts(question_id);
  CREATE INDEX IF NOT EXISTS idx_mistakes_status_wrong
    ON mistakes(status, wrong_count DESC);
  CREATE INDEX IF NOT EXISTS idx_round_session
    ON round_summaries(session_id, round_number);
`;

function printHelp() {
  console.log(`
AI Theory Forge · 本地服务器

用法：
  node local_server.mjs [选项]

选项：
  --port <端口>          首选端口（默认 ${DEFAULT_PORT}；占用时自动尝试后续端口）
  --no-browser           启动后不自动打开浏览器
  --practice-db <路径>   练习记录数据库路径
  --question-db <路径>   只读题库数据库路径
  -h, --help             显示帮助
`);
}

function parseArguments(argv) {
  const options = {
    port: DEFAULT_PORT,
    noBrowser: false,
    practiceDb: DEFAULT_PRACTICE_DB,
    questionDb: DEFAULT_QUESTION_DB,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-browser") {
      options.noBrowser = true;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }

    const equalIndex = argument.indexOf("=");
    const name = equalIndex >= 0 ? argument.slice(0, equalIndex) : argument;
    let value = equalIndex >= 0 ? argument.slice(equalIndex + 1) : null;
    if (["--port", "--practice-db", "--question-db"].includes(name)) {
      if (value === null) {
        index += 1;
        value = argv[index];
      }
      if (!value) throw new Error(`参数 ${name} 缺少值。`);
      if (name === "--port") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          throw new Error(`端口必须是 1–65535 之间的整数，收到：${value}`);
        }
        options.port = parsed;
      } else if (name === "--practice-db") {
        options.practiceDb = resolve(value);
      } else {
        options.questionDb = resolve(value);
      }
      continue;
    }
    throw new Error(`未知参数：${argument}。使用 --help 查看可用选项。`);
  }
  return options;
}

function parseJson(value, fallback = []) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function roundOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

function normalizeTopic(value) {
  return typeof value === "string" && value.trim() ? value.trim() : FALLBACK_TOPIC;
}

function loadQuestionBank(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error(`找不到题库数据库：${databasePath}`);
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;");

  const requiredTables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sources', 'questions', 'options')")
    .all();
  if (requiredTables.length !== 3) {
    database.close();
    throw new Error("题库数据库结构不完整，需要 sources、questions 和 options 三张表。");
  }

  const sourceRows = database
    .prepare("SELECT * FROM sources ORDER BY exam_date")
    .all()
    .map((row) => ({ ...row }));
  const optionsByQuestion = new Map();
  for (const row of database
    .prepare("SELECT question_id, label, text FROM options ORDER BY question_id, position")
    .all()) {
    const list = optionsByQuestion.get(row.question_id) ?? [];
    list.push({ label: row.label, text: row.text });
    optionsByQuestion.set(row.question_id, list);
  }

  const questions = database
    .prepare(`
      SELECT q.*, s.exam_date, s.job_track, s.url AS source_url
      FROM questions q
      JOIN sources s ON s.id = q.source_id
      ORDER BY s.exam_date, q.source_number
    `)
    .all()
    .map((row) => ({
      id: row.id,
      source_number: Number(row.source_number),
      type: row.type,
      stem: row.stem,
      options: optionsByQuestion.get(row.id) ?? [],
      answer: parseJson(row.answer_json),
      explanation: row.explanation,
      topic: normalizeTopic(row.topic),
      difficulty: row.difficulty,
      is_calculation: Boolean(row.is_calculation),
      prompt_formulas: parseJson(row.prompt_formulas_json),
      solution_formulas: parseJson(row.solution_formulas_json),
      review_status: row.review_status,
      review_note: row.review_note,
      source_id: row.source_id,
      exam_date: row.exam_date,
      job_track: row.job_track,
      source_url: row.source_url,
    }));

  database.close();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const topics = new Map();
  for (const question of questions) {
    topics.set(question.topic, (topics.get(question.topic) ?? 0) + 1);
  }

  const usableCount = questions.filter((question) => question.review_status === "usable").length;
  const dates = sourceRows.map((source) => source.collected_at).filter(Boolean).sort();
  const catalog = {
    metadata: {
      title: "互联网公司 AI 大模型基础理论试题题库",
      collected_at: dates.at(-1) ?? "",
      source_count: sourceRows.length,
      question_count: questions.length,
      usable_count: usableCount,
      needs_review_count: questions.length - usableCount,
      license_note: "题目保留逐场来源链接，仅用于个人学习；使用时请遵守来源许可。",
    },
    sources: sourceRows,
    topics: [...topics.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN")),
  };

  return { questions, questionById, catalog };
}

function openPracticeDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(PRACTICE_SCHEMA);
  database.exec("PRAGMA optimize;");
  return database;
}

function publicQuestion(question) {
  if (!question) return null;
  const {
    answer: _answer,
    explanation: _explanation,
    solution_formulas: _solutionFormulas,
    review_note: _reviewNote,
    ...safe
  } = question;
  return safe;
}

function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function sameAnswer(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sessionPayload(row, activeMistakes = 0, available = undefined) {
  const answered = Number(row.current_index);
  const correct = Number(row.correct_count);
  const payload = {
    id: row.id,
    mode: row.mode,
    total: Number(row.total_count),
    answered,
    correct,
    score: Number(row.score),
    streak: Number(row.streak),
    maxStreak: Number(row.max_streak),
    accuracy: answered ? roundOneDecimal((correct / answered) * 100) : 0,
    wrongCount: Number(activeMistakes),
    completed: Boolean(row.completed_at),
  };
  if (available !== undefined) payload.available = available;
  return payload;
}

function jsonResponse(response, status, payload, extraHeaders = {}) {
  const content = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(content);
}

function emptyResponse(response, status, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求内容过大。");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求正文不是有效的 JSON。");
    error.statusCode = 400;
    throw error;
  }
}

function activeMistakeCount(database) {
  return Number(
    database.prepare("SELECT COUNT(*) AS count FROM mistakes WHERE status = 'active'").get().count,
  );
}

function createApi({ bank, practiceDatabase }) {
  const selectSession = practiceDatabase.prepare("SELECT * FROM practice_sessions WHERE id = ?");
  const selectDuplicateAttempt = practiceDatabase.prepare(
    "SELECT id FROM attempts WHERE session_id = ? AND question_id = ?",
  );

  function getCatalog(_request, response) {
    jsonResponse(response, 200, bank.catalog);
  }

  function getHealth(_request, response) {
    jsonResponse(response, 200, { ok: true, questionCount: bank.questions.length });
  }

  async function startQuiz(request, response) {
    const payload = await readJsonBody(request);
    const mode = payload.mode === "mistakes" ? "mistakes" : "random";
    const topic = typeof payload.topic === "string" ? payload.topic.trim() : "";
    const examDate = typeof payload.examDate === "string" ? payload.examDate.trim() : "";
    let pool = bank.questions.filter(
      (question) =>
        question.review_status === "usable" &&
        (!topic || question.topic === topic) &&
        (!examDate || question.exam_date === examDate),
    );

    if (mode === "mistakes") {
      const mistakeIds = new Set(
        practiceDatabase
          .prepare("SELECT question_id FROM mistakes WHERE status = 'active'")
          .all()
          .map((row) => row.question_id),
      );
      pool = pool.filter((question) => mistakeIds.has(question.id));
    }

    if (!pool.length) {
      jsonResponse(response, 400, {
        error: mode === "mistakes" ? "当前筛选条件下错题库为空。" : "当前筛选条件没有可练题目。",
      });
      return;
    }

    const rawCount = Number(payload.count ?? 20);
    const requested = Number.isFinite(rawCount) ? Math.trunc(rawCount) : 20;
    const count = Math.min(Math.max(1, requested), pool.length);
    const selected = shuffled(pool).slice(0, count);
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    practiceDatabase
      .prepare(`
        INSERT INTO practice_sessions (
          id, mode, question_ids_json, current_index, total_count,
          correct_count, score, streak, max_streak, started_at
        ) VALUES (?, ?, ?, 0, ?, 0, 0, 0, 0, ?)
      `)
      .run(sessionId, mode, JSON.stringify(selected.map((question) => question.id)), count, now);

    jsonResponse(response, 200, {
      session: {
        id: sessionId,
        mode,
        total: count,
        available: pool.length,
        answered: 0,
        correct: 0,
        score: 0,
        streak: 0,
        maxStreak: 0,
        wrongCount: activeMistakeCount(practiceDatabase),
        accuracy: 0,
        completed: false,
      },
      question: publicQuestion(selected[0]),
    });
  }

  function getSession(request, response, url) {
    const sessionId = url.searchParams.get("id")?.trim();
    if (!sessionId) {
      jsonResponse(response, 400, { error: "缺少会话编号。" });
      return;
    }
    const row = selectSession.get(sessionId);
    if (!row) {
      jsonResponse(response, 404, { error: "练习会话不存在。" });
      return;
    }
    const ids = parseJson(row.question_ids_json);
    const question = row.current_index < ids.length ? bank.questionById.get(ids[row.current_index]) : null;
    jsonResponse(response, 200, {
      session: sessionPayload(row, activeMistakeCount(practiceDatabase)),
      question: publicQuestion(question),
    });
  }

  async function answerQuiz(request, response) {
    const payload = await readJsonBody(request);
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const questionId = typeof payload.questionId === "string" ? payload.questionId.trim() : "";
    const rawSelected = Array.isArray(payload.selected) ? payload.selected : [];
    const selected = [
      ...new Set(
        rawSelected
          .filter((item) => typeof item === "string")
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (!sessionId || !questionId || !selected.length) {
      jsonResponse(response, 400, { error: "请选择答案后再提交。" });
      return;
    }

    let result;
    practiceDatabase.exec("BEGIN IMMEDIATE");
    try {
      const session = selectSession.get(sessionId);
      if (!session) {
        const error = new Error("练习会话不存在。");
        error.statusCode = 404;
        throw error;
      }
      const ids = parseJson(session.question_ids_json);
      const expectedId = ids[session.current_index];
      if (!expectedId || expectedId !== questionId) {
        const error = new Error("题目进度已变化，请刷新后继续。");
        error.statusCode = 409;
        throw error;
      }

      const question = bank.questionById.get(questionId);
      if (!question) {
        const error = new Error("题目不存在。");
        error.statusCode = 404;
        throw error;
      }
      const allowed = new Set(question.options.map((option) => option.label));
      if (selected.some((label) => !allowed.has(label))) {
        const error = new Error("提交中包含无效选项。");
        error.statusCode = 400;
        throw error;
      }
      if (question.type === "single" && selected.length !== 1) {
        const error = new Error("单选题只能选择一个选项。");
        error.statusCode = 400;
        throw error;
      }
      if (selectDuplicateAttempt.get(sessionId, questionId)) {
        const error = new Error("本题已经提交过。");
        error.statusCode = 409;
        throw error;
      }

      const correct = sameAnswer(selected, question.answer);
      const now = new Date().toISOString();
      const nextIndex = Number(session.current_index) + 1;
      const correctCount = Number(session.correct_count) + (correct ? 1 : 0);
      const score = Number(session.score) + (correct ? 1 : 0);
      const streak = correct ? Number(session.streak) + 1 : 0;
      const maxStreak = Math.max(Number(session.max_streak), streak);
      const completed = nextIndex >= Number(session.total_count);

      practiceDatabase
        .prepare(`
          INSERT INTO attempts (
            id, session_id, question_id, position, selected_json,
            correct, score, answered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          sessionId,
          questionId,
          nextIndex,
          JSON.stringify(selected),
          correct ? 1 : 0,
          correct ? 1 : 0,
          now,
        );
      const update = practiceDatabase
        .prepare(`
          UPDATE practice_sessions SET
            current_index = ?, correct_count = ?, score = ?, streak = ?,
            max_streak = ?, completed_at = ?
          WHERE id = ? AND current_index = ?
        `)
        .run(
          nextIndex,
          correctCount,
          score,
          streak,
          maxStreak,
          completed ? now : null,
          sessionId,
          session.current_index,
        );
      if (Number(update.changes) !== 1) {
        const error = new Error("题目进度已变化，请刷新后继续。");
        error.statusCode = 409;
        throw error;
      }

      if (correct) {
        practiceDatabase
          .prepare(`
            UPDATE mistakes
            SET correct_review_count = correct_review_count + 1
            WHERE question_id = ?
          `)
          .run(questionId);
      } else {
        practiceDatabase
          .prepare(`
            INSERT INTO mistakes (
              question_id, first_wrong_at, last_wrong_at, wrong_count,
              correct_review_count, status
            ) VALUES (?, ?, ?, 1, 0, 'active')
            ON CONFLICT(question_id) DO UPDATE SET
              last_wrong_at = excluded.last_wrong_at,
              wrong_count = mistakes.wrong_count + 1,
              status = 'active'
          `)
          .run(questionId, now, now);
      }

      let roundSummary = null;
      if (nextIndex % 10 === 0) {
        const start = nextIndex - 9;
        const rows = practiceDatabase
          .prepare(`
            SELECT question_id, correct FROM attempts
            WHERE session_id = ? AND position BETWEEN ? AND ?
            ORDER BY position
          `)
          .all(sessionId, start, nextIndex);
        const roundCorrect = rows.filter((row) => Number(row.correct) === 1).length;
        const mistakeIds = rows
          .filter((row) => Number(row.correct) === 0)
          .map((row) => row.question_id);
        const round = nextIndex / 10;
        practiceDatabase
          .prepare(`
            INSERT OR IGNORE INTO round_summaries (
              id, session_id, round_number, start_position, end_position,
              correct_count, question_ids_json, mistake_ids_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            randomUUID(),
            sessionId,
            round,
            start,
            nextIndex,
            roundCorrect,
            JSON.stringify(rows.map((row) => row.question_id)),
            JSON.stringify(mistakeIds),
            now,
          );
        roundSummary = {
          round,
          correct: roundCorrect,
          total: 10,
          accuracy: roundCorrect * 10,
          mistakeIds,
        };
      }

      result = {
        feedback: {
          correct,
          selected,
          answer: question.answer,
          explanation: question.explanation,
          solutionFormulas: question.solution_formulas,
          reviewNote: question.review_note,
        },
        session: {
          id: sessionId,
          mode: session.mode,
          total: Number(session.total_count),
          answered: nextIndex,
          correct: correctCount,
          score,
          streak,
          maxStreak,
          wrongCount: activeMistakeCount(practiceDatabase),
          accuracy: roundOneDecimal((correctCount / nextIndex) * 100),
          completed,
        },
        roundSummary,
        nextQuestion: completed ? null : publicQuestion(bank.questionById.get(ids[nextIndex])),
      };
      practiceDatabase.exec("COMMIT");
    } catch (error) {
      practiceDatabase.exec("ROLLBACK");
      throw error;
    }
    jsonResponse(response, 200, result);
  }

  function getStats(_request, response) {
    const attempts = practiceDatabase
      .prepare("SELECT question_id, correct, answered_at FROM attempts ORDER BY answered_at DESC LIMIT 5000")
      .all();
    const rounds = practiceDatabase
      .prepare(`
        SELECT session_id, round_number, correct_count, mistake_ids_json, created_at
        FROM round_summaries ORDER BY created_at DESC LIMIT 12
      `)
      .all();
    const sessions = Number(practiceDatabase.prepare("SELECT COUNT(*) AS count FROM practice_sessions").get().count);
    const total = attempts.length;
    const correct = attempts.filter((attempt) => Number(attempt.correct) === 1).length;
    const topicMap = new Map();
    for (const attempt of attempts) {
      const topic = bank.questionById.get(attempt.question_id)?.topic ?? FALLBACK_TOPIC;
      const current = topicMap.get(topic) ?? { total: 0, correct: 0 };
      current.total += 1;
      current.correct += Number(attempt.correct);
      topicMap.set(topic, current);
    }
    const topics = [...topicMap.entries()]
      .map(([topic, value]) => ({
        topic,
        total: value.total,
        correct: value.correct,
        accuracy: roundOneDecimal((value.correct / value.total) * 100),
      }))
      .sort((left, right) => right.total - left.total || left.topic.localeCompare(right.topic, "zh-CN"))
      .slice(0, 10);

    jsonResponse(response, 200, {
      totals: {
        attempts: total,
        correct,
        accuracy: total ? roundOneDecimal((correct / total) * 100) : 0,
        mistakes: activeMistakeCount(practiceDatabase),
        sessions,
      },
      topics,
      rounds: rounds.map((round) => ({
        sessionId: round.session_id,
        round: Number(round.round_number),
        correct: Number(round.correct_count),
        accuracy: Number(round.correct_count) * 10,
        mistakeIds: parseJson(round.mistake_ids_json),
        createdAt: round.created_at,
      })),
    });
  }

  function getMistakes(_request, response, url) {
    const status = url.searchParams.get("status") === "mastered" ? "mastered" : "active";
    const rows = practiceDatabase
      .prepare(`
        SELECT * FROM mistakes WHERE status = ?
        ORDER BY wrong_count DESC, last_wrong_at DESC LIMIT 500
      `)
      .all(status);
    const mistakes = rows.flatMap((row) => {
      const question = bank.questionById.get(row.question_id);
      if (!question) return [];
      return [{
        id: row.question_id,
        stem: question.stem,
        topic: question.topic,
        examDate: question.exam_date,
        type: question.type,
        wrongCount: Number(row.wrong_count),
        correctReviewCount: Number(row.correct_review_count),
        status: row.status,
        firstWrongAt: row.first_wrong_at,
        lastWrongAt: row.last_wrong_at,
      }];
    });
    jsonResponse(response, 200, { mistakes });
  }

  async function updateMistake(request, response) {
    const payload = await readJsonBody(request);
    const questionId = typeof payload.questionId === "string" ? payload.questionId.trim() : "";
    const status = payload.status === "mastered" ? "mastered" : "active";
    if (!questionId) {
      jsonResponse(response, 400, { error: "缺少题目编号。" });
      return;
    }
    const update = practiceDatabase
      .prepare("UPDATE mistakes SET status = ? WHERE question_id = ?")
      .run(status, questionId);
    if (Number(update.changes) === 0) {
      jsonResponse(response, 404, { error: "错题记录不存在。" });
      return;
    }
    jsonResponse(response, 200, { ok: true });
  }

  return {
    getHealth,
    getCatalog,
    startQuiz,
    getSession,
    answerQuiz,
    getStats,
    getMistakes,
    updateMistake,
  };
}

function serveStyles(response) {
  if (!existsSync(GLOBAL_STYLES_PATH)) {
    jsonResponse(response, 404, { error: "找不到样式文件。" });
    return;
  }
  const css = readFileSync(GLOBAL_STYLES_PATH, "utf8").replace(
    /^\uFEFF?\s*@import\s+["']tailwindcss["'];?\s*(?:\r?\n)?/,
    "",
  );
  const content = Buffer.from(css);
  response.writeHead(200, {
    "Content-Type": "text/css; charset=utf-8",
    "Content-Length": content.byteLength,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relativePath.includes("\0")) return null;
  const target = resolve(LOCAL_WEB_ROOT, relativePath);
  const route = relative(LOCAL_WEB_ROOT, target);
  if (route === ".." || route.startsWith(`..${sep}`) || resolve(target) === resolve(LOCAL_WEB_ROOT)) {
    return null;
  }
  return target;
}

function serveStatic(response, pathname) {
  const target = safeStaticPath(pathname);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    jsonResponse(response, 404, { error: "页面或文件不存在。" });
    return;
  }
  const content = readFileSync(target);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extname(target).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": content.byteLength,
    "Cache-Control": [".html", ".js", ".css"].includes(extname(target).toLowerCase())
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function methodNotAllowed(response, allow) {
  jsonResponse(response, 405, { error: "该接口不支持当前请求方法。" }, { Allow: allow });
}

function createRequestHandler(context) {
  const api = createApi(context);
  return async function requestHandler(request, response) {
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const { pathname } = url;
      if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
        emptyResponse(response, 204, { Allow: "GET, POST, OPTIONS" });
        return;
      }
      if (pathname === "/api/health") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return api.getHealth(request, response);
      }
      if (pathname === "/api/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return api.getCatalog(request, response);
      }
      if (pathname === "/api/quiz/start") {
        if (request.method !== "POST") return methodNotAllowed(response, "POST");
        return await api.startQuiz(request, response);
      }
      if (pathname === "/api/quiz/session") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return api.getSession(request, response, url);
      }
      if (pathname === "/api/quiz/answer") {
        if (request.method !== "POST") return methodNotAllowed(response, "POST");
        return await api.answerQuiz(request, response);
      }
      if (pathname === "/api/stats") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return api.getStats(request, response);
      }
      if (pathname === "/api/mistakes") {
        if (request.method === "GET") return api.getMistakes(request, response, url);
        if (request.method === "POST") return await api.updateMistake(request, response);
        return methodNotAllowed(response, "GET, POST");
      }
      if (pathname === "/styles.css") {
        if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(response, "GET, HEAD");
        return serveStyles(response);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(response, "GET, HEAD");
      }
      return serveStatic(response, pathname);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = Number(error?.statusCode) || 500;
      const message = status >= 500 ? `服务器处理请求失败：${error?.message ?? "未知错误"}` : error.message;
      if (status >= 500) console.error(error);
      jsonResponse(response, status, { error: message });
    }
  };
}

async function listenWithFallback(server, preferredPort) {
  let port = preferredPort;
  for (let attempt = 0; attempt < PORT_ATTEMPTS && port <= 65535; attempt += 1, port += 1) {
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectListen(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      console.warn(`端口 ${port} 已被占用，正在尝试 ${port + 1}…`);
    }
  }
  throw new Error(`从端口 ${preferredPort} 开始的 ${PORT_ATTEMPTS} 个端口均不可用。`);
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "explorer.exe";
    args = [url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // A browser is a convenience only; the printed URL always remains usable.
  }
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`启动参数错误：${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  let bank;
  let practiceDatabase;
  try {
    bank = loadQuestionBank(options.questionDb);
    practiceDatabase = openPracticeDatabase(options.practiceDb);
  } catch (error) {
    console.error(`本地数据库初始化失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const server = createServer(createRequestHandler({ bank, practiceDatabase }));
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  let port;
  try {
    port = await listenWithFallback(server, options.port);
  } catch (error) {
    practiceDatabase.close();
    console.error(`本地服务器启动失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const url = `http://127.0.0.1:${port}`;
  console.log("\nAI Theory Forge 大模型基础理论看板已启动");
  console.log(`访问地址：${url}`);
  console.log(`题库：${options.questionDb}`);
  console.log(`练习记录：${options.practiceDb}`);
  console.log("关闭方法：在本窗口按 Ctrl+C\n");
  if (!existsSync(join(LOCAL_WEB_ROOT, "index.html"))) {
    console.warn(`提示：${join(LOCAL_WEB_ROOT, "index.html")} 尚不存在，API 可用但首页将返回 404。`);
  }
  if (!options.noBrowser) openBrowser(url);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    console.log("\n正在安全关闭本地看板…");
    server.close(() => {
      practiceDatabase.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

await main();
