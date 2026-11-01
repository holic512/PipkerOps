/**
 * @file runtime.ts
 * @project PipkerOps
 * @module deployment/runtime
 * @description 容器角色启动、外部后端预检及系统备份的离线恢复入口。
 * @logic 配置由 Node env-file 载入；预检成功后启动角色，维护命令不输出连接凭据。
 * @dependencies Node.js, Prisma, Redis, PostgreSQL 17 client
 * @index_tags deployment, config, init, backup
 * @author holic512
 */
import { createClient } from "redis";
import { spawn } from "node:child_process";
import { db } from "../src/lib/db";
import { restoreBackup } from "../src/lib/backup-storage";
import { z } from "zod";
import { validateRuntime } from "../src/lib/config";

const role = process.argv[2] ?? "web";
let stage = "配置校验";
try {
  const roles = ["web", "gateway", "worker", "init", "restore"];
  if (!roles.includes(role)) throw new Error("未知容器角色");
  process.env.PIPKEROPS_ROLE = role;
  validateRuntime(role === "init");
  stage = "PostgreSQL/Redis 连接预检";
  await preflight();
  if (role === "init") {
    for (const [label, args] of [
      [
        "数据库迁移",
        ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      ],
      ["管理员初始化", ["--import", "tsx", "scripts/bootstrap.ts"]],
      ["PKI 初始化", ["--import", "tsx", "scripts/pki.ts"]],
    ] as const) {
      stage = label;
      await run(process.execPath, [...args], false);
      console.log(`${label}完成`);
    }
  } else if (role === "restore") {
    stage = "系统备份恢复";
    const id = z.uuid().parse(process.argv[3]);
    if (process.argv[4] !== "--confirm-empty-target")
      throw new Error("需要显式确认空目标");
    await restoreBackup(id);
    console.log("恢复完成；请核对业务数据与 UNKNOWN 任务后启动应用。");
  } else {
    stage = `${role} 运行`;
    const args =
      role === "web"
        ? ["server.js"]
        : ["--import", "tsx", `src/server/${role}.ts`];
    await run(process.execPath, args, true);
  }
} catch (error) {
  // 驱动和 Prisma 的异常可能携带连接信息；只展示已知配置错误或失败阶段。
  console.error(
    stage === "配置校验"
      ? (error as Error).message
      : `${stage}失败，请检查配置、后端可达性和权限。`,
  );
  process.exitCode = 1;
}

async function preflight() {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  client.on("error", () => {});
  try {
    await db().$queryRaw`SELECT 1`;
    await client.connect();
    await client.ping();
  } finally {
    if (client.isOpen) client.destroy();
    await db().$disconnect();
  }
}

function run(
  command: string,
  args: string[],
  inherit: boolean,
  env = process.env,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: inherit
        ? [
            "inherit",
            "inherit",
            ["web", "gateway", "worker"].includes(role) ? "inherit" : "pipe",
          ]
        : ["ignore", "ignore", "pipe"],
    });
    // 后端命令 stderr 不透传，避免 CLI 输出带密码的 URL。
    child.stderr?.resume();
    let stopping = false;
    const terminate = () => {
      stopping = true;
      child.kill("SIGTERM");
    };
    process.on("SIGTERM", terminate);
    process.on("SIGINT", terminate);
    child.on("error", reject);
    child.on("close", (code) => {
      process.off("SIGTERM", terminate);
      process.off("SIGINT", terminate);
      if (code === 0 || stopping) resolve();
      else reject(new Error("子进程失败"));
    });
  });
}
