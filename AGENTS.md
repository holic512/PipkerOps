<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 组件版本

每次提交前按实际影响维护独立版本：Ops 为 `package.json`（同时同步 `package-lock.json`），Agent 为 `agent/VERSION`，PipkerOpsSkill 为 `skills/VERSION`。受影响组件通常递增补丁号；大版本或次版本依用户要求调整。跨组件或共享接口修改时评估并递增所有受影响组件的版本，不修改无关组件版本。
