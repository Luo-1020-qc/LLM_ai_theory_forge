(function () {
  "use strict";

  var SESSION_STORAGE_KEY = "ai-theory-forge-last-session";
  var ALLOWED_COUNTS = [10, 20, 50, 100];
  var NAV_ITEMS = [
    { id: "practice", label: "随机练习", index: "01" },
    { id: "dashboard", label: "能力看板", index: "02" },
    { id: "mistakes", label: "错题库", index: "03" },
    { id: "catalog", label: "题源档案", index: "04" }
  ];

  var app = document.getElementById("app");
  var state = {
    catalog: null,
    catalogError: "",
    tab: "practice",
    session: null,
    question: null,
    nextQuestion: null,
    selected: [],
    feedback: null,
    roundSummary: null,
    stats: null,
    mistakes: [],
    mistakeStatus: "active",
    count: 20,
    topic: "",
    examDate: "",
    mode: "random",
    busy: false,
    restoring: false,
    statsLoading: false,
    mistakesLoading: false,
    pendingMistake: "",
    error: ""
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderMath(value) {
    var math = String(value == null ? "" : value).trim();
    math = math
      .replace(/\\left|\\right/g, "")
      .replace(/\\mathbb\{R\}/g, "ℝ")
      .replace(/\\mathbb\{N\}/g, "ℕ")
      .replace(/\\mathbb\{Z\}/g, "ℤ")
      .replace(/\\times/g, "×")
      .replace(/\\cdot/g, "·")
      .replace(/\\geq|\\ge/g, "≥")
      .replace(/\\leq|\\le/g, "≤")
      .replace(/\\neq/g, "≠")
      .replace(/\\approx/g, "≈")
      .replace(/\\to/g, "→")
      .replace(/\\infty/g, "∞")
      .replace(/\\ldots|\\cdots/g, "…")
      .replace(/\\in/g, "∈")
      .replace(/\\sum/g, "∑")
      .replace(/\\prod/g, "∏")
      .replace(/\\rho/g, "ρ")
      .replace(/\\mu/g, "μ")
      .replace(/\\sigma/g, "σ")
      .replace(/\\pi/g, "π")
      .replace(/\\theta/g, "θ")
      .replace(/\\lambda/g, "λ")
      .replace(/\\exp/g, "exp")
      .replace(/\\text\{([^{}]*)\}/g, "$1")
      .replace(/\\operatorname\{([^{}]*)\}/g, "$1")
      .replace(/\\hat\{([^{}]+)\}/g, "$1̂")
      .replace(/\\bar\{([^{}]+)\}/g, "$1̄")
      .replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");

    var previous;
    do {
      previous = math;
      math = math.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
    } while (math !== previous);

    var safe = escapeHtml(math);
    safe = safe
      .replace(/\^\(([^()]+)\)/g, "<sup>($1)</sup>")
      .replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>")
      .replace(/\^([A-Za-z0-9])/g, "<sup>$1</sup>")
      .replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>")
      .replace(/_([A-Za-z0-9]+)/g, "<sub>$1</sub>")
      .replace(/\\,/g, " ")
      .replace(/\\!/g, "")
      .replace(/\\([{}])/g, "$1");
    return '<span class="math-inline">' + safe + "</span>";
  }

  function renderInlineMath(value) {
    var source = String(value == null ? "" : value);
    var output = "";
    var cursor = 0;
    var pattern = /\$([^$\n]+)\$/g;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      output += escapeHtml(source.slice(cursor, match.index));
      output += renderMath(match[1]);
      cursor = pattern.lastIndex;
    }
    output += escapeHtml(source.slice(cursor));
    return output;
  }

  function renderRichText(value) {
    var source = String(value == null ? "" : value);
    var pieces = source.split("**");
    if (pieces.length === 1) return renderInlineMath(source);
    return pieces.map(function (piece, index) {
      var rendered = renderInlineMath(piece);
      return index % 2 === 1 ? "<strong>" + rendered + "</strong>" : rendered;
    }).join("");
  }

  function safeExternalUrl(value) {
    try {
      var url = new URL(String(value));
      return url.protocol === "https:" || url.protocol === "http:" ? escapeHtml(url.href) : "#";
    } catch (_error) {
      return "#";
    }
  }

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function percentage(value) {
    return Math.min(100, Math.max(0, number(value, 0)));
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      // 浏览器禁止本地存储时，当前会话仍可正常完成。
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // 无需阻断练习。
    }
  }

  async function api(url, init) {
    var options = Object.assign({}, init || {});
    options.headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    var response;
    try {
      response = await fetch(url, options);
    } catch (_error) {
      throw new Error("无法连接本地服务，请确认启动窗口仍在运行。");
    }
    var text = await response.text();
    var data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        throw new Error("本地服务返回了无法识别的数据。");
      }
    }
    if (!response.ok) {
      throw new Error(data.error || ("请求失败（" + response.status + "）"));
    }
    return data;
  }

  function metric(label, value, suffix) {
    return (
      '<div class="metric">' +
        "<span>" + escapeHtml(label) + "</span>" +
        "<strong>" + escapeHtml(value) + "</strong>" +
        (suffix ? "<em>" + escapeHtml(suffix) + "</em>" : "") +
      "</div>"
    );
  }

  function formulaEntries(formulas) {
    var entries = [];
    (Array.isArray(formulas) ? formulas : []).forEach(function (formula) {
      var source = String(formula == null ? "" : formula).trim();
      if (!source) return;
      if (/^\$[^$\n]+\$$/.test(source)) {
        entries.push(source);
        return;
      }
      var found = false;
      source.replace(/\$([^$\n]+)\$/g, function (_match, math) {
        entries.push("$" + math + "$");
        found = true;
        return _match;
      });
      if (!found && source.length <= 140 && /[=<>≤≥∑√^_]|\\(?:frac|sum|sqrt|times|cdot)/.test(source)) {
        entries.push(source);
      }
    });
    return [...new Set(entries)];
  }

  function formulaBlock(title, formulas) {
    var entries = formulaEntries(formulas);
    if (!entries.length) return "";
    return (
      '<div class="formula-block">' +
        "<span>" + escapeHtml(title) + "</span>" +
        entries.map(function (formula) {
          var source = String(formula == null ? "" : formula).trim();
          var pureMath = source.match(/^\$([^$\n]+)\$$/);
          return "<code>" + (pureMath ? renderMath(pureMath[1]) : renderRichText(source)) + "</code>";
        }).join("") +
      "</div>"
    );
  }

  function renderNavigation() {
    return NAV_ITEMS.map(function (item) {
      var active = state.tab === item.id;
      return (
        '<button type="button" data-action="tab" data-tab="' + item.id + '"' +
          (active ? ' class="active" aria-current="page"' : "") + ">" +
          "<small>" + item.index + "</small>" + escapeHtml(item.label) +
        "</button>"
      );
    }).join("");
  }

  function renderError() {
    if (!state.error) return "";
    return (
      '<div class="error-banner" role="alert">' +
        "<span>" + escapeHtml(state.error) + "</span>" +
        '<button type="button" data-action="close-error" aria-label="关闭错误提示">关闭</button>' +
      "</div>"
    );
  }

  function renderSetup() {
    if (state.restoring) {
      return '<div class="empty-state panel" role="status"><span>SESSION RECOVERY</span><h2>正在恢复上次练习…</h2></div>';
    }

    var topics = (state.catalog.topics || []).slice(0, 30);
    var sources = state.catalog.sources || [];
    var topicOptions = topics.map(function (item) {
      return '<option value="' + escapeHtml(item.name) + '"' + (state.topic === item.name ? " selected" : "") + ">" +
        escapeHtml(item.name) + " · " + escapeHtml(item.count) + "</option>";
    }).join("");
    var sourceOptions = sources.map(function (source) {
      return '<option value="' + escapeHtml(source.exam_date) + '"' + (state.examDate === source.exam_date ? " selected" : "") + ">" +
        escapeHtml(source.exam_date) + "</option>";
    }).join("");
    var countButtons = ALLOWED_COUNTS.map(function (value) {
      return '<button type="button" data-action="set-count" data-count="' + value + '"' +
        (state.count === value ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') + ">" + value + "</button>";
    }).join("");

    return (
      '<div class="setup-grid">' +
        '<div class="setup-main panel">' +
          '<div class="section-heading"><span>SESSION CONFIG</span><h2>创建一组练习</h2></div>' +
          '<div class="mode-switch" role="group" aria-label="练习模式">' +
            '<button type="button" data-action="set-mode" data-mode="random"' +
              (state.mode === "random" ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') + ">" +
              "<strong>随机抽题</strong><small>从已核验题目中不重复抽取</small>" +
            "</button>" +
            '<button type="button" data-action="set-mode" data-mode="mistakes"' +
              (state.mode === "mistakes" ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') + ">" +
              "<strong>错题重练</strong><small>只抽取错题库中的待掌握题目</small>" +
            "</button>" +
          "</div>" +
          '<div class="field"><span id="count-label">本组题量</span><div class="count-buttons" role="group" aria-labelledby="count-label">' + countButtons + "</div></div>" +
          '<div class="field-row">' +
            '<label class="field"><span>知识专题</span><select data-field="topic">' +
              '<option value="">全部专题</option>' + topicOptions +
            "</select></label>" +
            '<label class="field"><span>考试场次</span><select data-field="exam-date">' +
              '<option value="">全部 ' + escapeHtml(sources.length) + " 组</option>" + sourceOptions +
            "</select></label>" +
          "</div>" +
          '<button type="button" class="primary-action" data-action="start"' + (state.busy ? " disabled" : "") + ">" +
            (state.busy ? "正在组卷…" : "开始练习 →") +
          "</button>" +
        "</div>" +
        '<aside class="setup-aside panel dark-panel">' +
          '<span class="panel-kicker">SCORING PROTOCOL</span>' +
          "<h3>每 10 题一次结算</h3>" +
          "<ol>" +
            "<li><b>01</b> 单选与多选均为精确匹配</li>" +
            "<li><b>02</b> 提交后立即显示得分与详解</li>" +
            "<li><b>03</b> 第 10 / 20 / 30 题生成分段看板</li>" +
            "<li><b>04</b> 错题按稳定编号自动归档</li>" +
          "</ol>" +
          "<p>快捷键：A–H 选择，Enter 提交或进入下一题。练习和错题数据只保存在本机。</p>" +
        "</aside>" +
      "</div>"
    );
  }

  function renderRoundSummary(summary) {
    if (!summary) return "";
    var mistakes = Array.isArray(summary.mistakeIds) ? summary.mistakeIds : [];
    return (
      '<div class="round-callout" role="status">' +
        "<div><span>ROUND " + String(number(summary.round, 0)).padStart(2, "0") + "</span><strong>十题结算完成</strong></div>" +
        "<b>" + escapeHtml(summary.correct) + "/" + escapeHtml(summary.total || 10) + "<small>" + escapeHtml(summary.accuracy) + "%</small></b>" +
        "<p>" + (mistakes.length ? "错题已归档：" + mistakes.map(escapeHtml).join(" · ") : "本轮全对，没有新增错题。") + "</p>" +
      "</div>"
    );
  }

  function renderQuestion() {
    var question = state.question;
    var session = state.session;
    var feedback = state.feedback;
    if (!question || !session) return renderSetup();

    var selected = new Set(state.selected);
    var answers = new Set(feedback && Array.isArray(feedback.answer) ? feedback.answer : []);
    var options = (question.options || []).map(function (option) {
      var label = String(option.label || "").toUpperCase();
      var chosen = selected.has(label);
      var correct = answers.has(label);
      var wrong = Boolean(feedback && chosen && !correct);
      var classes = ["option"];
      if (chosen) classes.push("selected");
      if (correct) classes.push("correct");
      if (wrong) classes.push("wrong");
      var resultMark = feedback ? (correct ? "✓" : wrong ? "×" : "") : (chosen ? "●" : "");
      return (
        '<button type="button" id="option-' + escapeHtml(label) + '" class="' + classes.join(" ") + '"' +
          ' data-action="toggle-option" data-label="' + escapeHtml(label) + '"' +
          ' aria-pressed="' + (chosen ? "true" : "false") + '"' +
          ' aria-label="选项 ' + escapeHtml(label) + '：' + escapeHtml(option.text) + '"' +
          (feedback ? " disabled" : "") + ">" +
          "<b>" + escapeHtml(label) + "</b><span>" + renderRichText(option.text) + "</span><i aria-hidden=\"true\">" + resultMark + "</i>" +
        "</button>"
      );
    }).join("");
    var feedbackHtml = "";
    if (feedback) {
      feedbackHtml = (
        '<div class="feedback ' + (feedback.correct ? "pass" : "fail") + '" aria-live="polite">' +
          '<div class="feedback-title"><strong>' + (feedback.correct ? "回答正确" : "本题答错") + "</strong><span>正确答案：" +
            (feedback.answer || []).map(escapeHtml).join("、") + "</span></div>" +
          "<p>" + renderRichText(feedback.explanation) + "</p>" +
          formulaBlock("计算 / 推导公式", feedback.solutionFormulas) +
          (feedback.reviewNote ? '<div class="review-note">待复核说明：' + escapeHtml(feedback.reviewNote) + "</div>" : "") +
        "</div>"
      );
    }
    var progress = session.total ? percentage((number(session.answered, 0) / number(session.total, 1)) * 100) : 0;
    var current = Math.min(number(session.answered, 0) + 1, number(session.total, 0));
    var accuracy = number(session.accuracy, 0).toFixed(1);
    var countdown = number(session.answered, 0) % 10 === 0 ? 10 : 10 - (number(session.answered, 0) % 10);
    var promptFormulas = Array.isArray(question.prompt_formulas) ? question.prompt_formulas : [];

    return (
      '<div class="practice-layout">' +
        '<article class="question-card panel">' +
          '<div class="question-topline"><div>' +
            '<span class="question-id">' + escapeHtml(question.id) + "</span>" +
            '<span class="tag">' + (question.type === "multiple" ? "多选" : "单选") + "</span>" +
            (question.is_calculation ? '<span class="tag formula-tag">计算题</span>' : "") +
          "</div><strong>" + current + " / " + escapeHtml(session.total) + "</strong></div>" +
          '<div class="progress-track" aria-label="练习进度"><i style="width:' + progress + '%"></i></div>' +
          '<div class="question-meta"><span>' + escapeHtml(question.exam_date) + "</span><span>" + escapeHtml(question.topic || "综合基础") + "</span><span>" + escapeHtml(question.difficulty || "未分级") + "</span></div>" +
          '<h2 id="question-title" tabindex="-1">' + renderRichText(question.stem) + "</h2>" +
          formulaBlock("题中公式", promptFormulas) +
          '<div class="options" role="group" aria-label="答案选项">' + options + "</div>" +
          feedbackHtml +
          renderRoundSummary(state.roundSummary) +
          '<div class="question-actions"><span>' +
            (feedback ? "详解已展开" : question.type === "multiple" ? "多选题：少选、多选、错选均不得分" : "选择一个最合适的答案") +
          "</span>" +
          '<button type="button" class="primary-action compact" data-action="' + (feedback ? "advance" : "submit") + '"' +
            (state.busy || (!feedback && !state.selected.length) ? " disabled" : "") + ">" +
            (state.busy ? "处理中…" : feedback ? (session.completed ? "查看总看板" : "下一题 →") : "提交答案") +
          "</button></div>" +
        "</article>" +
        '<aside class="live-panel panel" aria-label="实时得分看板">' +
          '<span class="panel-kicker">LIVE SCOREBOARD</span><h3>实时得分</h3>' +
          '<div class="score-orbit" aria-live="polite"><strong>' + accuracy + '%</strong><span>当前正确率</span></div>' +
          '<div class="live-stats">' +
            metric("得分", number(session.score, 0) + "/" + number(session.answered, 0)) +
            metric("连续答对", number(session.streak, 0)) +
            metric("最高连击", number(session.maxStreak, 0)) +
            metric("错题库", number(session.wrongCount, 0)) +
          "</div>" +
          '<div class="round-countdown"><span>下次十题结算</span><strong>' + countdown + "<small>题后</small></strong></div>" +
          '<button type="button" class="ghost-button" data-action="reset-session" style="width:100%;margin-top:14px">重新组卷</button>' +
        "</aside>" +
      "</div>"
    );
  }

  function renderDashboard() {
    if (state.statsLoading && !state.stats) {
      return '<div class="empty-state panel" role="status"><span>ANALYTICS</span><h2>正在读取练习记录…</h2></div>';
    }
    if (!state.stats) {
      return '<div class="empty-state panel"><span>ANALYTICS</span><h2>暂时无法读取统计</h2><button type="button" class="ghost-button" data-action="refresh-stats">重试</button></div>';
    }
    var totals = state.stats.totals || {};
    var topics = Array.isArray(state.stats.topics) ? state.stats.topics : [];
    var rounds = Array.isArray(state.stats.rounds) ? state.stats.rounds : [];
    var topicHtml = topics.length ? topics.map(function (item) {
      var width = percentage(item.accuracy);
      return (
        '<div class="topic-bar"><div><span>' + escapeHtml(item.topic) + "</span><b>" + escapeHtml(item.correct) + "/" + escapeHtml(item.total) + " · " + escapeHtml(item.accuracy) +
        '%</b></div><i aria-hidden="true"><em style="width:' + width + '%"></em></i></div>'
      );
    }).join("") : '<p class="muted">完成一组练习后，这里会出现专题正确率。</p>';
    var roundHtml = rounds.length ? rounds.map(function (round) {
      var mistakeIds = Array.isArray(round.mistakeIds) ? round.mistakeIds : [];
      return (
        '<div class="round-row" title="' + escapeHtml(mistakeIds.join(" · ")) + '"><b>' + escapeHtml(round.accuracy) +
        "%</b><div><strong>第 " + escapeHtml(round.round) + " 轮</strong><span>" + escapeHtml(round.correct) + "/10 · " + mistakeIds.length + " 道错题</span></div></div>"
      );
    }).join("") : '<p class="muted">每完成 10 题，就会在此新增一条统计。</p>';

    return (
      '<div class="dashboard-grid">' +
        '<section class="panel dashboard-main">' +
          '<div class="section-heading row"><div><span>PERFORMANCE</span><h2>能力总览</h2></div>' +
            '<button type="button" class="ghost-button" data-action="refresh-stats"' + (state.statsLoading ? " disabled" : "") + ">" + (state.statsLoading ? "刷新中…" : "刷新") + "</button></div>" +
          '<div class="stats-strip">' +
            metric("累计作答", number(totals.attempts, 0)) +
            metric("累计正确", number(totals.correct, 0)) +
            metric("全局正确率", number(totals.accuracy, 0) + "%") +
            metric("活跃错题", number(totals.mistakes, 0)) +
          "</div>" +
          '<h3 class="subheading">专题表现</h3><div class="topic-bars">' + topicHtml + "</div>" +
        "</section>" +
        '<aside class="panel rounds-panel"><span class="panel-kicker">TEN-QUESTION CUTS</span><h3>最近十题切片</h3><div class="round-list">' + roundHtml + "</div></aside>" +
      "</div>"
    );
  }

  function renderMistakes() {
    var list = Array.isArray(state.mistakes) ? state.mistakes : [];
    var items = "";
    if (state.mistakesLoading && !list.length) {
      items = '<div class="empty-inline" role="status"><strong>正在读取错题库…</strong></div>';
    } else if (list.length) {
      items = '<div class="mistake-list">' + list.map(function (item) {
        var pending = state.pendingMistake === item.id;
        return (
          "<article><div><span class=\"question-id\">" + escapeHtml(item.id) + "</span><span class=\"tag\">错 " + escapeHtml(item.wrongCount) + " 次</span></div>" +
          "<h3>" + renderRichText(item.stem) + "</h3>" +
          "<p>" + escapeHtml(item.examDate) + " · " + escapeHtml(item.topic || "综合基础") + " · 复习答对 " + escapeHtml(item.correctReviewCount) + " 次</p>" +
          '<button type="button" class="ghost-button" data-action="mistake-update" data-id="' + escapeHtml(item.id) + '" data-status="' +
            (state.mistakeStatus === "active" ? "mastered" : "active") + '"' + (pending ? " disabled" : "") + ">" +
            (pending ? "更新中…" : state.mistakeStatus === "active" ? "标记已掌握" : "移回待掌握") +
          "</button></article>"
        );
      }).join("") + "</div>";
    } else {
      items = '<div class="empty-inline"><div><strong>' + (state.mistakeStatus === "active" ? "暂无待掌握错题" : "暂无已掌握题目") +
        "</strong><span>练习中答错的稳定题号会自动出现在这里。</span></div></div>";
    }
    return (
      '<div class="panel library-panel">' +
        '<div class="section-heading row"><div><span>MISTAKE ARCHIVE</span><h2>错题库</h2></div>' +
          '<button type="button" class="primary-action compact" data-action="start-review"' +
            (!list.length || state.mistakeStatus === "mastered" || state.mistakesLoading ? " disabled" : "") + ">随机重练</button></div>" +
        '<div class="filter-tabs" role="group" aria-label="错题状态">' +
          '<button type="button" data-action="mistake-status" data-status="active"' + (state.mistakeStatus === "active" ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') + ">待掌握</button>" +
          '<button type="button" data-action="mistake-status" data-status="mastered"' + (state.mistakeStatus === "mastered" ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') + ">已掌握</button>" +
        "</div>" + items +
      "</div>"
    );
  }

  function renderCatalog() {
    var catalog = state.catalog;
    var metadata = catalog.metadata || {};
    var sources = Array.isArray(catalog.sources) ? catalog.sources : [];
    var rows = sources.map(function (source) {
      var full = source.source_completeness === "full";
      return (
        '<a href="' + safeExternalUrl(source.url) + '" target="_blank" rel="noreferrer noopener">' +
          "<span>" + escapeHtml(source.exam_date) + "<small>" + escapeHtml(source.job_track || "AI 岗") + "</small></span>" +
          "<b>" + escapeHtml(source.parsed_choice_count) + " / " + escapeHtml(source.advertised_choice_count) + "</b>" +
          '<em class="' + (full ? "ok" : "excerpt") + '">' + (full ? "完整" : "精选") + "</em>" +
        "</a>"
      );
    }).join("");
    return (
      '<div class="catalog-grid">' +
        '<section class="panel"><div class="section-heading"><span>SOURCE COVERAGE</span><h2>' + escapeHtml(metadata.source_count || sources.length) + " 组题源档案</h2></div>" +
          '<div class="coverage-note"><b>' + escapeHtml(metadata.question_count || 0) + "</b><p>这是正文实际公开数量。4 月 8 日页面宣称 20 题，但仅公开 6 道精选；系统没有补造其余题目。</p></div>" +
          '<div class="source-table"><div class="source-head"><span>场次</span><span>公开 / 宣称</span><span>状态</span></div>' + rows + "</div>" +
        "</section>" +
        '<aside class="panel methodology"><span class="panel-kicker">QUALITY GATES</span><h3>入库质量规则</h3><ul>' +
          "<li>稳定编号保留来源日期与原题号</li><li>单选、多选答案执行集合精确匹配</li><li>计算题同时保留题中公式与推导公式</li>" +
          "<li>答案矛盾或题干缺失的 6 题默认禁用</li><li>逐场来源、采集日期和许可说明可追溯</li></ul>" +
          "<p>完整结构化数据、SQLite 数据库及覆盖报告已随项目一并交付。</p></aside>" +
      "</div>"
    );
  }

  function renderWorkspace() {
    if (state.tab === "dashboard") return renderDashboard();
    if (state.tab === "mistakes") return renderMistakes();
    if (state.tab === "catalog") return renderCatalog();
    return renderQuestion();
  }

  function renderFatal() {
    app.innerHTML = (
      '<main class="shell"><section class="workspace"><div class="empty-state panel" role="alert">' +
        "<span>LOCAL SERVICE</span><h2>本地题库加载失败</h2><p class=\"muted\">" + escapeHtml(state.catalogError || "未知错误") + "</p>" +
        '<button type="button" class="primary-action compact" data-action="retry-catalog">重新连接</button>' +
      "</div></section></main>"
    );
  }

  function render() {
    if (!state.catalog) {
      if (state.catalogError) renderFatal();
      return;
    }
    var metadata = state.catalog.metadata || {};
    app.innerHTML = (
      '<main class="shell">' +
        '<header class="topbar"><a class="brand" href="#top" aria-label="返回顶部"><span class="brand-mark">A</span><span>AI THEORY FORGE</span></a>' +
          '<div class="status-pill"><i aria-hidden="true"></i> 本地运行 · 数据自动保存</div></header>' +
        '<section class="hero" id="top"><div class="hero-copy"><p class="eyebrow">LARGE MODEL FUNDAMENTALS · PRACTICE SYSTEM</p>' +
          "<h1>大模型基础理论<br><span>实战练习看板</span></h1>" +
          "<p class=\"hero-lead\">汇集 " + escapeHtml(metadata.source_count || 0) + " 组互联网公司 AI 岗与原创强化选择题。随机抽题、即时判分，每十题自动形成能力切片，并将错题稳定编号入库。</p></div>" +
          '<div class="hero-ledger" aria-label="题库概览">' +
            metric("实际公开", number(metadata.question_count, 0), "题") +
            metric("默认可练", number(metadata.usable_count, 0), "题") +
            metric("题库分组", number(metadata.source_count, 0), "组") +
            metric("待人工复核", number(metadata.needs_review_count, 0), "题") +
          "</div></section>" +
        '<nav class="workspace-nav" aria-label="看板功能">' + renderNavigation() + "</nav>" +
        renderError() +
        '<section class="workspace" id="workspace">' + renderWorkspace() + "</section>" +
        "<footer><span>AI Theory Forge · 大模型基础理论试题项目</span><span>无需构建 · 本机数据库持久化</span></footer>" +
      "</main>"
    );
  }

  function setError(error, fallback) {
    state.error = error instanceof Error ? error.message : fallback;
    render();
  }

  function focusAfterRender(id) {
    window.requestAnimationFrame(function () {
      var element = document.getElementById(id);
      if (element) element.focus({ preventScroll: true });
    });
  }

  async function loadCatalog() {
    state.catalogError = "";
    try {
      var result = await api("/api/catalog");
      var catalog = result && result.catalog ? result.catalog : result;
      if (!catalog || !catalog.metadata || !Array.isArray(catalog.sources) || !Array.isArray(catalog.topics)) {
        throw new Error("题库目录格式不完整。");
      }
      state.catalog = catalog;
      render();
      await restoreSession();
    } catch (error) {
      state.catalogError = error instanceof Error ? error.message : "无法读取题库目录。";
      renderFatal();
    }
  }

  async function restoreSession() {
    var id = storageGet(SESSION_STORAGE_KEY);
    if (!id) return;
    state.restoring = true;
    render();
    try {
      var data = await api("/api/quiz/session?id=" + encodeURIComponent(id));
      if (data.session && !data.session.completed && data.question) {
        state.session = data.session;
        state.question = data.question;
      } else {
        storageRemove(SESSION_STORAGE_KEY);
      }
    } catch (_error) {
      storageRemove(SESSION_STORAGE_KEY);
    } finally {
      state.restoring = false;
      render();
    }
  }

  async function startPractice() {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    render();
    try {
      var data = await api("/api/quiz/start", {
        method: "POST",
        body: JSON.stringify({
          count: state.count,
          mode: state.mode,
          topic: state.topic || undefined,
          examDate: state.examDate || undefined
        })
      });
      state.session = data.session;
      state.question = data.question;
      state.nextQuestion = null;
      state.selected = [];
      state.feedback = null;
      state.roundSummary = null;
      if (data.session && data.session.id) storageSet(SESSION_STORAGE_KEY, data.session.id);
      render();
      focusAfterRender("question-title");
    } catch (error) {
      setError(error, "启动练习失败。");
    } finally {
      state.busy = false;
      render();
    }
  }

  function toggleOption(label, shouldFocus) {
    if (!state.question || state.feedback || state.busy) return;
    var normalized = String(label || "").toUpperCase();
    var exists = (state.question.options || []).some(function (option) { return option.label === normalized; });
    if (!exists) return;
    if (state.question.type === "single") {
      state.selected = [normalized];
    } else if (state.selected.indexOf(normalized) >= 0) {
      state.selected = state.selected.filter(function (item) { return item !== normalized; });
    } else {
      state.selected = state.selected.concat(normalized);
    }
    render();
    if (shouldFocus) focusAfterRender("option-" + normalized);
  }

  async function submitAnswer() {
    if (state.busy || !state.session || !state.question || !state.selected.length || state.feedback) return;
    state.busy = true;
    state.error = "";
    render();
    try {
      var data = await api("/api/quiz/answer", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.session.id,
          questionId: state.question.id,
          selected: state.selected.slice()
        })
      });
      state.feedback = data.feedback;
      state.session = data.session;
      state.roundSummary = data.roundSummary || null;
      state.nextQuestion = data.nextQuestion || null;
      if (data.session && data.session.completed) storageRemove(SESSION_STORAGE_KEY);
    } catch (error) {
      setError(error, "提交答案失败。");
    } finally {
      state.busy = false;
      render();
    }
  }

  function advance() {
    if (!state.feedback || !state.session) return;
    if (state.nextQuestion) {
      state.question = state.nextQuestion;
      state.nextQuestion = null;
      state.selected = [];
      state.feedback = null;
      state.roundSummary = null;
      render();
      focusAfterRender("question-title");
      return;
    }
    state.question = null;
    state.session = null;
    state.feedback = null;
    state.roundSummary = null;
    state.selected = [];
    state.tab = "dashboard";
    render();
    void loadStats();
  }

  function resetSession() {
    storageRemove(SESSION_STORAGE_KEY);
    state.session = null;
    state.question = null;
    state.nextQuestion = null;
    state.selected = [];
    state.feedback = null;
    state.roundSummary = null;
    render();
  }

  async function loadStats() {
    if (state.statsLoading) return;
    state.statsLoading = true;
    state.error = "";
    render();
    try {
      state.stats = await api("/api/stats");
    } catch (error) {
      setError(error, "读取统计失败。");
    } finally {
      state.statsLoading = false;
      render();
    }
  }

  async function loadMistakes() {
    if (state.mistakesLoading) return;
    state.mistakesLoading = true;
    state.error = "";
    state.mistakes = [];
    render();
    try {
      var data = await api("/api/mistakes?status=" + encodeURIComponent(state.mistakeStatus));
      state.mistakes = Array.isArray(data.mistakes) ? data.mistakes : [];
    } catch (error) {
      setError(error, "读取错题库失败。");
    } finally {
      state.mistakesLoading = false;
      render();
    }
  }

  async function updateMistake(id, status) {
    if (state.pendingMistake) return;
    state.pendingMistake = id;
    state.error = "";
    render();
    try {
      await api("/api/mistakes", {
        method: "POST",
        body: JSON.stringify({ questionId: id, status: status })
      });
      state.pendingMistake = "";
      await loadMistakes();
    } catch (error) {
      state.pendingMistake = "";
      setError(error, "更新错题状态失败。");
    }
  }

  async function startMistakeReview() {
    state.mode = "mistakes";
    state.topic = "";
    state.examDate = "";
    state.tab = "practice";
    resetSession();
    await startPractice();
  }

  async function switchTab(tab) {
    if (!NAV_ITEMS.some(function (item) { return item.id === tab; })) return;
    state.tab = tab;
    state.error = "";
    render();
    if (tab === "dashboard") await loadStats();
    if (tab === "mistakes") await loadMistakes();
  }

  app.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target || target.hasAttribute("disabled")) return;
    var action = target.getAttribute("data-action");
    if (action === "tab") void switchTab(target.getAttribute("data-tab"));
    if (action === "close-error") { state.error = ""; render(); }
    if (action === "retry-catalog") void loadCatalog();
    if (action === "set-mode") { state.mode = target.getAttribute("data-mode") === "mistakes" ? "mistakes" : "random"; render(); }
    if (action === "set-count") {
      var count = number(target.getAttribute("data-count"), 20);
      if (ALLOWED_COUNTS.indexOf(count) >= 0) { state.count = count; render(); }
    }
    if (action === "start") void startPractice();
    if (action === "toggle-option") toggleOption(target.getAttribute("data-label"), true);
    if (action === "submit") void submitAnswer();
    if (action === "advance") advance();
    if (action === "reset-session") resetSession();
    if (action === "refresh-stats") void loadStats();
    if (action === "mistake-status") {
      state.mistakeStatus = target.getAttribute("data-status") === "mastered" ? "mastered" : "active";
      void loadMistakes();
    }
    if (action === "mistake-update") {
      void updateMistake(target.getAttribute("data-id") || "", target.getAttribute("data-status") === "mastered" ? "mastered" : "active");
    }
    if (action === "start-review") void startMistakeReview();
  });

  app.addEventListener("change", function (event) {
    var target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    var field = target.getAttribute("data-field");
    if (field === "topic") state.topic = target.value;
    if (field === "exam-date") state.examDate = target.value;
    render();
  });

  document.addEventListener("keydown", function (event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    var target = event.target;
    if (target instanceof Element && target.closest("input, select, textarea, button, [contenteditable=true]")) return;
    if (state.tab !== "practice" || !state.question) return;
    if (/^[a-h]$/i.test(event.key) && !state.feedback) {
      var label = event.key.toUpperCase();
      var exists = (state.question.options || []).some(function (option) { return option.label === label; });
      if (exists) {
        event.preventDefault();
        toggleOption(label, false);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (state.feedback) advance();
      else void submitAnswer();
    }
  });

  void loadCatalog();
}());
