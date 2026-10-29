/** Full systemd/ufw/software/verified upgrade acceptance in a disposable Linux container. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { randomUUID, createHash } from "node:crypto";
import { db } from "../src/lib/db";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });
const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
async function wait<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  label: string,
  timeout = 90000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out: " + label);
}
test(
  "systemd真实服务、UFW、软件安装及HTTPS升级ACK后重启",
  { timeout: 600000 },
  async () => {
    const run = "systemd-" + randomUUID().slice(0, 8);
    let container = "",
      nodeId = "",
      tokenId = "";
    const binary = readFileSync(
      process.env.LINUX_AGENT_BINARY ??
        `/tmp/pipker-agent-linux-${process.arch === "x64" ? "amd64" : "arm64"}`,
    );
    const upgradeServer = createServer(
      {
        key: readFileSync(".data/pki/server-linux.key"),
        cert: readFileSync(".data/pki/server-linux.crt"),
      },
      (req, res) => {
        if (req.url !== "/agent") {
          res.writeHead(404).end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(binary);
      },
    );
    await new Promise<void>((resolve) =>
      upgradeServer.listen(0, "0.0.0.0", resolve),
    );
    const address = upgradeServer.address();
    assert.ok(address && typeof address !== "string");
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
            status: string;
            error?: string;
            output: string;
            result: Record<string, unknown>;
          }>("tasks.get", { id: t.id }),
        (t) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(t.status),
        type,
        type === "software.install" ? 350000 : 150000,
      );
      assert.equal(
        result.status,
        success ? "SUCCEEDED" : "FAILED",
        `${type}: ${result.error ?? result.output}`,
      );
      return result;
    }
    const write = (path: string, input: Buffer | string, mode = "600") =>
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          container,
          "sh",
          "-c",
          `cat > ${path}; chmod ${mode} ${path}`,
        ],
        { input, stdio: ["pipe", "pipe", "pipe"] },
      );
    try {
      container = docker(
        "run",
        "-d",
        "--privileged",
        "--cgroupns=private",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/run/lock",
        "--name",
        run,
        "--label",
        "pipkerops.acceptance=true",
        "pipkerops-systemd-fixture:local",
      ).trim();
      await wait(
        async () => {
          try {
            return docker(
              "exec",
              container,
              "systemctl",
              "is-system-running",
            ).trim();
          } catch (error) {
            return String((error as { stdout?: string }).stdout ?? "").trim();
          }
        },
        (s) => ["running", "degraded"].includes(s),
        "systemd PID1",
      );
      write("/usr/local/bin/pipker-agent", binary, "755");
      docker(
        "exec",
        container,
        "mkdir",
        "-p",
        "/etc/pipkerops",
        "/var/lib/pipkerops-agent",
      );
      write("/etc/pipkerops/ca.crt", readFileSync(".data/pki/ca.crt"), "644");
      write(
        "/usr/local/share/ca-certificates/pipkerops-test.crt",
        readFileSync(".data/pki/ca.crt"),
        "644",
      );
      docker("exec", container, "update-ca-certificates");
      write(
        "/etc/systemd/system/pipkerops-agent.service",
        readFileSync("agent/pipkerops-agent.service"),
        "644",
      );
      const token = await rpc<{ id: string; token: string }>("nodes.token", {
        name: run,
        hours: 1,
        maxUses: 1,
      });
      tokenId = token.id;
      write("/etc/pipkerops/token", token.token);
      write(
        "/etc/pipkerops/agent.env",
        `PIPKEROPS_GATEWAY=wss://host.docker.internal:9543/agent\nPIPKEROPS_ENROLL_URL=https://host.docker.internal:9544\nPIPKEROPS_CA=/etc/pipkerops/ca.crt\nPIPKEROPS_TOKEN_FILE=/etc/pipkerops/token\nPIPKEROPS_NAME=${run}\nPIPKEROPS_STATE_DIR=/var/lib/pipkerops-agent\n`,
      );
      docker("exec", container, "systemctl", "daemon-reload");
      docker("exec", container, "systemctl", "start", "pipkerops-agent");
      const node = await wait(
        () => db().node.findFirst({ where: { name: run } }),
        Boolean,
        "systemd Agent enrollment",
      );
      assert.ok(node);
      nodeId = node.id;
      await rpc("nodes.approve", { id: nodeId, confirmed: true });
      await wait(
        () => db().metricSample.findFirst({ where: { nodeId } }),
        Boolean,
        "systemd Agent metrics",
      );
      const services = await task("systemd.list");
      assert.ok(JSON.stringify(services).includes("nginx"));
      await task("systemd.action", { name: "nginx.service", action: "start" });
      assert.equal(
        docker("exec", container, "systemctl", "is-active", "nginx").trim(),
        "active",
      );
      await task("systemd.action", { name: "nginx.service", action: "reload" });
      await task("systemd.action", { name: "nginx.service", action: "stop" });
      assert.equal(
        docker(
          "exec",
          container,
          "systemctl",
          "show",
          "--property=ActiveState",
          "--value",
          "nginx",
        ).trim(),
        "inactive",
      );
      await task("firewall.list");
      await task("firewall.rule", {
        action: "allow",
        port: 18080,
        protocol: "tcp",
      });
      assert.ok(
        docker("exec", container, "ufw", "show", "added").includes("18080/tcp"),
      );
      await task("firewall.rule", {
        action: "delete",
        port: 18080,
        protocol: "tcp",
      });
      await task("software.install", { name: "htop" });
      assert.ok(
        docker("exec", container, "htop", "--version").includes("htop"),
      );
      console.log(
        "Verified systemd list/start/reload/stop, UFW add/delete and real software package install",
      );
      const pidBefore = docker(
        "exec",
        container,
        "systemctl",
        "show",
        "--property=MainPID",
        "--value",
        "pipkerops-agent",
      ).trim();
      assert.notEqual(pidBefore, "0");
      const digest = createHash("sha256").update(binary).digest("hex");
      await task(
        "agent.upgrade",
        {
          url: `https://host.docker.internal:${address.port}/agent`,
          sha256: "0".repeat(64),
          restart: false,
        },
        false,
      );
      assert.equal(
        docker(
          "exec",
          container,
          "sha256sum",
          "/usr/local/bin/pipker-agent",
        ).split(" ")[0],
        digest,
      );
      await task("agent.upgrade", {
        url: `https://host.docker.internal:${address.port}/agent`,
        sha256: digest,
        restart: true,
      });
      await wait(
        async () =>
          docker(
            "exec",
            container,
            "systemctl",
            "show",
            "--property=MainPID",
            "--value",
            "pipkerops-agent",
          ).trim(),
        (pid) => pid !== "0" && pid !== pidBefore,
        "Agent restarts after durable task ACK",
        30000,
      );
      assert.equal(
        docker(
          "exec",
          container,
          "sha256sum",
          "/usr/local/bin/pipker-agent.previous",
        ).split(" ")[0],
        digest,
      );
      await task("system.info");
      console.log(
        "Verified HTTPS upgrade hash rejection, .previous backup and real systemd Agent restart after successful result ACK",
      );
    } catch (error) {
      if (container) {
        try {
          console.error(
            docker(
              "exec",
              container,
              "journalctl",
              "-u",
              "pipkerops-agent",
              "--no-pager",
              "-n",
              "15",
            ),
          );
        } catch {}
      }
      throw error;
    } finally {
      upgradeServer.close();
      if (container) docker("rm", "-fv", container);
      const owned = await db().node.findMany({
        where: { name: run },
        select: { id: true },
      });
      for (const n of owned) {
        await db().task.deleteMany({ where: { nodeId: n.id } });
        await db().node.deleteMany({ where: { id: n.id } });
      }
      if (tokenId)
        await db().enrollmentToken.deleteMany({ where: { id: tokenId } });
      await db().$disconnect();
    }
  },
);
