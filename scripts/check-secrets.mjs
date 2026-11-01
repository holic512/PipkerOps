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
const local = existsSync(".env")
  ? Object.fromEntries(
      readFileSync(".env", "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, "")];
        }),
    )
  : {};
const needles = [];
for (const key of ["DATABASE_URL", "REDIS_URL"]) {
  if (local[key]) {
    try {
      const u = new URL(local[key]);
      if (u.password) needles.push(decodeURIComponent(u.password));
      if (!["localhost", "127.0.0.1", "postgres", "redis"].includes(u.hostname))
        needles.push(u.hostname);
    } catch {
      console.error(
        `Secret check could not parse local ${key}; value omitted.`,
      );
      process.exit(1);
    }
  }
}
if (local.BOOTSTRAP_PASSWORD) needles.push(local.BOOTSTRAP_PASSWORD);
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
