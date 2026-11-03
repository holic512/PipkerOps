/**
 * @file build-runtime.mjs
 * @project PipkerOps
 * @module delivery/runtime
 * @description 预编译容器入口，并将必要依赖和迁移资源合并至 Next.js standalone。
 * @logic 项目代码编译为共享 ESM；依赖追踪只复制 node_modules 文件，原生迁移引擎显式保留。
 * @dependencies Node.js 24, esbuild, @vercel/nft, generated Prisma client, Next.js standalone
 * @index_tags build, standalone, docker, prisma
 * @author holic512
 */
import { build } from "esbuild";
import { nodeFileTrace } from "@vercel/nft";
import { access, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const standalone = join(root, ".next/standalone");
await access(join(standalone, "server.js"));
const temporary = await mkdtemp(join(root, ".next/runtime-"));
try {
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: {
      "runtime/gateway": "src/server/gateway.ts",
      "runtime/worker": "src/server/worker.ts",
      "runtime/runtime": "deploy/resources/runtime.ts",
      "runtime/health": "deploy/resources/health.ts",
      "runtime/bootstrap": "scripts/bootstrap.ts",
      "prisma.config": "prisma.config.ts",
    },
    outdir: temporary,
    outExtension: { ".js": ".mjs" },
    chunkNames: "runtime/chunks/[name]-[hash]",
    bundle: true,
    packages: "external",
    platform: "node",
    target: "node24",
    format: "esm",
    splitting: true,
    minify: true,
    metafile: true,
  });
  const compiled = Object.keys(metafile.outputs);
  const { fileList } = await nodeFileTrace(
    [...compiled, "node_modules/prisma/build/index.js"],
    { base: root, processCwd: root, exportsOnly: true },
  );
  const engines = "node_modules/@prisma/engines";
  const binaries = (await readdir(join(root, engines))).filter((name) =>
    name.startsWith("schema-engine-"),
  );
  if (!binaries.length)
    throw new Error("Prisma Schema Engine 缺失，请重新安装构建依赖。");
  for (const name of binaries) fileList.add(join(engines, name));

  // 配置读取及备份路径也可能被追踪到；只接收依赖目录中的文件。
  for (const file of fileList) {
    if (!file.startsWith("node_modules/")) continue;
    const target = join(standalone, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, file), target, { dereference: true });
  }
  await rm(join(standalone, "runtime"), { recursive: true, force: true });
  for (const file of compiled) {
    const target = join(standalone, relative(temporary, resolve(root, file)));
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(root, file), target);
  }
  await mkdir(join(standalone, "prisma"), { recursive: true });
  await cp(
    join(root, "prisma/schema.prisma"),
    join(standalone, "prisma/schema.prisma"),
    {
      recursive: true,
    },
  );
  await cp(
    join(root, "prisma/migrations"),
    join(standalone, "prisma/migrations"),
    {
      recursive: true,
    },
  );
  console.log(
    `Standalone 已补齐 JavaScript 入口、迁移资源和 ${binaries.length} 个 Schema Engine。`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
