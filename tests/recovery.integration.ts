import { runtimeFixture } from "./helpers/runtime-fixture";
import {
  integrationOrigin,
  proxyHeaders,
  availablePort,
  prepareHostAgent,
  waitForAgent,
} from "./helpers/agent-fixture";
import { configValues } from "../src/lib/config";
/** Starts only private test processes; never kills a process outside this test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { db } from "../src/lib/db";
import type { TaskData } from "../src/lib/client";
const origin = integrationOrigin;
async function wait<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  label: string,
  timeout = 45000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await read();
    if (accept(v)) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error("Timed out: " + label);
}
async function stop(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise<void>((r) => child.once("exit", () => r())),
    new Promise<void>((r) => setTimeout(r, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((r) => child.once("exit", () => r()));
  }
}
test(
  "Gateway崩溃后Agent结果对账及Worker非幂等未知状态保护",
  { timeout: 180000 },
  async () => {
    assert.equal(
      process.env.RECOVERY_WORKER_EXCLUSIVE,
      "true",
      "Stop the development Worker you own before running this test; it launches its own Worker",
    );
    assert.equal(
      process.env.RECOVERY_GATEWAY_EXCLUSIVE,
      "true",
      "Stop the development Gateway you own before running this test; the connector must have a single owner",
    );
    const run = "recovery-" + randomUUID().slice(0, 8);
    let nodeId = "";
    const probeIds: string[] = [],
      taskIds: string[] = [];
    let gateway: ChildProcess | undefined,
      worker: ChildProcess | undefined,
      agent: ChildProcess | undefined;
    const counts = { agent: 0, worker: 0 };
    let holdAgent: (() => void) | undefined,
      holdWorker: (() => void) | undefined;
    const target = createServer(async (req, res) => {
      if (req.url === "/agent") {
        counts.agent++;
        await new Promise<void>((r) => {
          holdAgent = r;
        });
      } else {
        counts.worker++;
        await new Promise<void>((r) => {
          holdWorker = r;
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const address = target.address();
    assert.ok(address && typeof address !== "string");
    const login = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: { ...proxyHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify({
        email: configValues.BOOTSTRAP_EMAIL,
        password: configValues.BOOTSTRAP_PASSWORD,
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
          ...proxyHeaders(origin),
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ method, params }),
      });
      const json = await response.json();
      assert.equal(response.status, 200, `${method}: ${json.error ?? ""}`);
      return json.data as T;
    }
    const runtime = runtimeFixture(await availablePort());
    const startGateway = () => runtime.start("gateway");
    const startWorker = () => runtime.start("worker");
    try {
      gateway = startGateway();
      let ready = "";
      gateway.stdout?.on("data", (data) => (ready += data.toString()));
      gateway.stderr?.on("data", () => {});
      await wait(
        async () => ready,
        (s) => s.includes("Agent connector / terminal gateway ready"),
        "private Gateway startup",
      );
      const state = resolve(".data", run);
      const fixture = await prepareHostAgent(
        resolve(process.env.AGENT_BINARY ?? "agent/bin/pipker-agent"),
        state,
        run,
      );
      agent = fixture.start();
      agent.stdout?.on("data", () => {});
      agent.stderr?.on("data", () => {});
      await waitForAgent(fixture.connection);
      const node = await rpc<{ id: string }>("nodes.import", {
        connection: fixture.connection,
        confirmed: true,
      });
      nodeId = node.id;
      await wait(
        () => db().metricSample.findFirst({ where: { nodeId } }),
        Boolean,
        "node connected",
      );
      const p = await rpc<{ id: string }>("probes.save", {
        name: run + "-agent",
        type: "HTTP",
        sourceNodeId: nodeId,
        target: `http://127.0.0.1:${address.port}/agent`,
        config: { method: "POST" },
        enabled: false,
        timeoutMs: 30000,
        confirmed: true,
      });
      probeIds.push(p.id);
      const task = await rpc<TaskData>("probes.run", {
        id: p.id,
        confirmed: true,
      });
      taskIds.push(task.id);
      await wait(
        async () => counts.agent,
        (n) => n === 1,
        "Agent side effect started",
      );
      await stop(gateway, "SIGKILL");
      holdAgent?.();
      gateway = startGateway();
      gateway.stdout?.on("data", () => {});
      gateway.stderr?.on("data", () => {});
      const completed = await wait(
        () => rpc<TaskData>("tasks.get", { id: task.id }),
        (t) => t.status === "SUCCEEDED",
        "Agent journal result reconciled after Gateway restart",
      );
      assert.equal(completed.attempts, 1);
      assert.equal(counts.agent, 1);
      console.log(
        "Verified Gateway SIGKILL during POST, Agent journal reconciliation and exactly one actual request",
      );
      const control = await rpc<{ id: string }>("probes.save", {
        name: run + "-worker",
        type: "HTTP",
        target: `http://127.0.0.1:${address.port}/worker`,
        config: { method: "POST" },
        enabled: false,
        timeoutMs: 30000,
        confirmed: true,
      });
      probeIds.push(control.id);
      const lost = await rpc<TaskData>("probes.run", {
        id: control.id,
        confirmed: true,
      });
      taskIds.push(lost.id);
      worker = startWorker();
      worker.stdout?.on("data", () => {});
      worker.stderr?.on("data", () => {});
      await wait(
        async () => counts.worker,
        (n) => n === 1,
        "Worker side effect started",
      );
      await stop(worker, "SIGKILL");
      holdWorker?.();
      // Simulate expiry for this owned test task instead of waiting a minute.
      await db().task.update({
        where: { id: lost.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });
      worker = startWorker();
      worker.stdout?.on("data", () => {});
      worker.stderr?.on("data", () => {});
      const unknown = await wait(
        () => rpc<TaskData>("tasks.get", { id: lost.id }),
        (t) => t.status === "UNKNOWN",
        "non-idempotent crash recovery",
      );
      assert.equal(unknown.attempts, 1);
      assert.equal(unknown.maxAttempts, 1);
      const healthy = await rpc<TaskData>("tasks.create", {
        type: "system.info",
        nodeId,
        payload: {},
      });
      taskIds.push(healthy.id);
      await wait(
        () => rpc<TaskData>("tasks.get", { id: healthy.id }),
        (t) => t.status === "SUCCEEDED",
        "new tasks still execute after recovery",
      );
      assert.equal(
        counts.worker,
        1,
        "Worker restart must not repeat unknown POST",
      );
      const journal = JSON.parse(
        readFileSync(resolve(state, "tasks", task.id + ".json"), "utf8"),
      );
      assert.ok(journal, "real durable Agent journal exists");
      console.log(
        "Verified Worker SIGKILL after external effect, lease expiry becomes UNKNOWN, attempts=1 and no replay",
      );
    } finally {
      holdAgent?.();
      holdWorker?.();
      await stop(agent);
      await stop(gateway);
      await stop(worker);
      runtime.cleanup();
      target.closeAllConnections();
      await new Promise<void>((r) => target.close(() => r()));
      if (taskIds.length)
        await db().task.deleteMany({ where: { id: { in: taskIds } } });
      if (probeIds.length)
        await db().probe.deleteMany({ where: { id: { in: probeIds } } });
      if (nodeId) {
        await db().task.deleteMany({ where: { nodeId } });
        await db().node.deleteMany({ where: { id: nodeId } });
      }
      await db().$disconnect();
    }
  },
);
