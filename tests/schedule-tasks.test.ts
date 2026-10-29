import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("计划任务迁移保留旧任务，准确关联新任务，删除计划不删除任务", async () => {
  const pg = new PGlite();
  try {
    const root = new URL("../prisma/migrations/", import.meta.url);
    const migration = "202610300001_schedule_task_history";
    for (const name of (await readdir(root))
      .filter((n) => /^\d/.test(n) && n < migration)
      .sort())
      await pg.exec(
        await readFile(new URL(`${name}/migration.sql`, root), "utf8"),
      );
    await pg.exec(
      `INSERT INTO "Task" (id,type,"updatedAt") VALUES ('legacy','system.info',now())`,
    );
    await pg.exec(
      await readFile(new URL(`${migration}/migration.sql`, root), "utf8"),
    );
    const old = await pg.query<{ scheduleId: string | null }>(
      `SELECT "scheduleId" FROM "Task" WHERE id='legacy'`,
    );
    assert.equal(old.rows[0].scheduleId, null);
    await pg.exec(`
      INSERT INTO "Schedule" (id,name,cron,"taskType","updatedAt") VALUES
        ('plan-a','first','0 * * * *','system.info',now()),
        ('plan-b','second','0 * * * *','system.info',now());
      INSERT INTO "Task" (id,type,"scheduleId",source,"updatedAt") VALUES
        ('task-a','system.info','plan-a','CRON',now()),
        ('task-b','system.info','plan-b','CRON',now());
    `);
    const linked = await pg.query<{ id: string }>(
      `SELECT id FROM "Task" WHERE "scheduleId"='plan-a'`,
    );
    assert.deepEqual(
      linked.rows.map((r) => r.id),
      ["task-a"],
    );
    await pg.exec(`DELETE FROM "Schedule" WHERE id='plan-a'`);
    const retained = await pg.query<{
      scheduleId: string | null;
      source: string;
    }>(`SELECT "scheduleId",source FROM "Task" WHERE id='task-a'`);
    assert.deepEqual(retained.rows[0], { scheduleId: null, source: "CRON" });
    assert.equal((await pg.query(`SELECT id FROM "Task"`)).rows.length, 3);
  } finally {
    await pg.close();
  }
});
