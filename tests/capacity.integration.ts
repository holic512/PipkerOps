/** Real concurrent Linux Agents, no pre-seeded demo nodes or synthetic telemetry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import type { NodeData, TaskData } from "../src/lib/client";
const exec = promisify(execFile),
  origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const count = Number(process.env.CAPACITY_NODES ?? 10);
async function docker(...args: string[]) {
  return (
    await exec("docker", args, { timeout: 120000, maxBuffer: 1048576 })
  ).stdout.trim();
}
async function parallel<T, R>(
  items: T[],
  work: (item: T, index: number) => Promise<R>,
  width = 5,
) {
  const results: R[] = [];
  let cursor = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await work(items[i], i);
      }
    }),
  );
  const failed = outcomes.find((r) => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}
async function wait<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  label: string,
  timeout = 120000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await read();
    if (accept(v)) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Timed out: " + label);
}
test(
  "多Linux Agent并发注册、mTLS采样及任务分发",
  { timeout: 600000 },
  async () => {
    assert.ok(
      Number.isInteger(count) && count >= 2 && count <= 50,
      "CAPACITY_NODES must be 2–50",
    );
    const run = "capacity-" + randomUUID().slice(0, 8);
    const containers: string[] = [];
    let tokenId = "";
    const nodeIds: string[] = [];
    const binary =
      process.env.LINUX_AGENT_BINARY ??
      `/tmp/pipker-agent-linux-${process.arch === "x64" ? "amd64" : "arm64"}`;
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
    const started = performance.now();
    try {
      const token = await rpc<{ id: string; token: string }>("nodes.token", {
        name: run,
        maxUses: count,
        hours: 1,
      });
      tokenId = token.id;
      await parallel(
        Array.from({ length: count }, (_, i) => i),
        async (i) => {
          const name = run + "-" + i;
          const container = await docker(
            "run",
            "-d",
            "--name",
            name,
            "--label",
            "pipkerops.acceptance=true",
            "--entrypoint",
            "sleep",
            "pipkerops-agent-fixture:local",
            "1200",
          );
          containers.push(container);
          await docker(
            "cp",
            binary,
            container + ":/usr/local/bin/pipkerops-agent",
          );
          // Local private material goes through stdin, never argv or command interpolation.
          await new Promise<void>((resolve, reject) => {
            const child = requireExec(container, "/tmp/ca.crt");
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(Error("CA copy failed")),
            );
            child.stdin!.end(readFileSync(".data/pki/ca.crt"));
          });
          await new Promise<void>((resolve, reject) => {
            const child = requireExec(container, "/tmp/token");
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(Error("token copy failed")),
            );
            child.stdin!.end(token.token);
          });
          await docker(
            "exec",
            "-d",
            container,
            "sh",
            "-c",
            'exec pipkerops-agent "$@" >/tmp/agent.log 2>&1',
            "--",
            "--name",
            name,
            "--state-dir",
            "/tmp/state",
            "--ca",
            "/tmp/ca.crt",
            "--token-file",
            "/tmp/token",
            "--gateway",
            "wss://host.docker.internal:9543/agent",
            "--enroll-url",
            "https://host.docker.internal:9544",
          );
        },
      );
      const nodes = await wait(
        () =>
          db().node.findMany({ where: { name: { startsWith: run + "-" } } }),
        (n) => n.length === count,
        "all nodes pending",
      );
      nodeIds.push(...nodes.map((n) => n.id));
      await parallel(nodes, (n) =>
        rpc("nodes.approve", { id: n.id, confirmed: true }),
      );
      await wait(
        () =>
          db().metricSample.groupBy({
            by: ["nodeId"],
            where: { nodeId: { in: nodeIds } },
          }),
        (n) => n.length === count,
        "all real metrics",
      );
      const online = await rpc<NodeData[]>("nodes.list");
      assert.equal(
        online.filter((n) => nodeIds.includes(n.id) && n.connected).length,
        count,
      );
      assert.ok(
        online
          .filter((n) => nodeIds.includes(n.id))
          .every((n) => n.os === "linux"),
      );
      const connectedMs = performance.now() - started;
      const taskStart = performance.now();
      const tasks = await parallel(nodes, (n) =>
        rpc<TaskData>("tasks.create", {
          type: "system.info",
          nodeId: n.id,
          payload: {},
        }),
      );
      await wait(
        () =>
          db().task.findMany({ where: { id: { in: tasks.map((t) => t.id) } } }),
        (t) => t.length === count && t.every((t) => t.status === "SUCCEEDED"),
        "all concurrent tasks",
      );
      const taskMs = performance.now() - taskStart;
      const overviewStart = performance.now();
      await rpc("overview");
      const overviewMs = performance.now() - overviewStart;
      const samples = await db().metricSample.count({
        where: { nodeId: { in: nodeIds } },
      });
      console.log(
        JSON.stringify({
          realLinuxNodes: count,
          connectedMs: Math.round(connectedMs),
          concurrentTaskBatchMs: Math.round(taskMs),
          overviewMs: Math.round(overviewMs),
          realMetricSamples: samples,
        }),
      );
    } finally {
      await parallel(containers, async (c) => {
        try {
          await docker("rm", "-f", "-v", c);
        } catch {}
      });
      const owned = await db().node.findMany({
        where: { name: { startsWith: run + "-" } },
        select: { id: true },
      });
      const ids = owned.map((n) => n.id);
      if (ids.length) {
        await db().task.deleteMany({ where: { nodeId: { in: ids } } });
        await db().node.deleteMany({ where: { id: { in: ids } } });
      }
      if (tokenId)
        await db().enrollmentToken.deleteMany({ where: { id: tokenId } });
      await db().$disconnect();
    }
  },
);
function requireExec(container: string, path: string) {
  return spawn(
    "docker",
    ["exec", "-i", container, "sh", "-c", 'umask 077; cat > "$1"', "--", path],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
}
