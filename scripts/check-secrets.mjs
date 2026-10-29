import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
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
    const u = new URL(local[key]);
    if (u.password) needles.push(decodeURIComponent(u.password));
    if (!["localhost", "127.0.0.1", "postgres", "redis"].includes(u.hostname))
      needles.push(u.hostname);
  }
}
if (local.BOOTSTRAP_PASSWORD) needles.push(local.BOOTSTRAP_PASSWORD);
const files = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const failures = [];
for (const file of files) {
  if (
    (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith(".example")) ||
    /(^|\/)(\.data|secrets|certs|node_modules|\.next)\//.test(file) ||
    /\.(key|pem|p12|pfx|dump|backup)$/.test(file)
  ) {
    failures.push(file);
    continue;
  }
  const data = execFileSync("git", ["show", `:${file}`]);
  const text = data.toString("utf8");
  if (
    needles.some((n) => n.length > 8 && text.includes(n)) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /(?:postgres(?:ql)?|redis(?:s)?):\/\/[^\s"']*:[a-f0-9]{40,}@/i.test(text)
  )
    failures.push(file);
}
if (failures.length) {
  console.error(
    "Secret check rejected staged files:",
    [...new Set(failures)].join(", "),
  );
  process.exit(1);
}
console.log(
  `Secret check passed: ${files.length} staged files; no local credentials or private keys`,
);
