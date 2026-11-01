import { parseEnv } from "node:util";
// @file check-secrets.mjs
// @project PipkerOps
// @module tooling/secrets
// @description 检查暂存文件或当前工作树中的配置、凭据和私钥泄漏。
// @logic 默认检查暂存变更；--all 检查受版本管理和未忽略的新文件；仅报告文件名。
// @dependencies Node.js, Git
// @index_tags security, ci, secrets
// @author holic512
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--all")) {
  console.error("Usage: node scripts/check-secrets.mjs [--all]");
  process.exit(2);
}
const all = args[0] === "--all";
// Reads local secrets only for comparison; never prints their values.
const local = existsSync("config/app.conf")
  ? parseEnv(readFileSync("config/app.conf", "utf8"))
  : {};
const needles = [
  local.DATABASE_PASSWORD,
  local.REDIS_PASSWORD,
  local.BOOTSTRAP_PASSWORD,
].filter(Boolean);
const files = execFileSync(
  "git",
  all
    ? ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]
    : ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const failures = [];
for (const file of files) {
  if (all && !existsSync(file)) continue;
  if (
    (/(^|\/)[^/]*\.env($|\.)/.test(file) && !file.endsWith(".example")) ||
    /(^|\/)(\.data|secrets|certs|node_modules|\.next|\.idea)\//.test(file) ||
    /^deploy\/(config|data)\//.test(file) ||
    (file.startsWith("config/") && !file.endsWith(".example")) ||
    /\.(key|pem|p12|pfx|dump|backup)$/.test(file)
  ) {
    failures.push(file);
    continue;
  }
  const data = all
    ? readFileSync(file)
    : execFileSync("git", ["show", `:${file}`]);
  const text = data.toString("utf8");
  if (
    needles.some((n) => n.length > 8 && text.includes(n)) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /(?:postgres(?:ql)?|redis(?:s)?):\/\/[^\s"']*:[a-f0-9]{40,}@/i.test(text) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/.test(text)
  )
    failures.push(file);
}
if (failures.length) {
  console.error(
    `Secret check rejected ${all ? "worktree" : "staged"} files:`,
    [...new Set(failures)].join(", "),
  );
  process.exit(1);
}
console.log(
  `Secret check passed: ${files.length} ${all ? "worktree" : "staged"} files; no detected credentials or private keys`,
);
