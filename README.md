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
│  ├─ styles.css                # 页面样式
│  └─ vendor/katex/             # 本地数学公式引擎与字体
├─ database/                    # SQLite 与题库资料
│  ├─ ai_question_bank.sqlite3
│  ├─ ai_practice.sqlite3       # 首次练习时自动创建
│  ├─ curated/                  # 19 组逐场/专题整理数据
│  ├─ exports/                  # JSON、校验值与覆盖报告
│  └─ build-database.mjs        # 题库校验/重建工具
├─ tests/
│  ├─ local-server.test.mjs     # 本地服务与十题练习回归
│  └─ math-renderer.test.mjs    # 全题库公式解析回归
├─ scripts/                     # 本地第三方静态资源同步工具
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
- 公式由项目内置的 KaTeX 离线渲染；题干、选项和讲解中的公式也会自动补入提示区。
- 提示支持加粗文字内的公式，保留公式说明、条件与单位，并合并仅空格或定界符不同的重复公式。长公式可横向滚动。
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

## 维护与 GitHub 同步

每次维护完成后执行以下流程。修改题库源文件时，先运行 `npm run database:build`，将源 JSON、导出文件和正式题库一起提交；个人练习数据库已被忽略。

```powershell
npm test
git diff --check
git status --short
git add <本次修改的文件或目录>
git diff --cached --stat
git commit -m "说明本次修改"
git push origin main
npm run sync:check
```

`sync:check` 会先读取远端最新提交，然后检查未提交文件、未推送提交和落后提交。只有工作区干净且本地与上游一致才返回成功；网络失败不会报告已同步。Git 不在 PATH 时，可设置 `$env:GIT_EXECUTABLE` 为 `git.exe` 的完整路径。

GitHub Actions 会在每次 push 和 pull request 时分别运行 Windows、Linux 回归测试，包括全题库公式解析、提示完整性和十题练习流程。维护结束时同时检查推送结果和 Actions 状态；本地测试通过不代表已经上传。
