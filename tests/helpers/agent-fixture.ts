import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:https";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

export type Connection = {
  format: 1;
  protocolVersion: 1;
  agentId: string;
  url: string;
  caPem: string;
  accessKey: string;
  deployRoot: string;
};
export const integrationOrigin =
  process.env.TEST_ORIGIN ?? "http://127.0.0.1:3000";

/** Simulate the trusted local HTTPS proxy while talking to its HTTP backend. */
export function proxyHeaders(origin = integrationOrigin) {
  const url = new URL(origin);
  return {
    Host: url.host,
    Origin: `https://${url.host}`,
    "X-Forwarded-Proto": "https",
  };
}

export async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeout = 45000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function stopAgent(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

export async function prepareHostAgent(
  binary: string,
  state: string,
  name: string,
) {
  const root = resolve(state, "installation");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const port = await availablePort();
  const args = [
    "--listen",
    `127.0.0.1:${port}`,
    "--url",
    `https://127.0.0.1:${port}`,
    "--state-dir",
    state,
    "--deploy-root",
    root,
    "--name",
    name,
  ];
  const connection = JSON.parse(
    execFileSync(binary, [...args, "--export-connection"], {
      encoding: "utf8",
    }),
  ) as Connection;
  return {
    root,
    state,
    args,
    connection,
    start: () => spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }),
  };
}

export async function agentRequest(
  connection: Connection,
  path = "/v1/info",
  payload?: Buffer,
) {
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = request(
      new URL(path, connection.url),
      {
        ca: connection.caPem,
        method: payload ? "PUT" : "GET",
        headers: {
          Authorization: `Bearer ${connection.accessKey}`,
          ...(payload
            ? {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(payload.length),
              }
            : {}),
        },
        timeout: 10000,
      },
      (res) => {
        let raw = "";
        res.on("data", (part) => {
          raw += part.toString();
        });
        res.on("error", reject);
        res.on("end", () => {
          let data: unknown = raw;
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Agent request timeout")));
    req.end(payload);
  });
}

export async function waitForAgent(connection: Connection) {
  return until(
    async () => {
      try {
        return (await agentRequest(connection)).status === 200;
      } catch {
        return false;
      }
    },
    Boolean,
    "Agent HTTPS service",
  );
}

export async function uploadArtifact(connection: Connection, payload: Buffer) {
  const digest = createHash("sha256").update(payload).digest("hex");
  const response = await agentRequest(
    connection,
    `/v1/artifacts/${digest}`,
    payload,
  );
  assert.equal(response.status, 200, "verified artifact upload");
  assert.deepEqual(response.data, { sha256: digest, size: payload.length });
  return digest;
}

export function docker(...args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  }).trim();
}
export function dockerWrite(
  container: string,
  path: string,
  data: string | Buffer,
) {
  execFileSync(
    "docker",
    ["exec", "-i", container, "sh", "-c", 'umask 077; cat > "$1"', "--", path],
    { input: data, stdio: ["pipe", "pipe", "pipe"] },
  );
}

export function containerAgentAddress(container: string, privatePort = 9443) {
  const published = docker("port", container, `${privatePort}/tcp`)
    .split("\n")
    .find((line) => line.startsWith("127.0.0.1:"));
  assert.ok(published, "fixture must publish its Agent port on loopback");
  return `https://${published}`;
}

export async function prepareContainerAgent(
  container: string,
  name: string,
  binaryPath = "/usr/local/bin/pipkerops-agent",
  root = "/opt/pipkerops",
) {
  const url = containerAgentAddress(container);
  const state = `${root}/data/agent`;
  const args = [
    "--listen",
    "0.0.0.0:9443",
    "--url",
    url,
    "--state-dir",
    state,
    "--deploy-root",
    root,
    "--name",
    name,
  ];
  docker("exec", container, "mkdir", "-p", root);
  dockerWrite(
    container,
    `${root}/.pipkerops-installation.json`,
    JSON.stringify({
      format: 1,
      root,
      components: ["agent"],
      scriptsVersion: "0.1.1",
    }),
  );
  const connection = JSON.parse(
    docker("exec", container, binaryPath, ...args, "--export-connection"),
  ) as Connection;
  return {
    root,
    state,
    args,
    connection,
    start: () =>
      docker(
        "exec",
        "-d",
        container,
        "sh",
        "-c",
        'exec "$@" >/tmp/agent.log 2>&1',
        "--",
        binaryPath,
        ...args,
      ),
  };
}

/** Shorten only the owned fixture leaf; the Agent must renew with its unchanged CA. */
export function shortenAgentCertificate(state: string) {
  const path = join(state, "identity", "identity.json");
  const identity = JSON.parse(readFileSync(path, "utf8"));
  const directory = join(state, "rotation-fixture");
  mkdirSync(directory, { mode: 0o700 });
  for (const [file, value] of [
    ["leaf.crt", identity.certificatePem],
    ["ca.crt", identity.caPem],
    ["ca.key", identity.caKeyPem],
  ] as const) {
    writeFileSync(join(directory, file), value, { mode: 0o600 });
  }
  const pem = execFileSync(
    "openssl",
    [
      "x509",
      "-in",
      join(directory, "leaf.crt"),
      "-CA",
      join(directory, "ca.crt"),
      "-CAkey",
      join(directory, "ca.key"),
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      "7",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  identity.certificatePem = pem;
  writeFileSync(path, JSON.stringify(identity), { mode: 0o600 });
  return {
    path,
    pem,
    agentId: identity.agentId,
    accessKey: identity.accessKey,
    caPem: identity.caPem,
  };
}
