import {
  integrationOrigin,
  proxyHeaders,
  prepareContainerAgent,
  waitForAgent,
  uploadArtifact,
  agentRequest,
} from "./helpers/agent-fixture";
import { configValues } from "../src/lib/config";
/** Full systemd/ufw/software/verified upgrade acceptance in a disposable Linux container. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { db } from "../src/lib/db";
import { topologyLinks } from "../src/lib/topology-links";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });
const origin = integrationOrigin;
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
  async (t) => {
    const run = "systemd-" + randomUUID().slice(0, 8);
    let container = "",
      nodeId = "";
    let applicationId = "";
    const binary = readFileSync(
      process.env.LINUX_AGENT_BINARY ??
        `/tmp/pipker-agent-linux-${process.arch === "x64" ? "amd64" : "arm64"}`,
    );
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
        "-p",
        "127.0.0.1::9443",
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
      const fixture = await prepareContainerAgent(
        container,
        run,
        "/usr/local/bin/pipker-agent",
      );
      const configDirectory = `${fixture.root}/config/agent`;
      docker("exec", container, "mkdir", "-p", configDirectory);
      write(
        "/etc/systemd/system/pipkerops-agent.service",
        readFileSync("agent/pipkerops-agent.service"),
        "644",
      );
      write(
        `${configDirectory}/agent.env`,
        [
          "PIPKEROPS_LISTEN=0.0.0.0:9443",
          `PIPKEROPS_URL=${fixture.connection.url}`,
          `PIPKEROPS_NAME=${run}`,
          `PIPKEROPS_STATE_DIR=${fixture.state}`,
          `PIPKEROPS_DEPLOY_ROOT=${fixture.root}`,
          "",
        ].join("\n"),
      );
      docker("exec", container, "systemctl", "daemon-reload");
      docker("exec", container, "systemctl", "start", "pipkerops-agent");
      await waitForAgent(fixture.connection);
      const node = await rpc<{ id: string }>("nodes.import", {
        connection: fixture.connection,
        confirmed: true,
      });
      nodeId = node.id;
      await wait(
        () => db().metricSample.findFirst({ where: { nodeId } }),
        Boolean,
        "systemd Agent metrics",
      );
      const scoped = await task("systemd.list", { name: "nginx.service" });
      const units = JSON.parse(scoped.output) as { unit: string }[];
      assert.equal(units.length, 1);
      assert.equal(units[0].unit, "nginx.service");
      const services = await task("systemd.list");
      assert.ok(JSON.stringify(services).includes("nginx"));
      const app = await rpc<{ id: string }>("applications.save", { name: run });
      applicationId = app.id;
      const deployment = await rpc<{ id: string }>("deployments.save", {
        applicationId,
        nodeId,
        type: "systemd",
        name: run,
        target: "nginx.service",
      });
      const serviceState = async () =>
        topologyLinks(
          await rpc<Parameters<typeof topologyLinks>[0]>("topology"),
        ).deploymentLinks.find((l) => l.deploymentId === deployment.id)?.state;
      await task("systemd.action", { name: "nginx.service", action: "start" });
      await wait(
        serviceState,
        (s) => s === "HEALTHY",
        "discovered service active",
      );
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
      await wait(
        serviceState,
        (s) => s === "UNHEALTHY",
        "discovered service stopped",
      );
      await task("systemd.action", { name: "nginx.service", action: "start" });
      await wait(
        serviceState,
        (s) => s === "HEALTHY",
        "discovered service recovered",
      );
      await rpc("deployments.delete", { id: deployment.id, confirmed: true });
      assert.equal(await serviceState(), undefined);
      console.log(
        "Verified real systemd discovery, exact deployment identity, stop/recovery refresh and unlink",
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
      await t.test("真实软件安装", async () => {
        await task("software.install", { name: "htop" });
        assert.ok(
          docker("exec", container, "htop", "--version").includes("htop"),
        );
        console.log("Verified real software package install");
      });
      console.log("Verified systemd list/start/reload/stop and UFW add/delete");
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
      assert.equal(
        (
          await agentRequest(
            fixture.connection,
            `/v1/artifacts/${"0".repeat(64)}`,
            binary,
          )
        ).status,
        400,
      );
      assert.equal(await uploadArtifact(fixture.connection, binary), digest);
      await task(
        "agent.upgrade",
        { artifactId: digest, sha256: "0".repeat(64), restart: false },
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
      const upgraded = await task("agent.upgrade", {
        artifactId: digest,
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
      await waitForAgent(fixture.connection);
      const retained = JSON.parse(
        docker(
          "exec",
          container,
          "/usr/local/bin/pipker-agent",
          ...fixture.args,
          "--export-connection",
        ),
      );
      assert.equal(
        createHash("sha256").update(JSON.stringify(retained)).digest("hex"),
        createHash("sha256")
          .update(JSON.stringify(fixture.connection))
          .digest("hex"),
        "Agent upgrade must preserve the full connection package",
      );
      const journal = JSON.parse(
        docker(
          "exec",
          container,
          "cat",
          `${fixture.state}/tasks/${upgraded.id}.json`,
        ),
      );
      assert.equal(journal.acknowledged, true);
      assert.equal(journal.restartDispatched, true);
      await task("system.info");
      console.log(
        "Verified artifact hash rejection, .previous backup, durable ACK before systemd restart and unchanged Agent credentials",
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
      if (container) docker("rm", "-fv", container);
      if (applicationId)
        await db().application.deleteMany({ where: { id: applicationId } });
      const owned = await db().node.findMany({
        where: { name: run },
        select: { id: true },
      });
      for (const n of owned) {
        await db().task.deleteMany({ where: { nodeId: n.id } });
        await db().node.deleteMany({ where: { id: n.id } });
      }
      await db().$disconnect();
    }
  },
);
