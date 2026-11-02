import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("分类迁移保留已有节点标签、关联指标和根目录归属", async () => {
  const pg = new PGlite();
  try {
    const root = new URL("../prisma/migrations/", import.meta.url);
    const names = (await readdir(root))
      .filter((name) => /^\d/.test(name))
      .sort();
    const organization = "202611020002_node_folders";
    for (const name of names.filter((name) => name < organization))
      await pg.exec(
        await readFile(new URL(`${name}/migration.sql`, root), "utf8"),
      );
    await pg.exec(`
      INSERT INTO "Node" (id,name,labels,"agentId","updatedAt") VALUES ('existing','已有节点',ARRAY['原有标签'],'existing-agent',now());
      INSERT INTO "MetricSample" (id,"nodeId","cpuPercent","memoryPercent") VALUES ('history','existing',12,34);
    `);
    await pg.exec(
      await readFile(new URL(`${organization}/migration.sql`, root), "utf8"),
    );
    const { rows } = await pg.query<{
      folderId: string | null;
      labels: string[];
      agentId: string;
    }>('SELECT "folderId",labels,"agentId" FROM "Node" WHERE id=\'existing\'');
    assert.deepEqual(rows, [
      { folderId: null, labels: ["原有标签"], agentId: "existing-agent" },
    ]);
    assert.equal(
      (
        await pg.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM "MetricSample" WHERE "nodeId"=\'existing\'',
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await pg.close();
  }
});
