import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "..");
const git = process.env.GIT_EXECUTABLE || "git";
function run(...args) {
  return execFileSync(git, args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

try {
  // Refresh before reporting synchronization; stale tracking refs are not proof.
  run("fetch", "origin");
  const status = run("status", "--porcelain");
  const upstream = run("rev-parse", "--abbrev-ref", "@{upstream}");
  const [ahead, behind] = run("rev-list", "--left-right", "--count", "HEAD...@{upstream}").split(/\s+/).map(Number);
  console.log(`上游：${upstream}；未推送提交：${ahead}；落后提交：${behind}`);
  if (status) console.log(`尚未提交的文件：\n${status}`);
  if (status || ahead || behind) process.exitCode = 1;
  else console.log("工作区干净，本地提交已与远端同步。");
} catch (error) {
  console.error("同步检查失败：请检查 Git 安装、网络、登录状态和分支上游配置。");
  console.error(error.message);
  process.exitCode = 2;
}
