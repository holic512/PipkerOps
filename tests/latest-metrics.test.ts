import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { latestMetricQuery } from "../src/lib/services/nodes";

test("最新指标在SQL逐节点取一条，跨分区和无采样节点不读取全部历史", async () => {
  const pg = new PGlite();
  try {
    const migrations = new URL("../prisma/migrations/", import.meta.url);
    for (const name of (await readdir(migrations))
      .filter((n) => /^\d/.test(n))
      .sort())
      await pg.exec(
        await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"),
      );
    await pg.exec(`
   INSERT INTO "Node" (id,name,"updatedAt") VALUES ('a','first',now()),('b','second',now()),('empty','empty',now()),('hidden','hidden',now());
   INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent")
   SELECT 'old-'||n,'a',now()-interval '2 months'-n*interval '1 second',jsonb_build_object('large',repeat('x',2048)),10,20 FROM generate_series(1,2000)n;
   INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent") VALUES
    ('latest-a','a',now(),'{"marker":"new-a"}',30,40),
    ('latest-b','b',now()-interval '2 months','{"marker":"new-b"}',50,60),
    ('latest-hidden','hidden',now(),'{"marker":"hidden"}',70,80);
  `);
    const query = latestMetricQuery(["a", "b", "empty"]);
    const rows = await pg.query<{
      id: string;
      nodeId: string;
      payload: { marker: string };
    }>(query.text, query.values);
    assert.equal(rows.rows.length, 2);
    assert.deepEqual(rows.rows.map((r) => r.id).sort(), [
      "latest-a",
      "latest-b",
    ]);
    assert.ok(
      rows.rows.every(
        (r) => r.nodeId !== "hidden" && r.payload.marker !== "hidden",
      ),
    );
    const empty = latestMetricQuery([]);
    assert.deepEqual((await pg.query(empty.text, empty.values)).rows, []);
    const injection = latestMetricQuery(["a') OR true--"]);
    assert.deepEqual(
      (await pg.query(injection.text, injection.values)).rows,
      [],
    );
  } finally {
    await pg.close();
  }
});
