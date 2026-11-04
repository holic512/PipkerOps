import {
  integrationOrigin,
  proxyHeaders,
  prepareContainerAgent,
  waitForAgent,
} from "./helpers/agent-fixture";
import { configValues } from "../src/lib/config";
/** Real operations in an isolated privileged Docker-in-Docker Linux node.
 * Never mounts the host Docker socket or host filesystem into the fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { db } from "../src/lib/db";
import type { ResourceData } from "../src/lib/resource-contracts";
import { topologyLinks } from "../src/lib/topology-links";
const origin = integrationOrigin;
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });
async function wait<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  label: string,
  timeout = 90000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await read();
    if (accept(v)) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
test(
  "隔离Linux真实文件、Shell、Docker、Compose、Nginx回滚及节点/容器PTY",
  { timeout: 420000 },
  async () => {
    const run = "linux-" + randomUUID().slice(0, 8);
    let container = "";
    let nodeId = "";
    let siteId = "";
    let applicationId = "";
    let resourceId = "";
    let probeId = "";
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
    async function rpc<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const r = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          ...proxyHeaders(origin),
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ method, params }),
      });
      const json = await r.json();
      assert.equal(r.status, 200, `${method}: ${json.error ?? ""}`);
      return json.data as T;
    }
    async function task(
      type: string,
      payload: Record<string, unknown> = {},
      success = true,
    ) {
      const t = await rpc<{ id: string }>("tasks.create", {
        type,
        nodeId,
        payload,
        confirmed: true,
      });
      const result = await wait(
        () =>
          rpc<{
            id: string;
            status: string;
            output: string;
            result: Record<string, unknown>;
            error?: string;
          }>("tasks.get", { id: t.id }),
        (t) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(t.status),
        type,
        150000,
      );
      assert.equal(
        result.status,
        success ? "SUCCEEDED" : "FAILED",
        `${type}: ${result.error ?? result.output}`,
      );
      return result;
    }
    async function terminal(containerId?: string) {
      const ticket = await rpc<{ path: string }>("terminal.ticket", {
        nodeId,
        containerId,
        confirmed: true,
      });
      const url = new URL(
        ticket.path,
        `ws://127.0.0.1:${configValues.GATEWAY_PORT ?? 9444}`,
      );
      const ws = new WebSocket(url, { headers: proxyHeaders(origin) });
      let output = "";
      ws.on("message", (raw) => {
        const p = JSON.parse(raw.toString());
        if (p.type === "terminal.error") output += "ERROR:" + p.error;
        if (p.type === "terminal.output") output += p.data;
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const marker = "PTY_" + randomUUID().replaceAll("-", "");
      ws.send(JSON.stringify({ type: "terminal.resize", cols: 100, rows: 30 }));
      ws.send(
        JSON.stringify({
          type: "terminal.input",
          data: `printf '${marker}\\n'; uname -s\n`,
        }),
      );
      try {
        await wait(
          async () => output,
          (s) => s.includes(marker) && s.includes("Linux"),
          containerId ? "container PTY" : "node PTY",
          15000,
        );
      } finally {
        ws.close();
      }
      assert.ok(!output.includes("ERROR:"), output);
    }
    try {
      container = docker(
        "run",
        "-d",
        "--privileged",
        "--name",
        run,
        "--label",
        "pipkerops.acceptance=true",
        "-p",
        "127.0.0.1::9443",
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "pipkerops-agent-fixture:local",
      ).trim();
      await wait(
        async () => {
          try {
            return docker(
              "exec",
              container,
              "docker",
              "info",
              "--format",
              "{{.ServerVersion}}",
            ).trim();
          } catch {
            return "";
          }
        },
        Boolean,
        "isolated Docker daemon",
      );
      docker(
        "cp",
        process.env.LINUX_AGENT_BINARY ??
          `/tmp/pipker-agent-linux-${process.arch === "x64" ? "amd64" : "arm64"}`,
        container + ":/usr/local/bin/pipkerops-agent",
      );
      const fixture = await prepareContainerAgent(container, run);
      fixture.start();
      await waitForAgent(fixture.connection);
      const node = await rpc<{ id: string }>("nodes.import", {
        connection: fixture.connection,
        confirmed: true,
      });
      nodeId = node.id;
      const telemetry = await wait(
        () => db().metricSample.findFirst({ where: { nodeId } }),
        Boolean,
        "Linux metrics",
      );
      assert.ok(
        Array.isArray((telemetry!.payload as Record<string, unknown>).disk),
      );
      const identities = (
        telemetry!.payload as {
          deviceIdentity: { network: Record<string, string> };
        }
      ).deviceIdentity;
      assert.ok(
        Object.keys(identities.network).length > 0,
        "Linux network identity must be discovered from actual sysfs",
      );
      const longDisk = await rpc<{
        device: string | null;
        series: { points: unknown[] }[];
      }>("nodes.history", { nodeId, kind: "disk", hours: 168 });
      assert.ok(
        longDisk.device && longDisk.series[0]?.points.length,
        "long history must merge actual raw tail before maintenance",
      );
      const disk = await rpc<{
        device: string | null;
        series: { points: unknown[] }[];
      }>("nodes.history", { nodeId, kind: "disk", hours: 1 });
      assert.ok(
        disk.device && disk.series[0]?.points.length,
        "overlay root must expose real capacity history",
      );
      const info = await task("system.info");
      assert.equal((info.result as { os: string }).os, "linux");
      await task("shell.exec", {
        script:
          "mkdir -p /tmp/pipkerops-check; printf Linux > /tmp/pipkerops-check/shell.txt",
      });
      await task("files.write", {
        path: "/tmp/pipkerops-check/file.txt",
        content: "verified-file",
      });
      const file = await task("files.read", {
        path: "/tmp/pipkerops-check/file.txt",
      });
      assert.ok(JSON.stringify(file).includes("verified-file"));
      await task("files.list", { path: "/tmp/pipkerops-check" });
      await task("files.remove", { path: "/tmp/pipkerops-check/file.txt" });
      console.log(
        "Verified Linux metrics, Shell and file read/write/list/remove",
      );
      await task("docker.pull", { image: "alpine:3.22" });
      await task("compose.deploy", {
        project: run,
        yaml: 'services:\n  sleeper:\n    image: alpine:3.22\n    command: [sh, -c, "echo acceptance-ready; sleep 600"]\n',
      });
      const list = await task("docker.list");
      assert.ok(JSON.stringify(list).includes(run));
      const id = docker(
        "exec",
        container,
        "docker",
        "ps",
        "--filter",
        `label=com.docker.compose.project=${run}`,
        "--format",
        "{{.ID}}",
      ).trim();
      assert.ok(id);
      await task("docker.stats", { id });
      const logs = await task("docker.logs", { id, tail: 20 });
      assert.ok(logs.output.includes("acceptance-ready"));
      const compose = await task("compose.read", { project: run });
      assert.ok(String(compose.result.yaml).includes("sleeper"));
      await task("compose.status", { project: run });
      const failedProject = run + "-failed";
      const failedYaml =
        'services:\n  broken:\n    image: alpine:3.22\n    user: pipkerops-user-does-not-exist\n    command: [sh, -c, "sleep 600"]\n';
      const failedDeploy = await task(
        "compose.deploy",
        { project: failedProject, yaml: failedYaml },
        false,
      );
      assert.equal(failedDeploy.result.configurationSaved, true);
      assert.equal(failedDeploy.result.applySucceeded, false);
      assert.equal(failedDeploy.result.runtimeMayBePartial, true);
      assert.match(
        failedDeploy.error ?? "",
        /runtime resources may be partially changed/,
      );
      assert.equal(
        (await task("compose.read", { project: failedProject })).result.yaml,
        failedYaml,
      );
      const failedStatus = await task("compose.status", {
        project: failedProject,
      });
      assert.ok(JSON.stringify(failedStatus).includes("broken"));
      const failedContainer = docker(
        "exec",
        container,
        "docker",
        "inspect",
        "--format",
        "{{.State.Status}}",
        failedProject + "-broken-1",
      ).trim();
      assert.equal(failedContainer, "created");
      const recovered = await task("compose.deploy", {
        project: failedProject,
        yaml: failedYaml.replace(
          "    user: pipkerops-user-does-not-exist\n",
          "",
        ),
      });
      assert.equal(recovered.result.configurationSaved, true);
      assert.equal(recovered.result.applySucceeded, true);
      assert.equal(recovered.result.runtimeMayBePartial, undefined);
      console.log(
        "Verified Compose runtime failure retains configuration, reports partial changes and recovers only after explicit configuration correction",
      );
      const inspected = await task("docker.inspect", {
        id: run + "-sleeper-1",
      });
      assert.equal(
        (inspected.result.containers as { Name: string }[])[0].Name,
        "/" + run + "-sleeper-1",
      );
      await task("docker.inspect", { id: "missing-" + run }, false);
      assert.ok(!JSON.stringify(inspected).includes('"Env"'));
      assert.ok(!JSON.stringify(inspected).includes('"Cmd"'));
      await task("compose.list");
      await task("docker.action", { id, action: "stop" });
      await task("docker.action", { id, action: "start" });
      await terminal();
      await terminal(id);
      console.log(
        "Verified Docker discovery/stats/logs/lifecycle, Compose deploy/read/status/list and real node/container PTY",
      );
      docker("exec", container, "nginx");
      const site = await rpc<{ id: string }>("sites.save", {
        name: run,
        nodeId,
        domain: "linux-acceptance.example.invalid",
        upstream: "http://127.0.0.1:8080",
        config:
          'server { listen 8088; server_name linux-acceptance.example.invalid; location / { return 200 "nginx-verified"; } }',
      });
      siteId = site.id;
      const app = await rpc<{ id: string }>("applications.save", { name: run });
      applicationId = app.id;
      const resource = await rpc<ResourceData>("resources.register", {
        nodeId,
        containerId: id.trim(),
        name: run,
        strategy: "compose",
        confirmed: true,
      });
      resourceId = resource.id;
      await rpc("resources.associate", {
        resourceId: resource.id,
        applicationId,
      });
      await assert.rejects(
        rpc("resources.register", {
          nodeId,
          containerId: id.trim(),
          name: run + "-duplicate",
          strategy: "name",
          confirmed: true,
        }),
        /已登记/,
      );
      const probe = await rpc<{ id: string }>("probes.save", {
        name: run,
        type: "HTTP",
        sourceNodeId: nodeId,
        applicationId,
        target: "http://127.0.0.1:8080/health",
      });
      probeId = probe.id;
      const related = await wait(
        () =>
          rpc<
            Omit<Parameters<typeof topologyLinks>[0], "applications"> & {
              resources: ResourceData[];
              applications: {
                id: string;
                deployments: {
                  id: string;
                  nodeId: string;
                  type: string;
                  target: string;
                }[];
                resources: { resourceId: string }[];
              }[];
            }
          >("topology"),
        (r) =>
          r.resources.some(
            (item) =>
              item.id === resource.id &&
              item.instances.some((c) => c.id === id.trim()),
          ),
        "stable topology service resource",
      );
      assert.ok(
        related.applications
          .find((a) => a.id === applicationId)
          ?.resources.some((l) => l.resourceId === resource.id),
      );
      assert.ok(
        topologyLinks(related).siteLinks.some(
          (l) => l.siteId === siteId && l.applicationId === applicationId,
        ),
      );
      await rpc("resources.unlink", {
        resourceId: resource.id,
        applicationId,
        confirmed: true,
      });
      const unlinked = await rpc<ResourceData>("resources.get", {
        resourceId: resource.id,
      });
      assert.equal(unlinked.id, resource.id);
      assert.equal(unlinked.applications.length, 0);
      console.log(
        "Verified stable topology resource identity, Compose service labels, Nginx upstream and independent unlink",
      );
      const applied = await rpc<{ id: string }>("sites.apply", {
        id: siteId,
        confirmed: true,
      });
      await wait(
        () =>
          rpc<{ status: string; error?: string }>("tasks.get", {
            id: applied.id,
          }),
        (t) => t.status === "SUCCEEDED",
        "Nginx apply",
      );
      assert.equal(
        docker("exec", container, "curl", "-fsS", "http://127.0.0.1:8088"),
        "nginx-verified",
      );
      await task(
        "nginx.apply",
        {
          domain: "linux-acceptance.example.invalid",
          config: "server { invalid_syntax; }",
        },
        false,
      );
      assert.equal(
        docker("exec", container, "curl", "-fsS", "http://127.0.0.1:8088"),
        "nginx-verified",
      );
      await task("nginx.check");
      const cert = await task("nginx.certificate", {
        domain: "linux-acceptance.example.invalid",
      });
      assert.equal(cert.result.exists, false);
      console.log(
        "Verified real Nginx syntax validation, apply, invalid-config rollback and missing-certificate reporting",
      );
      const removing = await rpc<{ id: string }>("sites.delete", {
        id: siteId,
        confirmed: true,
      });
      await wait(
        () => rpc<{ status: string }>("tasks.get", { id: removing.id }),
        (t) => t.status === "SUCCEEDED",
        "remove managed Nginx site",
      );
      assert.equal(await db().site.count({ where: { id: siteId } }), 0);
      siteId = "";
      console.log(
        "Verified managed site deletion removes configuration and platform record only after reload",
      );
      const uncertain = await rpc<{ id: string }>("tasks.create", {
        type: "shell.exec",
        nodeId,
        payload: {
          script: "echo once >> /tmp/non-idempotent-count; sleep 15; echo done",
          timeoutSeconds: 30,
        },
        confirmed: true,
      });
      await wait(
        () => rpc<{ status: string }>("tasks.get", { id: uncertain.id }),
        (t) => t.status === "RUNNING",
        "non-idempotent running",
      );
      await wait(
        async () => {
          try {
            return docker(
              "exec",
              container,
              "cat",
              "/tmp/non-idempotent-count",
            );
          } catch {
            return "";
          }
        },
        (s) => s.includes("once"),
        "side effect before crash",
      );
      docker("exec", container, "sh", "-c", "kill -9 $(pidof pipkerops-agent)");
      fixture.start();
      await waitForAgent(fixture.connection);
      const reconciled = await wait(
        () =>
          rpc<{ status: string; attempts: number }>("tasks.get", {
            id: uncertain.id,
          }),
        (t) => t.status === "UNKNOWN",
        "crash journal reconciliation",
      );
      assert.equal(reconciled.attempts, 1);
      assert.equal(
        docker("exec", container, "cat", "/tmp/non-idempotent-count").trim(),
        "once",
      );
      console.log(
        "Verified Agent crash preserves UNKNOWN and does not replay a non-idempotent side effect",
      );
    } catch (error) {
      if (container) {
        try {
          console.error(
            docker("exec", container, "cat", "/tmp/agent.log").replace(
              /(?:token|password)[^\n]*/gi,
              "[redacted]",
            ),
          );
        } catch {}
      }
      throw error;
    } finally {
      if (container) docker("rm", "-fv", container);
      if (siteId) await db().site.deleteMany({ where: { id: siteId } });
      if (probeId) await db().probe.deleteMany({ where: { id: probeId } });
      if (applicationId)
        await db().application.deleteMany({ where: { id: applicationId } });
      if (resourceId)
        await db().resource.deleteMany({ where: { id: resourceId } });
      if (nodeId) {
        await db().task.deleteMany({ where: { nodeId } });
        await db().node.deleteMany({ where: { id: nodeId } });
      }
      await db().$disconnect();
    }
  },
);
