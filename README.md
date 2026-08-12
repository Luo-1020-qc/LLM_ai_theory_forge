# AI Theory Forge · 大模型基础理论练习看板

这是一个完全在本机运行的“看板 + 数据库”项目，面向互联网公司 AI 岗的大模型基础理论选择题练习。浏览器负责交互，本地 Node 服务负责出题和评分，SQLite 负责保存题库与练习记录。无需登录、无需云服务、无需安装项目依赖。

## 一键启动

双击根目录中的 `启动本地看板.cmd`。浏览器会自动打开；使用结束后，在启动窗口按 `Ctrl+C`。

环境要求：Node.js 22.13 或更高版本。

## 项目结构

```text
大模型基础理论试题项目/
├─ dashboard/                   # HTML 看板
│  ├─ index.html                # 页面入口
│  ├─ app.js                    # 练习、评分与看板交互
│  └─ styles.css                # 页面样式
├─ database/                    # SQLite 与题库资料
│  ├─ ai_question_bank.sqlite3
│  ├─ ai_practice.sqlite3       # 首次练习时自动创建
│  ├─ curated/                  # 19 组逐场/专题整理数据
│  ├─ exports/                  # JSON、校验值与覆盖报告
│  └─ build-database.mjs        # 题库校验/重建工具
├─ tests/
│  └─ local-server.test.mjs
├─ local_server.mjs
├─ 启动本地看板.cmd
└─ README.md
```

## 数据说明

- `database/ai_question_bank.sqlite3`：只读题库，包含 19 组、366 道选择题，其中 360 道默认可练；新增的 20 道为基于研究材料重组的“强化题库 01”。
- `database/ai_practice.sqlite3`：个人练习数据库，保存会话、作答、十题复盘和错题；首次作答时自动创建。
- `database/exports/coverage-report.md`：逐场覆盖情况和待复核题目说明。

题库和练习记录相互独立，因此重新生成题库不会清空个人练习历史。

## 使用规则

- 支持 10、20、50、100 题随机组卷，可按专题或考试场次筛选。
- 单选、多选均采用答案集合精确匹配；多选题少选、多选、错选均不得分。
- 每题提交后立即显示正确答案、详细讲解和计算公式。
- 每完成十题生成一次分段统计，答错的稳定题号自动进入错题库。
- 错题可以随机重练，并可手动标记为“已掌握”。

## 命令行

```powershell
node local_server.mjs
```

不自动打开浏览器：

```powershell
node local_server.mjs --no-browser
```

运行完整测试：

```powershell
npm test
```

修改 `database/curated/` 后重新校验并生成题库：

```powershell
node database/build-database.mjs
```
