import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeMonitoringDb } from "./helpers/native-monitoring-db";
import {
  storeObjectFrame,
  objectHistory,
  objectEvents,
  saveProcessWatch,
  deleteProcessWatch,
  desiredWatches,
  acknowledgeWatches,
} from "../src/lib/services/object-monitoring";
import { processObjectId } from "../src/lib/object-monitoring";
import type { Actor } from "../src/lib/auth";
import type { TelemetryFrame } from "../src/lib/telemetry";
import { methodOutputSchemas } from "../src/lib/services/contracts";

test(
  "对象历史：非UTC数据库、准确身份、缺口、关注、事件和先聚合后清理",
  { timeout: 120000 },
  async () => {
    const fixture = await nativeMonitoringDb();
    const { prisma, pool } = fixture;
    try {
      const user = await prisma.user.create({
        data: {
          email: "history@test.invalid",
          displayName: "history",
          passwordHash: "unused",
          role: "ADMIN",
        },
      });
      const actor: Actor = { userId: user.id, role: "ADMIN" };
      const node = await prisma.node.create({
        data: { name: "object-history-isolated" },
      });
      const bootId = "boot-one";
      const process = {
        bootId,
        pid: 42,
        startTicks: "90071992547409931234",
        name: "worker",
        cpuPercent: 250,
        memoryPercent: 12,
        rss: 4096,
        threads: 3,
        status: ["S"],
      };
      const objectId = processObjectId(process);
      const start = Date.now() - 3600000;
      const frame = (
        sequence: number,
        patch: Partial<TelemetryFrame> = {},
      ): TelemetryFrame => ({
        schemaVersion: 2,
        bootId,
        sequence,
        category: "details",
        sampledAt: new Date(start + sequence * 30000).toISOString(),
        durationMs: 12,
        errors: [],
        truncated: false,
        series: [],
        data: {
          historyVersion: 1,
          processHistory: [process],
          processes: [process],
          memoryTop: [process],
          containers: [
            {
              id: "a".repeat(64),
              name: "web",
              state: "running",
              health: "none",
              startedAt: "2026-11-01T00:00:00Z",
              restartCount: 0,
              metrics: { cpuPercent: 120, networkRecv: 100, intervalMs: 30000 },
            },
          ],
          services: [{ name: "web.service", active: "active", sub: "running" }],
        },
        ...patch,
      });
      await storeObjectFrame(node.id, frame(1));
      await storeObjectFrame(node.id, frame(1));
      assert.equal(
        await prisma.monitoringSample.count({
          where: { nodeId: node.id, kind: "process" },
        }),
        1,
        "重复帧幂等",
      );
      await storeObjectFrame(node.id, frame(0));
      assert.equal(
        await prisma.monitoringSample.count({
          where: { nodeId: node.id, kind: "process" },
        }),
        1,
        "乱序不覆盖新状态",
      );
      await storeObjectFrame(
        node.id,
        frame(2, {
          data: {
            historyVersion: 1,
            processHistory: [],
            containers: [],
            services: [],
          },
          truncated: true,
          errors: ["permission denied"],
        }),
      );
      const missing = await prisma.monitoringState.findUniqueOrThrow({
        where: {
          nodeId_kind_objectId: { nodeId: node.id, kind: "process", objectId },
        },
      });
      assert.equal(missing.coverage, "not_covered");
      assert.notEqual(missing.state, "exited");
      await storeObjectFrame(node.id, frame(4));
      assert.ok(
        await prisma.monitoringEvent.count({
          where: { nodeId: node.id, toState: "sampling_gap" },
        }),
        "合并帧缺口保留",
      );
      const reused = {
        ...process,
        startTicks: "90071992547409931235",
        cpuPercent: 5,
      };
      await storeObjectFrame(
        node.id,
        frame(5, { data: { historyVersion: 1, processHistory: [reused] } }),
      );
      const history = await objectHistory(actor, {
        nodeId: node.id,
        kind: "process",
        metric: "cpuPercent",
        objectIds: [objectId, processObjectId(reused)],
        hours: 2,
      });
      assert.ok(history.series[0].points.some((p) => p.value === 250));
      assert.ok(
        !history.series[0].points.some((p) => p.value === 5),
        "PID复用后历史不串联",
      );
      assert.ok(history.series.every((s) => s.points.length <= 1440));
      assert.ok(
        history.series[0].points.some(
          (p) => p.value === null && p.gapCount > 0,
        ),
      );
      assert.equal(history.unit, "%");
      methodOutputSchemas["nodes.history"]!.parse(
        JSON.parse(JSON.stringify({ data: history })),
      );
      await assert.rejects(
        objectHistory(
          {
            ...actor,
            role: "VIEWER",
            apiKeyId: "fake",
            scopes: [],
            nodeIds: [node.id],
          },
          { nodeId: node.id, kind: "process", hours: 1 },
        ),
        /权限/,
      );
      await assert.rejects(
        objectHistory(actor, {
          nodeId: node.id,
          kind: "process",
          objectIds: ["1", "2", "3", "4", "5", "6"],
          hours: 1,
        }),
        /5/,
      );
      const events = await objectEvents(actor, {
        nodeId: node.id,
        kind: "process",
        objectId,
        hours: 2,
      });
      assert.ok(events.events.some((e) => e.coverage === "not_covered"));
      assert.ok(!events.events.some((e) => e.toState === "exited"));
      const live = {
        ...frame(6),
        sampledAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      };
      await prisma.nodeTelemetry.create({
        data: {
          nodeId: node.id,
          category: "details",
          snapshot: JSON.parse(JSON.stringify(live)),
          receivedAt: new Date(),
        },
      });
      await assert.rejects(
        saveProcessWatch(
          { ...actor, role: "VIEWER" },
          { nodeId: node.id, ...process },
        ),
        /权限|只读/,
      );
      await saveProcessWatch(actor, { nodeId: node.id, ...process });
      let watches = await desiredWatches(node.id);
      assert.equal(watches.watches.length, 1);
      assert.equal(watches.revision, 1);
      await acknowledgeWatches(node.id, 0);
      assert.equal((await desiredWatches(node.id)).ackRevision, -1);
      await acknowledgeWatches(node.id, 1);
      assert.equal((await desiredWatches(node.id)).ackRevision, 1);
      await storeObjectFrame(
        node.id,
        frame(7, {
          data: {
            historyVersion: 1,
            processHistory: [reused],
            watchResults: [{ ...process, status: "identity_changed" }],
          },
        }),
      );
      watches = await desiredWatches(node.id);
      assert.equal(watches.watches.length, 0);
      assert.equal(watches.revision, 2);
      assert.ok(
        await prisma.monitoringEvent.count({
          where: { nodeId: node.id, objectId, toState: "exited" },
        }),
      );
      await deleteProcessWatch(actor, node.id, objectId);
      assert.equal((await desiredWatches(node.id)).revision, 2, "重复删除幂等");
      await prisma.processWatch.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          nodeId: node.id,
          objectId: `boot-one:${i + 100}:1`,
          bootId,
          pid: i + 100,
          startTicks: "1",
          name: "limit",
        })),
      });
      await assert.rejects(
        saveProcessWatch(actor, { nodeId: node.id, ...process }),
        /20/,
      );
      await prisma.processWatch.deleteMany({ where: { nodeId: node.id } });
      const rateAt = Math.floor(Date.now() / 300000) * 300000 - 600000;
      await storeObjectFrame(
        node.id,
        frame(100, {
          sampledAt: new Date(rateAt + 30000).toISOString(),
          data: {
            historyVersion: 1,
            processHistory: [
              { ...process, pid: 77, readRate: 10, intervalMs: 1000 },
            ],
          },
        }),
      );
      await storeObjectFrame(
        node.id,
        frame(101, {
          sampledAt: new Date(rateAt + 60000).toISOString(),
          data: {
            historyVersion: 1,
            processHistory: [
              { ...process, pid: 77, readRate: 20, intervalMs: 9000 },
            ],
          },
        }),
      );
      await assert.rejects(
        saveProcessWatch(actor, {
          nodeId: node.id,
          bootId,
          pid: 42,
          startTicks: "9",
        }),
        /实例/,
      );
      // The aggregate transaction must roll back raw cleanup and watermark together.
      await pool.query(
        `CREATE FUNCTION reject_object_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected aggregate failure'; END $$; CREATE TRIGGER reject_object_aggregate BEFORE INSERT ON "MonitoringAggregate" FOR EACH ROW EXECUTE FUNCTION reject_object_aggregate()`,
      );
      await assert.rejects(
        pool.query(`SELECT pipkerops_maintain_object_history()`),
        /injected/,
      );
      assert.equal(
        (
          await prisma.monitoringMaintenance.findUniqueOrThrow({
            where: { id: 1 },
          })
        ).through,
        null,
      );
      assert.ok(await prisma.monitoringDirtyBucket.count());
      await pool.query(
        `DROP TRIGGER reject_object_aggregate ON "MonitoringAggregate"; DROP FUNCTION reject_object_aggregate()`,
      );
      await pool.query(`SELECT pipkerops_maintain_object_history()`);
      const aggregates = await prisma.monitoringAggregate.findMany({
        where: { nodeId: node.id, kind: "process", objectId },
      });
      assert.ok(aggregates.length);
      assert.ok(aggregates.every((a) => a.bucketAt.getUTCMinutes() % 5 === 0));
      const rateAggregate = await prisma.monitoringAggregate.findFirstOrThrow({
        where: {
          nodeId: node.id,
          kind: "process",
          objectId: processObjectId({ ...process, pid: 77 }),
        },
      });
      assert.equal(
        (rateAggregate.metrics as Record<string, { mean: number }>).readRate
          .mean,
        19,
        "速率按有效间隔加权",
      );
      const before = JSON.stringify(aggregates);
      await pool.query(`SELECT pipkerops_maintain_object_history()`);
      assert.equal(
        JSON.stringify(
          await prisma.monitoringAggregate.findMany({
            where: { nodeId: node.id, kind: "process", objectId },
          }),
        ),
        before,
        "维护重跑幂等",
      );
      await pool.query(
        `SELECT pipkerops_maintain_object_history(now()+interval '8 days')`,
      );
      assert.equal(
        await prisma.monitoringSample.count({ where: { nodeId: node.id } }),
        0,
      );
      assert.ok(
        await prisma.monitoringAggregate.count({ where: { nodeId: node.id } }),
      );
      const aggregated = await objectHistory(actor, {
        nodeId: node.id,
        kind: "process",
        metric: "cpuPercent",
        objectIds: [objectId],
        hours: 24,
      });
      assert.ok(
        aggregated.series[0].points.some((p) => p.maximum === 250),
        "原始清理后聚合仍可查询",
      );
      await pool.query(
        `SELECT pipkerops_maintain_object_history(now()+interval '31 days')`,
      );
      assert.equal(
        await prisma.monitoringAggregate.count({ where: { nodeId: node.id } }),
        0,
      );
      assert.equal(
        await prisma.monitoringEvent.count({ where: { nodeId: node.id } }),
        0,
      );
      await fixture.evidence("regression.json", {
        utcDatabaseDefault: "Asia/Shanghai",
        processIdentity: objectId,
        checked: [
          "duplicates",
          "out-of-order",
          "coverage gaps",
          "PID reuse",
          "watch ACK revision",
          "watch exit",
          "authorization",
          "1440 points",
          "transactional rollback",
          "UTC buckets",
          "idempotence",
          "7/30 retention",
        ],
      });
      console.log(`Object history evidence: ${fixture.directory}`);
    } finally {
      await fixture.close();
    }
  },
);
