/**
 * @file package-release-manifest.mjs
 * @project PipkerOps
 * @module release/manifest
 * @description 为同批次 Ops、Agent 与部署脚本生成带摘要的更新清单。
 * @logic 独立版本决定文件名，制品存在才生成清单，更新端不猜测下载地址。
 * @dependencies Node.js filesystem, crypto
 * @index_tags release, versions, sha256
 * @author holic512
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const directory = process.argv[2];
const versions = {
  ops: JSON.parse(readFileSync("package.json", "utf8")).version,
  agent: readFileSync("agent/VERSION", "utf8").trim(),
  scripts: readFileSync("deploy/VERSION", "utf8").trim(),
  skill: readFileSync("skills/VERSION", "utf8").trim(),
};
const names = {
  scripts: `pipkerops-deploy-${versions.scripts}.tar.gz`,
  "agent-amd64": `pipker-agent-${versions.agent}-linux-amd64`,
  "agent-arm64": `pipker-agent-${versions.agent}-linux-arm64`,
};
const assets = Object.fromEntries(
  Object.entries(names).map(([key, name]) => [
    key,
    {
      name,
      sha256: createHash("sha256")
        .update(readFileSync(join(directory, name)))
        .digest("hex"),
    },
  ]),
);
writeFileSync(
  join(directory, "release-manifest.json"),
  JSON.stringify({ format: 1, protocolVersion: 1, versions, assets }, null, 2) +
    "\n",
);
