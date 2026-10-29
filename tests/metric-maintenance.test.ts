import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

type Summary = {
  skipped: boolean;
  reason?: string;
  aggregatedHours: number;
  aggregatedFrom: string;
  aggregatedThrough: string;
  blockedPartitions: string[];
};

test("隔离 PostgreSQL：指标维护水位、停机补偿及分区报告", async (t) => {
  const pg = new PGlite();
  const maintain = async (raw = 30, hourly = 365) =>
    (
      await pg.query<{ result: Summary }>(
        "SELECT pipkerops_maintain_metrics($1,$2) AS result",
        [raw, hourly],
      )
    ).rows[0].result;
  const reset = () =>
    pg.exec(`
    TRUNCATE "MetricSample", "MetricHourly", "MetricMaintenanceState";
  `);
  try {
    for (const migration of [
      "202610280001_init",
      "202610290001_certificate_rotation",
      "202610290002_schedule_authorization",
      "202610290003_probe_authorization",
      "202610290004_task_key_identity",
      "202610290005_metric_maintenance",
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
    await pg.exec(
      "INSERT INTO \"Node\" (id,name,\"updatedAt\") VALUES ('n','test',now())",
    );

    await t.test("首次聚合持久水位，同日相同参数快速跳过", async () => {
      await reset();
      await pg.exec(`
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('first','n',date_trunc('hour',now())-interval '2 hours',20,40),
               ('first-old','n',date_trunc('hour',now())-interval '45 days',30,50);
        SET lock_timeout='2s';
      `);
      const first = await maintain();
      assert.equal(first.skipped, false);
      assert.equal(
        first.aggregatedHours,
        2,
        "first run must summarize older-than-raw-retention rows",
      );
      const state = await pg.query<{
        aggregatedThrough: Date;
        lastSucceededAt: Date;
        summary: Summary;
      }>('SELECT * FROM "MetricMaintenanceState"');
      assert.equal(
        new Date(state.rows[0].aggregatedThrough).getTime(),
        new Date(first.aggregatedThrough).getTime(),
      );
      assert.ok(state.rows[0].lastSucceededAt);
      assert.deepEqual(state.rows[0].summary, first);
      assert.equal(
        (await maintain()).reason,
        "maintenance already succeeded today",
      );
      assert.equal(
        (await pg.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0]
          .lock_timeout,
        "2s",
      );
      assert.equal(
        (await maintain(31)).skipped,
        false,
        "retention changes must not be skipped",
      );
      await assert.rejects(
        pg.exec("INSERT INTO \"MetricMaintenanceState\" (id) VALUES ('other')"),
      );
    });

    await t.test(
      "水位推进且48小时回看吸收迟到样本，不重扫更旧小时",
      async () => {
        await reset();
        await pg.exec(`
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('old','n',date_trunc('hour',now())-interval '70 hours',10,20),
               ('recent','n',date_trunc('hour',now())-interval '4 hours',20,30);
      `);
        await maintain();
        await pg.exec(`
        UPDATE "MetricMaintenanceState" SET "lastSucceededAt"=now()-interval '1 day',
          "aggregatedThrough"=date_trunc('hour',now())-interval '1 hour';
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('old-late','n',date_trunc('hour',now())-interval '70 hours'+interval '1 minute',90,90),
               ('recent-late','n',date_trunc('hour',now())-interval '4 hours'+interval '1 minute',40,50),
               ('new-hour','n',date_trunc('hour',now())-interval '1 hour',60,70);
      `);
        const result = await maintain();
        assert.equal(result.skipped, false);
        const rows = (
          await pg.query<{ age: number; sampleCount: number; cpuAvg: number }>(`
        SELECT extract(epoch FROM date_trunc('hour',now())-"bucketAt")/3600 AS age,
          "sampleCount","cpuAvg" FROM "MetricHourly" ORDER BY "bucketAt"
      `)
        ).rows;
        assert.deepEqual(
          rows.map((r) => [Number(r.age), r.sampleCount, r.cpuAvg]),
          [
            [70, 1, 10],
            [4, 2, 30],
            [1, 1, 60],
          ],
        );
        const current = (
          await pg.query<{ hour: Date }>(
            "SELECT date_trunc('hour',now()) AS hour",
          )
        ).rows[0].hour;
        assert.equal(
          new Date(result.aggregatedThrough).getTime(),
          new Date(current).getTime(),
        );
      },
    );

    await t.test(
      "短原始保留期不让孤立迟到样本覆盖已清理小时的完整摘要",
      async () => {
        await reset();
        await pg.exec(`
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('short-1','n',date_trunc('hour',now())-interval '36 hours',20,30),
               ('short-2','n',date_trunc('hour',now())-interval '36 hours'+interval '1 minute',40,50);
      `);
        await maintain(1);
        await pg.exec(`
        UPDATE "MetricMaintenanceState" SET "lastSucceededAt"=now()-interval '1 day';
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('short-late','n',date_trunc('hour',now())-interval '36 hours'+interval '2 minutes',90,90);
      `);
        await maintain(1);
        assert.deepEqual(
          (await pg.query('SELECT "sampleCount","cpuAvg" FROM "MetricHourly"'))
            .rows,
          [{ sampleCount: 2, cpuAvg: 30 }],
        );
        assert.equal(
          (
            await pg.query<{ n: number }>(
              'SELECT count(*)::integer AS n FROM "MetricSample"',
            )
          ).rows[0].n,
          0,
        );
      },
    );

    await t.test(">30天停机先摘要旧分区及DEFAULT，再清理原始记录", async () => {
      await reset();
      await pg.exec(`
        DO $$ DECLARE start_at timestamptz := date_trunc('month',now()-interval '3 months');
        BEGIN
          EXECUTE format('CREATE TABLE %I PARTITION OF "MetricSample" FOR VALUES FROM (%L) TO (%L)',
            'MetricSample_'||to_char(start_at,'YYYYMM'),start_at,start_at+interval '1 month');
        END $$;
        INSERT INTO "MetricMaintenanceState" (id,"aggregatedThrough","lastSucceededAt")
        VALUES ('metrics',date_trunc('hour',now())-interval '120 days',now()-interval '120 days');
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('expired-month','n',date_trunc('month',now()-interval '3 months')+interval '1 day',12,22),
               ('expired-default','n',date_trunc('hour',now())-interval '45 days',34,44),
               ('outside-hourly-retention','n',date_trunc('hour',now())-interval '400 days',99,99);
      `);
      const result = await maintain();
      assert.equal(result.aggregatedHours, 2);
      const aggregates = (
        await pg.query<{ cpuAvg: number }>(
          'SELECT "cpuAvg" FROM "MetricHourly" ORDER BY "bucketAt"',
        )
      ).rows;
      assert.deepEqual(
        aggregates.map((r) => r.cpuAvg),
        [12, 34],
      );
      assert.equal(
        (
          await pg.query<{ n: number }>(
            'SELECT count(*)::integer AS n FROM "MetricSample"',
          )
        ).rows[0].n,
        0,
      );
      const dropped = (
        await pg.query<{ table_name: string | null }>(`
        SELECT to_regclass(format('%I','MetricSample_'||to_char(now()-interval '3 months','YYYYMM')))::text AS table_name
      `)
      ).rows[0];
      assert.equal(dropped.table_name, null);
    });

    await t.test("聚合失败不清理原始数据、不推进水位", async () => {
      await reset();
      await pg.exec(`
        INSERT INTO "MetricMaintenanceState" (id,"aggregatedThrough","lastSucceededAt")
        VALUES ('metrics',date_trunc('hour',now())-interval '80 days',now()-interval '80 days');
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('aggregate-failure','n',date_trunc('hour',now())-interval '45 days',25,50);
        CREATE FUNCTION test_fail_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture aggregate failure'; END $$;
        CREATE TRIGGER test_fail_aggregate BEFORE INSERT ON "MetricHourly"
          FOR EACH ROW EXECUTE FUNCTION test_fail_aggregate();
      `);
      const before = (await pg.query('SELECT * FROM "MetricMaintenanceState"'))
        .rows;
      await assert.rejects(maintain(), /fixture aggregate failure/);
      assert.deepEqual(
        (await pg.query('SELECT * FROM "MetricMaintenanceState"')).rows,
        before,
      );
      assert.equal(
        (
          await pg.query<{ n: number }>(
            'SELECT count(*)::integer AS n FROM "MetricSample"',
          )
        ).rows[0].n,
        1,
      );
      await pg.exec(
        'DROP TRIGGER test_fail_aggregate ON "MetricHourly"; DROP FUNCTION test_fail_aggregate()',
      );
    });

    await t.test("DEFAULT阻挡新分区时保留数据并返回持久摘要", async () => {
      await reset();
      await pg.exec(`
        DO $$ BEGIN
          EXECUTE format('DROP TABLE %I','MetricSample_'||to_char(now()+interval '2 months','YYYYMM'));
        END $$;
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('future-default','n',date_trunc('month',now()+interval '2 months')+interval '1 day',10,20);
      `);
      const expected = (
        await pg.query<{ name: string }>(
          "SELECT 'MetricSample_'||to_char(now()+interval '2 months','YYYYMM') AS name",
        )
      ).rows[0].name;
      const result = await maintain();
      assert.deepEqual(result.blockedPartitions, [expected]);
      assert.equal(result.skipped, false);
      const state = (
        await pg.query<{ summary: Summary }>(
          'SELECT summary FROM "MetricMaintenanceState"',
        )
      ).rows[0];
      assert.deepEqual(state.summary.blockedPartitions, [expected]);
      assert.equal(
        (
          await pg.query<{ n: number }>(
            'SELECT count(*)::integer AS n FROM "MetricSample_default"',
          )
        ).rows[0].n,
        1,
      );
      const retried = await maintain();
      assert.equal(
        retried.skipped,
        false,
        "blocked partition checks must be retried within the same day",
      );
      assert.deepEqual(retried.blockedPartitions, [expected]);
      await pg.exec(
        "DELETE FROM \"MetricSample_default\" WHERE id='future-default'",
      );
      const repaired = await maintain();
      assert.deepEqual(repaired.blockedPartitions, []);
      assert.equal((await maintain()).skipped, true);
    });
  } finally {
    await pg.close();
  }
});
