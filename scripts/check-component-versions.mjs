// @file check-component-versions.mjs
// @project PipkerOps
// @module delivery/versioning
// @description 验证组件版本及相对基准的版本递增。
// @logic 根据源码路径识别受影响组件，比较当前与基准的 SemVer。
// @dependencies Node.js, Git
// @index_tags version, ci, release
// @author holic512
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.argv[2];
const files = {
  ops: "package.json",
  agent: "agent/VERSION",
  skill: "skills/VERSION",
  scripts: "deploy/VERSION",
};
const parse = (text, component) => {
  const value = component === "ops" ? JSON.parse(text).version : text.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error(
      `${component}: expected stable MAJOR.MINOR.PATCH version, got ${value}`,
    );
  return value;
};
const versions = Object.fromEntries(
  Object.entries(files).map(([name, path]) => [
    name,
    parse(readFileSync(path, "utf8"), name),
  ]),
);
if (base && !/^0+$/.test(base)) {
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", base, "HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const affected = {
    scripts: changed.some(
      (path) =>
        (path.startsWith("deploy/") && path !== files.scripts) ||
        path === "scripts/package-release.sh",
    ),
    agent: changed.some(
      (path) =>
        (path.startsWith("agent/") &&
          path !== files.agent &&
          !path.endsWith(".md")) ||
        path === "scripts/package-agent.sh",
    ),
    skill: changed.some(
      (path) => path.startsWith("skills/") && path !== files.skill,
    ),
    ops: changed.some(
      (path) =>
        /^(src|prisma|public|config)\//.test(path) ||
        /^deploy\/resources\/(Dockerfile|runtime\.ts|entrypoint\.sh|health\.ts)$/.test(
          path,
        ) ||
        path === "scripts/bootstrap.ts" ||
        /^(compose\.yaml|package\.json|package-lock\.json|next\.config\.|Dockerfile)/.test(
          path,
        ),
    ),
  };
  for (const [name, path] of Object.entries(files)) {
    let oldText;
    try {
      oldText = execFileSync("git", ["show", `${base}:${path}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    } // First introduction of an independent version.
    const previous = parse(oldText, name);
    const before = previous.split(".").map(Number);
    const after = versions[name].split(".").map(Number);
    const comparison = after.findIndex((part, index) => part !== before[index]);
    if (comparison !== -1 && after[comparison] < before[comparison])
      throw new Error(
        `${name} version cannot decrease from ${previous} to ${versions[name]}`,
      );
    if (affected[name] && comparison === -1)
      throw new Error(
        `${name} files changed: increase ${path} above ${previous}`,
      );
  }
}
console.log(JSON.stringify(versions));
