/** Two real isolated Linux nodes exercise cross-node probes, fault paths and recovery. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import type { ProbeData, TaskData } from "../src/lib/client";
const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
const write = (container: string, path: string, value: string | Buffer) =>
  execFileSync(
    "docker",
    ["exec", "-i", container, "sh", "-c", 'umask 077; cat > "$1"', "--", path],
    { input: value, stdio: ["pipe", "pipe", "pipe"] },
  );
async function wait<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  label: string,
  timeout = 60000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Timed out: " + label);
}
test(
  "双Linux节点HTTP/TCP连通性、故障阈值、拓扑依赖及恢复",
  { timeout: 240000 },
  async () => {
    const run = "connectivity-" + randomUUID().slice(0, 8);
    const containers: string[] = [],
      nodeIds: string[] = [],
      probeIds: string[] = [],
      appIds: string[] = [],
      tokenIds: string[] = [];
    let network = false;
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
    async function runProbe(probeId: string) {
      const task = await rpc<TaskData>("probes.run", { id: probeId });
      return wait(
        () => rpc<TaskData>("tasks.get", { id: task.id }),
        (t) => ["SUCCEEDED", "FAILED"].includes(t.status),
        "probe completion",
      );
    }
    try {
      docker("network", "create", run);
      network = true;
      const ips: string[] = [];
      for (const role of ["a", "b"]) {
        const name = run + "-" + role;
        const container = docker(
          "run",
          "-d",
          "--name",
          name,
          "--label",
          "pipkerops.acceptance=true",
          "--network",
          run,
          "--entrypoint",
          "sleep",
          "pipkerops-agent-fixture:local",
          "3600",
        ).trim();
        containers.push(container);
        ips.push(
          docker(
            "inspect",
            "--format",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
            container,
          ).trim(),
        );
        write(
          container,
          "/etc/nginx/conf.d/health.conf",
          `server { listen 18080; location = /health { default_type application/json; return 200 '{"role":"${role}"}'; } }\n`,
        );
        docker("exec", container, "nginx");
        docker(
          "cp",
          process.env.LINUX_AGENT_BINARY ??
            `/tmp/pipker-agent-linux-${process.arch === "x64" ? "amd64" : "arm64"}`,
          container + ":/usr/local/bin/pipkerops-agent",
        );
        write(container, "/tmp/ca.crt", readFileSync(".data/pki/ca.crt"));
        const token = await rpc<{ id: string; token: string }>("nodes.token", {
          name,
          hours: 1,
          maxUses: 1,
        });
        tokenIds.push(token.id);
        write(container, "/tmp/token", token.token);
        docker(
          "exec",
          "-d",
          container,
          "sh",
          "-c",
          'exec pipkerops-agent "$@" >/tmp/agent.log 2>&1',
          "--",
          "--gateway",
          "wss://host.docker.internal:9543/agent",
          "--enroll-url",
          "https://host.docker.internal:9544",
          "--ca",
          "/tmp/ca.crt",
          "--token-file",
          "/tmp/token",
          "--state-dir",
          "/tmp/agent-state",
          "--name",
          name,
        );
        const node = await wait(
          () => db().node.findFirst({ where: { name } }),
          Boolean,
          "node enrollment",
        );
        assert.ok(node);
        nodeIds.push(node.id);
        await rpc("nodes.approve", { id: node.id, confirmed: true });
        await wait(
          () => db().metricSample.findFirst({ where: { nodeId: node.id } }),
          Boolean,
          "node metrics",
        );
        const app = await rpc<{ id: string }>("applications.save", { name });
        appIds.push(app.id);
        await rpc("deployments.save", {
          applicationId: app.id,
          nodeId: node.id,
          name,
          type: "nginx",
          target: "nginx:18080",
        });
      }
      const dep = await rpc<{ id: string }>("dependencies.save", {
        fromApplicationId: appIds[0],
        toApplicationId: appIds[1],
        type: "http",
      });
      for (const [source, destination, type] of [
        [0, 1, "HTTP"],
        [0, 1, "TCP"],
        [1, 0, "HTTP"],
      ] as const) {
        const probe = await rpc<ProbeData>("probes.save", {
          name: `${run}-${source}-${destination}-${type}`,
          type,
          sourceNodeId: nodeIds[source],
          applicationId: appIds[destination],
          target:
            type === "HTTP"
              ? `http://${ips[destination]}:18080/health`
              : `${ips[destination]}:18080`,
          intervalSeconds: 3600,
          timeoutMs: 1000,
          failureThreshold: 2,
          ...(type === "HTTP" ? { mapping: { role: "role" } } : {}),
        });
        probeIds.push(probe.id);
        await wait(
          () => db().probe.findUniqueOrThrow({ where: { id: probe.id } }),
          (p) => p.status === "HEALTHY",
          "cross-node " + type,
        );
        if (type === "HTTP") {
          const result = await db().probeResult.findFirst({
            where: { probeId: probe.id },
            orderBy: { recordedAt: "desc" },
          });
          assert.equal(
            (result?.data as { role: string }).role,
            destination === 0 ? "a" : "b",
          );
        }
      }
      console.log("Verified A→B HTTP/TCP and B→A HTTP from real Agent sources");
      docker("exec", containers[1], "nginx", "-s", "stop");
      assert.equal((await runProbe(probeIds[0])).status, "FAILED");
      assert.equal(
        (await db().probe.findUniqueOrThrow({ where: { id: probeIds[0] } }))
          .status,
        "DEGRADED",
      );
      assert.equal((await runProbe(probeIds[0])).status, "FAILED");
      const failed = await db().probe.findUniqueOrThrow({
        where: { id: probeIds[0] },
      });
      assert.equal(failed.status, "UNHEALTHY");
      assert.equal(failed.failureCount, 2);
      const topology = await rpc<{
        dependencies: { id: string }[];
        probes: ProbeData[];
      }>("topology");
      assert.ok(topology.dependencies.some((d) => d.id === dep.id));
      assert.equal(
        topology.probes.find((p) => p.id === probeIds[0])?.status,
        "UNHEALTHY",
      );
      docker("exec", containers[1], "nginx");
      assert.equal((await runProbe(probeIds[0])).status, "SUCCEEDED");
      const recovered = await db().probe.findUniqueOrThrow({
        where: { id: probeIds[0] },
      });
      assert.equal(recovered.status, "HEALTHY");
      assert.equal(recovered.failureCount, 0);
      console.log(
        "Verified failure threshold DEGRADED→UNHEALTHY, actual topology dependency state and recovery",
      );
    } finally {
      for (const c of containers)
        try {
          docker("rm", "-f", "-v", c);
        } catch {}
      if (network)
        try {
          docker("network", "rm", run);
        } catch {}
      if (probeIds.length)
        await db().probe.deleteMany({ where: { id: { in: probeIds } } });
      if (appIds.length)
        await db().application.deleteMany({ where: { id: { in: appIds } } });
      if (nodeIds.length) {
        await db().task.deleteMany({ where: { nodeId: { in: nodeIds } } });
        await db().node.deleteMany({ where: { id: { in: nodeIds } } });
      }
      if (tokenIds.length)
        await db().enrollmentToken.deleteMany({
          where: { id: { in: tokenIds } },
        });
      await db().$disconnect();
    }
  },
);
