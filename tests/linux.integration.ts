/** Real operations in an isolated privileged Docker-in-Docker Linux node.
 * Never mounts the host Docker socket or host filesystem into the fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { db } from "../src/lib/db";
const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
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
    let tokenId = "";
    let siteId = "";
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
    async function rpc<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const r = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          Origin: origin,
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
      const ticket = await rpc<{ url: string }>("terminal.ticket", {
        nodeId,
        containerId,
        confirmed: true,
      });
      const url = new URL(ticket.url);
      url.hostname = "localhost";
      url.port = "9544";
      const ws = new WebSocket(url, {
        ca: readFileSync(".data/pki/ca.crt"),
        origin,
      });
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
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          container,
          "sh",
          "-c",
          "cat > /tmp/pipkerops-ca.crt; chmod 644 /tmp/pipkerops-ca.crt",
        ],
        { input: readFileSync(".data/pki/ca.crt") },
      );
      const token = await rpc<{ id: string; token: string }>("nodes.token", {
        name: run,
        hours: 1,
        maxUses: 1,
      });
      tokenId = token.id;
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          container,
          "sh",
          "-c",
          "umask 077; cat > /tmp/enrollment-token",
        ],
        { input: token.token, stdio: ["pipe", "pipe", "pipe"] },
      );
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
        "/tmp/pipkerops-ca.crt",
        "--token-file",
        "/tmp/enrollment-token",
        "--state-dir",
        "/var/lib/pipkerops-agent",
        "--name",
        run,
      );
      const node = await wait(
        () => db().node.findFirst({ where: { name: run } }),
        (n) => !!n,
        "Linux enrollment",
      );
      assert.ok(node);
      nodeId = node.id;
      await rpc("nodes.approve", { id: nodeId, confirmed: true });
      await wait(
        () => db().metricSample.findFirst({ where: { nodeId } }),
        Boolean,
        "Linux metrics",
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
      docker(
        "exec",
        "-d",
        container,
        "sh",
        "-c",
        "exec pipkerops-agent --gateway wss://host.docker.internal:9543/agent --enroll-url https://host.docker.internal:9544 --ca /tmp/pipkerops-ca.crt --state-dir /var/lib/pipkerops-agent --name " +
          run +
          " >/tmp/agent-restart.log 2>&1",
      );
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
      if (nodeId) {
        await db().task.deleteMany({ where: { nodeId } });
        await db().node.deleteMany({ where: { id: nodeId } });
      }
      if (tokenId)
        await db().enrollmentToken.deleteMany({ where: { id: tokenId } });
      await db().$disconnect();
    }
  },
);
