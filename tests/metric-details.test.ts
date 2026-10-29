import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { methodSchemas } from "../src/lib/services/contracts";
import {
  detailHistoryQuery,
  metricDetails,
  type MetricKind,
} from "../src/lib/services/metric-details";

test("资源历史：真实SQL设备隔离、累计速率、重置断点和窗口边界", async () => {
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
      `INSERT INTO "Node" (id,name,"updatedAt") VALUES ('node','node',now()),('other','other',now())`,
    );
    const end = new Date("2026-10-29T12:00:00Z");
    const start = end.getTime() - 3600000;
    const insert = async (
      id: string,
      seconds: number,
      recv: number,
      sent: number,
      used: number,
      nodeId = "node",
      identity?: string,
    ) => {
      await pg.query(
        `INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent") VALUES ($1,$2,$3,$4::jsonb,0,0)`,
        [
          id,
          nodeId,
          new Date(start + seconds * 1000),
          JSON.stringify({
            deviceIdentity: identity
              ? { network: { eth0: identity }, io: { sda: identity } }
              : undefined,
            disk: [
              { mountpoint: "/", usedPercent: used },
              { mountpoint: "/data", usedPercent: 80 },
            ],
            network: [
              { name: "eth0", bytesRecv: recv, bytesSent: sent },
              { name: "lo", bytesRecv: 999999, bytesSent: 999999 },
            ],
            io: {
              sda: { readBytes: recv, writeBytes: sent },
              sdb: { readBytes: 900000, writeBytes: 900000 },
            },
            processes: [{ command: "private-must-not-return" }],
          }),
        ],
      );
    };
    await insert("baseline", -10, 100, 200, 10);
    await insert("first", 0, 200, 400, 20);
    await insert("second", 10, 500, 800, 40);
    await insert("reset", 20, 5, 10, 60);
    await insert("recovered", 30, 105, 210, 80);
    await insert("gap", 200, 1000, 2000, 50);
    await insert("after-gap", 210, 1100, 2200, 60);
    await insert("upper-bound", 3600, 9999999, 9999999, 99);
    await insert("wrong-node", 5, 9999999, 9999999, 99, "other");
    const query = async (kind: MetricKind, device?: string) => {
      const q = detailHistoryQuery("node", kind, 1, device, end);
      return (
        await pg.query<{
          devices: string[];
          device: string | null;
          points: {
            direction: string;
            recordedAt: string;
            value: number | null;
          }[];
        }>(q.query.text, q.query.values)
      ).rows[0];
    };
    const disk = await query("disk");
    assert.deepEqual(disk.devices, ["/", "/data"]);
    assert.equal(disk.device, "/");
    assert.equal(disk.points.length, 6);
    assert.deepEqual(
      disk.points.map((p) => p.value),
      [20, 40, 60, 80, 50, 60],
    );
    assert.ok(
      disk.points.every(
        (p) =>
          new Date(p.recordedAt).getTime() >= start &&
          new Date(p.recordedAt) < end,
      ),
    );
    const otherDisk = await query("disk", "/data");
    assert.ok(otherDisk.points.every((p) => p.value === 80));
    for (const [kind, device] of [
      ["network", "eth0"],
      ["io", "sda"],
    ] as const) {
      const result = await query(kind, device);
      assert.equal(result.device, device);
      const directions =
        kind === "network" ? ["接收", "发送"] : ["读取", "写入"];
      assert.deepEqual(
        result.points
          .filter((p) => p.direction === directions[0])
          .map((p) => p.value),
        [10, 30, null, 10, null, 10],
      );
      assert.deepEqual(
        result.points
          .filter((p) => p.direction === directions[1])
          .map((p) => p.value),
        [20, 40, null, 20, null, 20],
      );
      assert.ok(!JSON.stringify(result).includes("private-must-not-return"));
    }
    await insert(
      "identity-first",
      500,
      10000,
      20000,
      10,
      "node",
      "generation-a",
    );
    await insert(
      "identity-next",
      510,
      10100,
      20200,
      10,
      "node",
      "generation-a",
    );
    await insert(
      "identity-replaced",
      520,
      50000,
      100000,
      10,
      "node",
      "generation-b",
    );
    await insert(
      "identity-after",
      530,
      50100,
      100200,
      10,
      "node",
      "generation-b",
    );
    for (const [kind, device] of [
      ["network", "eth0"],
      ["io", "sda"],
    ] as const) {
      const changed = await query(kind, device);
      assert.deepEqual(
        changed.points
          .filter(
            (p) =>
              ["接收", "读取"].includes(p.direction) &&
              new Date(p.recordedAt).getTime() >= start + 500000,
          )
          .slice(0, 4)
          .map((p) => p.value),
        [null, 10, null, 10],
      );
    }
    const missing = await query("network", "missing");
    assert.equal(missing.device, null);
    assert.deepEqual(missing.points, []);
    // Older or malformed telemetry must not break a history query.
    await pg.query(
      `INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent") VALUES ('malformed','node',$1,'{"disk":{},"network":[{"name":"eth0","bytesRecv":"NaN"}],"io":[]}'::jsonb,0,0)`,
      [new Date(start + 400000)],
    );
    await query("network", "eth0");
    await query("disk");
    await query("io");
    assert.equal(
      methodSchemas["nodes.history"].safeParse({
        nodeId: "node",
        kind: "disk",
        hours: 8761,
      }).success,
      false,
    );
    await assert.rejects(
      metricDetails(
        {
          userId: "user",
          role: "ADMIN",
          apiKeyId: "limited",
          scopes: ["nodes:read"],
          nodeIds: [],
        } as never,
        "node",
        "disk",
        1,
      ),
      { status: 403 },
    );
  } finally {
    await pg.close();
  }
});
