import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { metricHistoryQuery } from "../src/lib/services/nodes";

type Point = {
  recordedAt?: Date;
  bucketAt?: Date;
  sampleCount: number;
  cpuPercent?: number;
  cpuAvg?: number;
  cpuMax: number;
  memoryPercent?: number;
  memoryAvg?: number;
  memoryMax: number;
};

test("隔离 PostgreSQL：迁移、历史窗口聚合及原始尾部去重", async (t) => {
  const pg = new PGlite();
  try {
    for (const migration of [
      "202610280001_init",
      "202610290001_certificate_rotation",
      "202610290002_schedule_authorization",
      "202610290003_probe_authorization",
      "202610290004_task_key_identity",
    ])
      await pg.exec(
        await readFile(
          new URL(
            `../prisma/migrations/${migration}/migration.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await pg.exec(`
      INSERT INTO "User" (id,email,"passwordHash","displayName","updatedAt")
      VALUES ('user','test@example.invalid','unused','test',now());
      INSERT INTO "Node" (id,name,"updatedAt") VALUES
      ('short','short',now()), ('long','long',now()), ('other','other',now());
    `);

    await t.test("删除 API Key 保留排队任务的原身份", async () => {
      await pg.exec(`
        INSERT INTO "ApiKey" (id,name,"keyHash","keyPrefix","userId")
        VALUES ('deleted-key','test','hash','prefix','user');
        INSERT INTO "Task" (id,type,"apiKeyId","updatedAt")
        VALUES ('queued','system.info','deleted-key',now());
        DELETE FROM "ApiKey" WHERE id='deleted-key';
      `);
      const result = await pg.query<{ apiKeyId: string }>(
        'SELECT "apiKeyId" FROM "Task" WHERE id=\'queued\'',
      );
      assert.equal(result.rows[0].apiKeyId, "deleted-key");
    });

    const now = new Date("2026-10-29T12:07:23.000Z");
    const end = now.toISOString();
    await pg.query(
      `INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent",payload)
       SELECT 'short-' || n, 'short', $1::timestamptz - interval '48 hours' + n * interval '15 seconds',
              n % 100, 40, '{"private-detail":"must-not-return"}'::jsonb
       FROM generate_series(0,11519) AS n`,
      [end],
    );
    // A second node and the exact upper bound must not influence this window.
    await pg.query(
      `INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
       VALUES ('wrong-node','other',$1::timestamptz - interval '1 minute',999,999),
              ('future','short',$1::timestamptz,999,999)`,
      [end],
    );
    for (const hours of [1, 24, 48]) {
      await t.test(`${hours} 小时每15秒样本完整覆盖且最多1440点`, async () => {
        const history = metricHistoryQuery("short", hours, now);
        const result = await pg.query<Point>(
          history.query.text,
          history.query.values,
        );
        const rows = result.rows;
        assert.equal(history.resolution, "raw");
        assert.ok(rows.length > 0 && rows.length <= 1440);
        assert.equal(
          rows.reduce((n, p) => n + p.sampleCount, 0),
          hours * 240,
        );
        const first = new Date(rows[0].recordedAt!).getTime();
        const last = new Date(rows.at(-1)!.recordedAt!).getTime();
        const start = now.getTime() - hours * 3600000;
        assert.ok(
          first >= start && first - start < history.bucketSeconds * 1000,
        );
        assert.ok(now.getTime() - last <= history.bucketSeconds * 1000 + 15000);
        assert.ok(rows.every((p) => p.cpuMax < 100 && p.memoryPercent === 40));
        assert.ok(rows.every((p) => !("payload" in p) && !("id" in p)));
      });
    }

    await t.test(
      "小时历史优先原始桶、补齐未聚合尾部且不同桶不双计数",
      async () => {
        await pg.exec(
          `INSERT INTO "MetricHourly" ("nodeId","bucketAt","sampleCount","cpuAvg","cpuMax","memoryAvg","memoryMax")
         VALUES ('long','2026-10-26T12:00:00Z',240,11,12,21,22),
                ('long','2026-10-28T10:00:00Z',240,99,99,99,99),
                ('long','2026-10-26T11:00:00Z',240,88,88,88,88);
         INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
         VALUES ('overlap-1','long','2026-10-28T10:10:00Z',20,30),
                ('overlap-late','long','2026-10-28T10:20:00Z',40,50),
                ('tail','long','2026-10-29T12:00:00Z',60,70);`,
        );
        const history = metricHistoryQuery("long", 72, now);
        const result = await pg.query<Point>(
          history.query.text,
          history.query.values,
        );
        assert.equal(history.resolution, "hour");
        assert.equal(result.rows.length, 3);
        assert.equal(
          new Set(result.rows.map((p) => String(p.bucketAt))).size,
          3,
        );
        assert.deepEqual(
          result.rows.map((p) => [
            p.sampleCount,
            p.cpuAvg,
            p.cpuMax,
            p.memoryAvg,
          ]),
          [
            [240, 11, 12, 21],
            [2, 30, 40, 40],
            [1, 60, 60, 70],
          ],
        );
      },
    );

    await t.test("空窗口与不合法时间范围", async () => {
      const history = metricHistoryQuery("missing", 24, now);
      const result = await pg.query(history.query.text, history.query.values);
      assert.deepEqual(result.rows, []);
      for (const hours of [0, 8761, Number.NaN, Number.POSITIVE_INFINITY])
        assert.throws(() => metricHistoryQuery("short", hours, now));
    });
  } finally {
    await pg.close();
  }
});
