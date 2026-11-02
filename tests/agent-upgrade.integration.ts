import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const repository = resolve(import.meta.dirname, "..");
const service = "pipkerops-agent.service";
const deployRoot = "/opt/pipkerops-upgrade-fixture";
const oldVersion = "0.1.100";
const newVersion = "0.1.101";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Connection = {
  format: number;
  protocolVersion: number;
  agentId: string;
  url: string;
  caPem: string;
  accessKey: string;
  deployRoot: string;
};
type Message = {
  type: string;
  agentId?: string;
  taskId?: string;
  success?: boolean;
  error?: string;
  result?: Record<string, unknown>;
  payload?: { agentVersion?: string };
};
type Journal = {
  taskId: string;
  state: string;
  acknowledged: boolean;
  restartRequested?: boolean;
  restartDispatched?: boolean;
  response: Message;
};

function docker(...args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function wait<T>(
  operation: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}

async function agentRequest<T>(
  connection: Connection,
  path: string,
  method = "GET",
  body?: Buffer,
) {
  return new Promise<{ status: number; body: T }>((done, reject) => {
    const req = request(
      new URL(path, connection.url),
      {
        method,
        ca: connection.caPem,
        rejectUnauthorized: true,
        headers: {
          Authorization: `Bearer ${connection.accessKey}`,
          ...(body ? { "Content-Length": body.length } : {}),
        },
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            done({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
            });
          } catch {
            reject(new Error("Agent returned a non-JSON response"));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Agent request timed out")));
    req.end(body);
  });
}

async function connect(connection: Connection) {
  const url = new URL("/v1/connect", connection.url);
  url.protocol = "wss:";
  const socket = new WebSocket(url, {
    ca: connection.caPem,
    rejectUnauthorized: true,
    headers: { Authorization: `Bearer ${connection.accessKey}` },
  });
  const messages: Message[] = [];
  let failure: Error | undefined;
  let closed = false;
  socket.on("error", (error) => (failure = error));
  socket.on("close", () => (closed = true));
  socket.on("message", (data) => {
    try {
      messages.push(JSON.parse(data.toString()) as Message);
    } catch {
      failure = new Error("Agent returned an invalid WebSocket message");
    }
  });
  const receive = async (predicate: (message: Message) => boolean) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (failure) throw failure;
      if (closed) throw new Error("Agent connection closed before a response");
      await sleep(25);
    }
    throw new Error("Timed out waiting for an Agent WebSocket message");
  };
  const hello = await receive((message) => message.type === "connected");
  assert.equal(hello.agentId, connection.agentId);
  return {
    socket,
    receive,
    send(message: unknown) {
      return new Promise<void>((done, reject) => {
        socket.send(JSON.stringify(message), (error) =>
          error ? reject(error) : done(),
        );
      });
    },
  };
}

test(
  "real Agent version upgrade waits for durable ACK, restarts once and preserves identity",
  { timeout: 240_000 },
  async (t) => {
    const image =
      process.env.AGENT_UPGRADE_IMAGE ?? "pipkerops-systemd-fixture:local";
    const architecture = docker(
      "image",
      "inspect",
      image,
      "--format",
      "{{.Architecture}}",
    );
    assert.ok(
      architecture === "amd64" || architecture === "arm64",
      "the systemd image must use a supported Agent architecture",
    );
    const fixture = realpathSync(
      mkdtempSync(join(tmpdir(), "pipker-agent-upgrade-")),
    );
    const container = `pipker-agent-upgrade-${randomUUID().slice(0, 12)}`;
    const sessions: Awaited<ReturnType<typeof connect>>[] = [];
    let created = false;
    const inside = (...args: string[]) => docker("exec", container, ...args);
    const hashFile = (path: string) =>
      inside("sha256sum", path).split(/\s+/)[0];
    const mainPID = () =>
      Number(
        inside("systemctl", "show", service, "--property=MainPID", "--value"),
      );
    const readJournal = (taskId: string) =>
      JSON.parse(
        inside("cat", `${deployRoot}/data/agent/tasks/${taskId}.json`),
      ) as Journal;
    const exportConnection = () =>
      JSON.parse(
        inside(
          "/usr/local/bin/pipker-agent",
          "--deploy-root",
          deployRoot,
          "--url",
          publicURL,
          "--name",
          "upgrade-fixture",
          "--export-connection",
        ),
      ) as Connection;
    let publicURL = "";
    try {
      docker(
        "run",
        "--detach",
        "--privileged",
        "--cgroupns=private",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/run/lock",
        "--name",
        container,
        "--label",
        "pipkerops.acceptance=agent-upgrade",
        "--publish",
        "127.0.0.1::9443",
        image,
      );
      created = true;
      await wait(
        () => inside("systemctl", "show", "--property=SystemState", "--value"),
        (state) => state === "running" || state === "degraded",
        "isolated container systemd boot",
      );
      assert.match(inside("python3", "--version"), /^Python 3\./);
      assert.match(inside("systemctl", "--version"), /^systemd \d+/);
      assert.equal(
        inside("sh", "-c", "test ! -S /var/run/docker.sock && printf isolated"),
        "isolated",
        "the fixture must not receive the host Docker socket",
      );
      t.diagnostic(
        "Isolated systemd and Python runtime verified; building two Agent versions.",
      );
      const published = docker("port", container, "9443/tcp");
      assert.match(published, /^127\.0\.0\.1:\d+$/);
      publicURL = `https://${published}`;
      const versions = [oldVersion, newVersion];
      const binaries = versions.map((version) =>
        join(fixture, `agent-${version}`),
      );
      for (const [index, version] of versions.entries()) {
        execFileSync(
          process.env.GO ?? "go",
          [
            "build",
            "-ldflags",
            `-X github.com/holic512/PipkerOps/agent/internal/agent.Version=${version}`,
            "-o",
            binaries[index],
            "./cmd/pipker-agent",
          ],
          {
            cwd: join(repository, "agent"),
            env: {
              ...process.env,
              GOOS: "linux",
              GOARCH: architecture,
              CGO_ENABLED: "0",
              GOCACHE:
                process.env.GOCACHE ?? join(tmpdir(), "pipkerops-go-cache"),
            },
            stdio: "pipe",
            timeout: 90_000,
          },
        );
      }
      const oldDigest = sha256(readFileSync(binaries[0]));
      const newBinary = readFileSync(binaries[1]);
      const newDigest = sha256(newBinary);
      assert.notEqual(oldDigest, newDigest);
      inside("mkdir", "-p", "/tmp/pipker-agent-installer");
      for (const file of [
        "install.sh",
        "pipkerops-agent.service",
        "agent.env.example",
      ]) {
        docker(
          "cp",
          join(repository, "agent", file),
          `${container}:/tmp/pipker-agent-installer/${file}`,
        );
      }
      docker(
        "cp",
        binaries[0],
        `${container}:/tmp/pipker-agent-installer/agent-old`,
      );
      inside(
        "sh",
        "/tmp/pipker-agent-installer/install.sh",
        "/tmp/pipker-agent-installer/agent-old",
        deployRoot,
      );
      assert.equal(
        mainPID(),
        0,
        "the installer must leave service startup explicit",
      );
      const configuration = Object.entries({
        PIPKEROPS_LISTEN: "0.0.0.0:9443",
        PIPKEROPS_URL: publicURL,
        PIPKEROPS_NAME: "upgrade-fixture",
        PIPKEROPS_DEPLOY_ROOT: deployRoot,
        PIPKEROPS_STATE_DIR: `${deployRoot}/data/agent`,
      })
        .map(([name, value]) => `${name}=${JSON.stringify(value)}\n`)
        .join("");
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          container,
          "sh",
          "-c",
          'umask 077; cat > "$1"',
          "--",
          `${deployRoot}/config/agent/agent.env`,
        ],
        {
          input: configuration,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30_000,
        },
      );
      inside(
        "sh",
        "-c",
        'printf durable-state > "$1"',
        "--",
        `${deployRoot}/data/agent/upgrade-sentinel`,
      );
      inside("systemctl", "enable", "--now", service);
      await wait(
        () =>
          inside(
            "test",
            "-s",
            `${deployRoot}/data/agent/identity/identity.json`,
          ),
        () => true,
        "Agent generated private identity",
      );
      const connection = await wait(
        exportConnection,
        (value) => value.format === 1 && value.protocolVersion === 1,
        "private Agent connection package",
      );
      assert.equal(connection.deployRoot, deployRoot);
      assert.equal(connection.url, publicURL);
      const info = () =>
        agentRequest<{ agentVersion: string; agentId: string }>(
          connection,
          "/v1/info",
        );
      await wait(
        info,
        (value) =>
          value.status === 200 && value.body.agentVersion === oldVersion,
        "old Agent HTTPS service",
      );
      const originalPID = mainPID();
      assert.ok(originalPID > 1);
      const preservedPaths = [
        `${deployRoot}/config/agent/agent.env`,
        `${deployRoot}/data/agent/identity/identity.json`,
        `${deployRoot}/data/agent/upgrade-sentinel`,
        `${deployRoot}/.pipkerops-installation.json`,
      ];
      const privateSnapshot = {
        connection: sha256(JSON.stringify(connection)),
        files: preservedPaths.map(hashFile),
      };
      const uploaded = await agentRequest<{ sha256: string; size: number }>(
        connection,
        `/v1/artifacts/${newDigest}`,
        "PUT",
        newBinary,
      );
      assert.equal(uploaded.status, 200);
      assert.deepEqual(uploaded.body, {
        sha256: newDigest,
        size: newBinary.length,
      });
      const first = await connect(connection);
      sessions.push(first);
      const taskId = `upgrade_${randomUUID().replaceAll("-", "")}`;
      const task = {
        type: "task",
        task: {
          id: taskId,
          type: "agent.upgrade",
          payload: { artifactId: newDigest, sha256: newDigest, restart: true },
        },
      };
      await first.send(task);
      const result = await first.receive(
        (message) =>
          message.type === "task.result" && message.taskId === taskId,
      );
      assert.equal(
        result.success,
        true,
        result.error ?? "Agent upgrade failed",
      );
      assert.equal(result.result?.sha256, newDigest);
      assert.equal(result.result?.restartAfterAck, true);
      const beforeAck = readJournal(taskId);
      assert.equal(beforeAck.state, "DONE");
      assert.equal(beforeAck.response.success, true);
      assert.equal(beforeAck.acknowledged, false);
      assert.equal(beforeAck.restartRequested, true);
      assert.equal(beforeAck.restartDispatched ?? false, false);
      assert.equal(hashFile("/usr/local/bin/pipker-agent"), newDigest);
      assert.equal(hashFile("/usr/local/bin/pipker-agent.previous"), oldDigest);
      await sleep(3_000);
      assert.equal(
        mainPID(),
        originalPID,
        "an unacknowledged upgrade must not restart the process",
      );
      assert.equal((await info()).body.agentVersion, oldVersion);
      t.diagnostic(
        "Upgrade result persisted; installed binary changed while the original PID waits for ACK.",
      );
      await first.send({ type: "task.ack", taskId });
      await wait(
        () => readJournal(taskId),
        (value) => value.acknowledged,
        "durable upgrade ACK",
      );
      const upgradedPID = await wait(
        mainPID,
        (pid) => pid > 1 && pid !== originalPID,
        "systemd Agent restart after ACK",
      );
      const upgradedInfo = await wait(
        info,
        (value) =>
          value.status === 200 && value.body.agentVersion === newVersion,
        "new Agent version over trusted HTTPS",
      );
      assert.equal(upgradedInfo.body.agentId, connection.agentId);
      const afterRestart = readJournal(taskId);
      assert.equal(afterRestart.state, "DONE");
      assert.equal(afterRestart.acknowledged, true);
      assert.equal(afterRestart.restartDispatched, true);
      assert.equal(hashFile("/usr/local/bin/pipker-agent.previous"), oldDigest);
      assert.equal(
        sha256(JSON.stringify(exportConnection())),
        privateSnapshot.connection,
        "the complete private connection package must survive the upgrade",
      );
      assert.deepEqual(
        preservedPaths.map(hashFile),
        privateSnapshot.files,
        "configuration, private identity and existing data must be preserved",
      );
      const second = await connect(connection);
      sessions.push(second);
      const heartbeat = await second.receive(
        (message) => message.type === "heartbeat",
      );
      assert.equal(heartbeat.payload?.agentVersion, newVersion);
      await second.send(task);
      const duplicate = await second.receive(
        (message) =>
          message.type === "task.result" && message.taskId === taskId,
      );
      assert.deepEqual(
        duplicate,
        result,
        "a duplicate task must replay the durable result",
      );
      await second.send({ type: "task.ack", taskId });
      await sleep(3_000);
      assert.equal(
        mainPID(),
        upgradedPID,
        "replaying an acknowledged upgrade must not restart again",
      );
      assert.equal(
        hashFile("/usr/local/bin/pipker-agent.previous"),
        oldDigest,
        "replay must not replace the previous binary with the new binary",
      );
      assert.equal(hashFile("/usr/local/bin/pipker-agent"), newDigest);
      assert.equal(readJournal(taskId).restartDispatched, true);
      assert.equal(
        sha256(JSON.stringify(exportConnection())),
        privateSnapshot.connection,
      );
      assert.deepEqual(preservedPaths.map(hashFile), privateSnapshot.files);
      t.diagnostic(
        "New version is active; duplicate task replay caused no execution or second systemd restart.",
      );
    } catch (error) {
      if (created) {
        try {
          t.diagnostic(
            inside("journalctl", "--unit", service, "--no-pager", "-n", "30"),
          );
        } catch {}
      }
      throw error;
    } finally {
      for (const session of sessions) session.socket.terminate();
      if (created) docker("rm", "--force", container);
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
