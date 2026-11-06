import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { inspectDatabase } from "../scripts/check-database";

test("只读数据库检查区分空库、待迁移、失败迁移及完整迁移，不将可连接误报为可用", async () => {
  const db = new PGlite();
  const inspect = () =>
    inspectDatabase(
      (sql) => db.query<Record<string, unknown>>(sql),
      ["init", "upgrade"],
    );
  try {
    assert.match((await inspect()).reason, /尚未执行/);
    assert.equal((await inspect()).ready, false);
    await db.exec(`CREATE TABLE "User" (id text PRIMARY KEY);
      CREATE TABLE _prisma_migrations (migration_name text, finished_at timestamptz, rolled_back_at timestamptz);
      INSERT INTO _prisma_migrations VALUES ('init', now(), NULL);`);
    assert.deepEqual((await inspect()).pending, ["upgrade"]);
    await db.exec(
      "INSERT INTO _prisma_migrations VALUES ('upgrade', NULL, NULL)",
    );
    assert.match((await inspect()).reason, /失败或未完成/);
    await db.exec(
      "UPDATE _prisma_migrations SET rolled_back_at=now() WHERE migration_name='upgrade'",
    );
    assert.deepEqual((await inspect()).pending, ["upgrade"]);
    await db.exec(
      "INSERT INTO _prisma_migrations VALUES ('upgrade', now(), NULL)",
    );
    assert.equal((await inspect()).ready, true);
    await db.exec('DROP TABLE "User"');
    assert.equal((await inspect()).ready, false);
    assert.match((await inspect()).reason, /业务表缺失/);
    assert.equal(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM _prisma_migrations",
        )
      ).rows[0].count,
      3,
    );
  } finally {
    await db.close();
  }
});
