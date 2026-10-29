import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { detailHistoryQuery } from "../src/lib/services/metric-details";

test("设备长期SQL：加权速率、身份缺口、水位、清理与停机补偿", async (t) => {
  const pg = new PGlite();
  try {
    const migrations = new URL("../prisma/migrations/", import.meta.url);
    for (const name of (await readdir(migrations))
      .filter((n) => /^\d/.test(n))
      .sort())
      await pg.exec(
        await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"),
      );
    await pg.exec(
      `INSERT INTO "Node" (id,name,"updatedAt") VALUES ('n','node',now()),('other','other',now())`,
    );
    const base = new Date(
      (
        await pg.query<{ at: Date }>(
          `SELECT date_trunc('hour',now())-interval '2 hours' AS at`,
        )
      ).rows[0].at,
    );
    const insert = async (
      id: string,
      seconds: number,
      received: number | string,
      identity: string | undefined = "generation-a",
      disk?: number,
    ) => {
      await pg.query(
        `INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent") VALUES ($1,'n',$2,$3::jsonb,0,0)`,
        [
          id,
          new Date(base.getTime() + seconds * 1000),
          JSON.stringify({
            disk:
              disk === undefined
                ? []
                : [{ mountpoint: "/", usedPercent: disk }],
            network: [{ name: "eth0", bytesRecv: received }],
            io: { sda: { readBytes: received } },
            deviceIdentity: identity
              ? { network: { eth0: identity }, io: { sda: identity } }
              : {},
          }),
        ],
      );
    };
    const hours = async () =>
      (
        await pg.query<{
          kind: string;
          direction: string;
          sampleCount: number;
          gapCount: number;
          numerator: number;
          denominator: number;
        }>(`SELECT * FROM pipkerops_device_hours($1,$2,'n')`, [
          base,
          new Date(base.getTime() + 3600000),
        ])
      ).rows;
    const history = async (kind: "disk" | "network" | "io") => {
      const q = detailHistoryQuery(
        "n",
        kind,
        168,
        undefined,
        new Date(base.getTime() + 7200000),
      );
      return (
        await pg.query<{
          device: string;
          points: { value: number | null; direction: string }[];
        }>(q.query.text, q.query.values)
      ).rows[0];
    };
    await t.test("不同间隔按字节/有效秒数加权，容量按样本均值", async () => {
      await insert("baseline", -10, 0, "generation-a", 10);
      await insert("first", 0, 100, "generation-a", 20);
      await insert("second", 10, 200, "generation-a", 40);
      await insert("third", 30, 600, "generation-a", 60);
      const rows = await hours();
      for (const kind of ["network", "io"]) {
        const rate = rows.find(
          (r) => r.kind === kind && ["接收", "读取"].includes(r.direction),
        )!;
        assert.equal(rate.sampleCount, 3);
        assert.equal(rate.gapCount, 0);
        assert.equal(rate.numerator / rate.denominator, 15);
      }
      const capacity = rows.find((r) => r.kind === "disk")!;
      assert.equal(capacity.numerator / capacity.denominator, 40);
    });
    await t.test(
      "重置、同名替换且计数增加、断采样、无身份及非法计数均保留缺口",
      async () => {
        await insert("reset", 40, 1);
        await insert("replacement", 50, 10000, "generation-b");
        await insert("recovered", 60, 10100, "generation-b");
        await insert("gap", 200, 20000, "generation-b");
        await insert("gap-after", 210, 20100, "generation-b");
        await insert("legacy", 300, 20200, "");
        await insert("malformed", 400, "NaN", "");
        const rate = (await hours()).find(
          (r) => r.kind === "network" && r.direction === "接收",
        )!;
        assert.equal(rate.gapCount, 5);
        assert.equal(rate.sampleCount, 10);
        assert.deepEqual(
          (await history("network")).points
            .filter((p) => p.direction === "接收")
            .map((p) => p.value),
          [null, null],
        );
      },
    );
    await t.test(
      "维护持久化设备水位，长查询合并原始尾部且不双计数",
      async () => {
        const before = await history("disk");
        assert.equal(before.points.at(-1)?.value, 40);
        await pg.exec(`SELECT pipkerops_maintain_metrics()`);
        assert.ok(
          (
            await pg.query<{ deviceAggregatedThrough: Date | null }>(
              `SELECT "deviceAggregatedThrough" FROM "MetricMaintenanceState"`,
            )
          ).rows[0].deviceAggregatedThrough,
        );
        assert.deepEqual(await history("disk"), before);
        const state = (
          await pg.query<{ result: { skipped: boolean } }>(
            `SELECT pipkerops_maintain_metrics() AS result`,
          )
        ).rows[0].result;
        assert.equal(state.skipped, true);
        await insert("late", 15, 250, "generation-a", 80);
        await pg.exec(
          `UPDATE "MetricMaintenanceState" SET "lastSucceededAt"=now()-interval '1 day'; SELECT pipkerops_maintain_metrics()`,
        );
        assert.equal((await history("disk")).points.at(-1)?.value, 50);
      },
    );
    await t.test(
      "超过原始保留期停机先聚合再清理，同时移除过期设备小时",
      async () => {
        await pg.exec(`UPDATE "MetricMaintenanceState" SET "aggregatedThrough"=now()-interval '90 days',"deviceAggregatedThrough"=now()-interval '90 days',"lastSucceededAt"=now()-interval '90 days',summary=jsonb_build_object('rawCutoff',now()-interval '120 days');
      INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent") VALUES ('outage','n',date_trunc('hour',now())-interval '70 days','{"disk":[{"mountpoint":"/archive","usedPercent":75}]}',0,0);
      INSERT INTO "MetricDeviceHourly" VALUES ('n','disk','/expired','使用率',now()-interval '400 days',1,0,25,1);
      SELECT pipkerops_maintain_metrics();`);
        assert.equal(
          (await pg.query(`SELECT * FROM "MetricSample" WHERE id='outage'`))
            .rows.length,
          0,
        );
        assert.equal(
          (
            await pg.query<{ numerator: number }>(
              `SELECT numerator FROM "MetricDeviceHourly" WHERE device='/archive'`,
            )
          ).rows[0].numerator,
          75,
        );
        assert.equal(
          (
            await pg.query(
              `SELECT * FROM "MetricDeviceHourly" WHERE device='/expired'`,
            )
          ).rows.length,
          0,
        );
      },
    );
    await t.test(
      "超过一年查询设备隔离与有界分桶，清理后的旧小时不被孤立迟到覆盖",
      async () => {
        const q = detailHistoryQuery("n", "disk", 8760, "/archive", new Date());
        const result = (
          await pg.query<{
            device: string;
            points: { value: number | null }[];
          }>(q.query.text, q.query.values)
        ).rows[0];
        assert.equal(result.device, "/archive");
        assert.deepEqual(
          result.points.map((p) => p.value),
          [75],
        );
        await pg.exec(`INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent") VALUES ('sparse-late','n',date_trunc('hour',now())-interval '70 days','{"disk":[{"mountpoint":"/archive","usedPercent":5}]}',0,0);
      UPDATE "MetricMaintenanceState" SET "lastSucceededAt"=now()-interval '1 day'; SELECT pipkerops_maintain_metrics();`);
        assert.equal(
          (
            await pg.query<{ numerator: number }>(
              `SELECT numerator FROM "MetricDeviceHourly" WHERE device='/archive'`,
            )
          ).rows[0].numerator,
          75,
        );
      },
    );
    await t.test("设备聚合失败时清理和全部水位原子回滚", async () => {
      await pg.exec(`UPDATE "MetricMaintenanceState" SET "lastSucceededAt"=now()-interval '1 day';
      INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent") VALUES ('rollback','n',now()-interval '31 days','{"disk":[{"mountpoint":"/keep","usedPercent":10}]}',0,0);
      CREATE FUNCTION reject_device_hours() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'device aggregation rejected'; END $$;
      CREATE TRIGGER reject_device_hours BEFORE INSERT ON "MetricDeviceHourly" FOR EACH ROW EXECUTE FUNCTION reject_device_hours();`);
      const state = (await pg.query(`SELECT * FROM "MetricMaintenanceState"`))
        .rows[0];
      await assert.rejects(
        pg.exec(`SELECT pipkerops_maintain_metrics()`),
        /device aggregation rejected/,
      );
      assert.deepEqual(
        (await pg.query(`SELECT * FROM "MetricMaintenanceState"`)).rows[0],
        state,
      );
      assert.equal(
        (await pg.query(`SELECT * FROM "MetricSample" WHERE id='rollback'`))
          .rows.length,
        1,
      );
    });
  } finally {
    await pg.close();
  }
});
