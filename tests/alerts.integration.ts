/** Real probe failures drive durable alerts, HTTPS webhooks, deduplication and recovery. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { redis } from "../src/lib/redis";
import type { TaskData } from "../src/lib/client";
const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
async function wait<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  label: string,
) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Timed out: " + label);
}
test(
  "真实探针告警、HTTPS Webhook去重、恢复及失败审计",
  { timeout: 150000 },
  async () => {
    const run = "alerts-" + randomUUID().slice(0, 8);
    let probeId = "",
      ruleId = "",
      nodeId = "",
      healthy = true,
      webhookOk = true;
    const metricRuleIds: string[] = [];
    const deliveries: { id: string; title: string }[] = [];
    const target = createServer((_req, res) => {
      res.writeHead(healthy ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ healthy }));
    });
    const receiver = httpsServer(
      {
        key: readFileSync(".data/pki/server-linux.key"),
        cert: readFileSync(".data/pki/server-linux.crt"),
      },
      (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          deliveries.push(JSON.parse(body));
          res.writeHead(webhookOk ? 204 : 500).end();
        });
      },
    );
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    const targetAddress = target.address(),
      receiverAddress = receiver.address();
    assert.ok(
      targetAddress &&
        typeof targetAddress !== "string" &&
        receiverAddress &&
        typeof receiverAddress !== "string",
    );
    const login = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.BOOTSTRAP_EMAIL,
        password: process.env.BOOTSTRAP_PASSWORD,
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    async function rpc<T>(
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const response = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ method, params }),
      });
      const json = await response.json();
      assert.equal(response.status, 200, `${method}: ${json.error ?? ""}`);
      return json.data as T;
    }
    async function probe(success: boolean) {
      const task = await rpc<TaskData>("probes.run", { id: probeId });
      const result = await wait(
        () => rpc<TaskData>("tasks.get", { id: task.id }),
        (v) => ["SUCCEEDED", "FAILED"].includes(v.status),
        "probe result",
      );
      assert.equal(result.status, success ? "SUCCEEDED" : "FAILED");
    }
    try {
      const p = await rpc<{ id: string }>("probes.save", {
        name: run,
        type: "HTTP",
        target: `http://127.0.0.1:${targetAddress.port}`,
        intervalSeconds: 3600,
        failureThreshold: 2,
      });
      probeId = p.id;
      await wait(
        () => db().probe.findUniqueOrThrow({ where: { id: probeId } }),
        (p) => p.status === "HEALTHY",
        "initial healthy probe",
      );
      const rule = await rpc<{ id: string }>("alerts.save", {
        name: run,
        probeId,
        metric: "probeFailure",
        operator: "gt",
        threshold: 1,
        durationSeconds: 0,
        webhookUrl: `https://localhost:${receiverAddress.port}/notify`,
      });
      ruleId = rule.id;
      healthy = false;
      await probe(false);
      await probe(false);
      await wait(
        async () => deliveries.length,
        (n) => n === 1,
        "HTTPS webhook received",
      );
      assert.equal(deliveries[0].title, run);
      assert.equal(
        (
          await db().notification.findMany({
            where: { alertRuleId: ruleId, level: "error" },
          })
        ).length,
        1,
      );
      await probe(false);
      await probe(false);
      assert.equal(deliveries.length, 1, "continued outage is deduplicated");
      healthy = true;
      await probe(true);
      await wait(
        () =>
          db().notification.findFirst({
            where: { alertRuleId: ruleId, level: "success" },
          }),
        Boolean,
        "recovery notification",
      );
      webhookOk = false;
      healthy = false;
      await probe(false);
      await probe(false);
      await wait(
        () =>
          db().auditEvent.findFirst({
            where: { action: "alerts.webhook.failed", resourceId: ruleId },
          }),
        Boolean,
        "webhook failure audited",
      );
      assert.equal(
        deliveries.length,
        2,
        "new outage receives one fresh delivery, no blind webhook retries",
      );
      console.log(
        "Verified real HTTPS alert delivery, sustained-outage deduplication, recovery and failed-delivery audit",
      );
      const node = await db().node.create({
        data: { name: run + "-metrics", status: "APPROVED" },
      });
      nodeId = node.id;
      for (const [metric, operator] of [
        ["cpuPercent", "lt"],
        ["memoryPercent", "gt"],
      ]) {
        const metricRule = await rpc<{ id: string }>("alerts.save", {
          name: run + "-" + metric,
          nodeId,
          metric,
          operator,
          threshold: 50,
          durationSeconds: 0,
        });
        metricRuleIds.push(metricRule.id);
      }
      await new Promise((r) => setTimeout(r, 6000));
      assert.equal(
        await db().notification.count({
          where: { alertRuleId: { in: metricRuleIds } },
        }),
        0,
        "missing sampling is not replaced with zero for a CPU lt rule",
      );
      const sampledAt = new Date();
      await db().metricSample.createMany({
        data: [
          ...Array.from({ length: 2000 }, (_, index) => ({
            nodeId,
            recordedAt: new Date(sampledAt.getTime() - (index + 1) * 1000),
            cpuPercent: 90,
            memoryPercent: 10,
            payload: { history: "x".repeat(2048) },
          })),
          { nodeId, recordedAt: sampledAt, cpuPercent: 20, memoryPercent: 90 },
        ],
      });
      const metricNotifications = await wait(
        () =>
          db().notification.findMany({
            where: { alertRuleId: { in: metricRuleIds }, level: "error" },
          }),
        (rows) => rows.length === 2,
        "CPU and memory use latest sampling despite conflicting history",
      );
      assert.ok(
        metricNotifications.some((n) => n.body.includes("cpuPercent = 20")),
      );
      assert.ok(
        metricNotifications.some((n) => n.body.includes("memoryPercent = 90")),
      );
      await db().metricSample.create({
        data: { nodeId, cpuPercent: 90, memoryPercent: 10 },
      });
      await wait(
        () =>
          db().notification.count({
            where: { alertRuleId: { in: metricRuleIds }, level: "success" },
          }),
        (count) => count === 2,
        "CPU and memory latest-sampling recovery",
      );
      assert.equal(
        await db().notification.count({
          where: { alertRuleId: { in: metricRuleIds }, level: "error" },
        }),
        2,
        "CPU and memory alert notifications remain deduplicated",
      );
      console.log(
        "Verified missing samples, 2000 conflicting historical samples, latest CPU/memory alerts and recovery",
      );
    } finally {
      target.closeAllConnections();
      receiver.closeAllConnections();
      await new Promise<void>((r) => target.close(() => r()));
      await new Promise<void>((r) => receiver.close(() => r()));
      if (ruleId) {
        await db().alertRule.deleteMany({ where: { id: ruleId } });
        const client = await redis();
        await client.del([
          `pko:alert:${ruleId}:since`,
          `pko:alert:${ruleId}:fired`,
        ]);
      }
      if (metricRuleIds.length) {
        await db().alertRule.deleteMany({
          where: { id: { in: metricRuleIds } },
        });
        await (
          await redis()
        ).del(
          metricRuleIds.flatMap((id) => [
            `pko:alert:${id}:since`,
            `pko:alert:${id}:fired`,
          ]),
        );
      }
      if (nodeId) await db().node.deleteMany({ where: { id: nodeId } });
      if (probeId) {
        await db().task.deleteMany({
          where: {
            type: "probe.run",
            payload: { path: ["probeId"], equals: probeId },
          },
        });
        await db().probe.deleteMany({ where: { id: probeId } });
      }
      await db().$disconnect();
      await (await redis()).quit();
    }
  },
);
