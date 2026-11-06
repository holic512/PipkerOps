/** 只读检查实际连接目标、业务表及迁移状态，不输出连接串和凭据。 */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { backendUrl } from "../src/lib/config";

type Query = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

export async function inspectDatabase(query: Query, expected: string[]) {
  const {
    rows: [identity],
  } = await query(`
    SELECT current_database() AS database,
      to_regclass('public."User"') IS NOT NULL AS "hasUsers",
      to_regclass('public._prisma_migrations') IS NOT NULL AS "hasMigrations"
  `);
  if (!identity.hasMigrations)
    return {
      database: identity.database,
      ready: false,
      reason: "尚未执行数据库迁移，请运行 npm run db:init",
    };
  const { rows } = await query(`
    SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations
  `);
  const failed = rows.some((row) => !row.finished_at && !row.rolled_back_at);
  const applied = new Set(
    rows
      .filter((row) => row.finished_at && !row.rolled_back_at)
      .map((row) => row.migration_name),
  );
  const pending = expected.filter((name) => !applied.has(name));
  const ready = !!identity.hasUsers && !failed && pending.length === 0;
  return {
    database: identity.database,
    ready,
    applied: applied.size,
    pending,
    reason: failed
      ? "存在失败或未完成的迁移，请先检查迁移状态；不要重置数据库"
      : !identity.hasUsers
        ? "业务表缺失，请检查迁移历史与数据库结构"
        : pending.length
          ? "存在待执行迁移，请运行 npm run db:init"
          : "数据库连接及迁移正常",
  };
}

async function main() {
  let client: Client | undefined;
  try {
    const expected = (
      await readdir(new URL("../prisma/migrations/", import.meta.url), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    client = new Client({
      connectionString: backendUrl("DATABASE_URL"),
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    await client.connect();
    const status = await inspectDatabase((sql) => client!.query(sql), expected);
    console.log(JSON.stringify(status, null, 2));
    if (!status.ready) process.exitCode = 1;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const hints: Record<string, string> = {
      "3D000":
        "目标数据库不存在，请先创建 config/app.conf 指定的开发库，再运行 npm run db:init",
      "28P01": "数据库账号或密码不正确",
      "42501": "数据库权限不足",
      ECONNREFUSED:
        "数据库端口拒绝连接，请检查服务及 DATABASE_HOST/DATABASE_PORT",
      ETIMEDOUT: "数据库连接超时，请检查网络及防火墙",
      ENOTFOUND: "数据库地址无法解析，请检查 DATABASE_HOST",
    };
    console.error(
      hints[code ?? ""] ??
        "数据库检查失败，请检查 config/app.conf 的数据库配置、网络及 TLS 设置",
    );
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => {});
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
