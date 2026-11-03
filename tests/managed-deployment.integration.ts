/**
 * @file managed-deployment.integration.ts
 * @project PipkerOps
 * @module managed-deployment-verification
 * @description 隔离后端、打包运行产物、独立Agent与真实HTTPS代理的完整接入验证。
 * @logic 复制 standalone 到临时目录并直接运行 JavaScript；验证接入、持久任务、更新及配置凭证保留。
 * @dependencies Docker, Go, OpenSSL, built standalone runtime
 * @index_tags integration, agent, https, backup
 * @author holic512
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
  realpathSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer as httpServer, request as httpRequest } from "node:http";
import {
  createServer as httpsServer,
  request as httpsRequest,
} from "node:https";
import { randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
const root = resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function wait<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeout = 60000,
) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = httpServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
function docker(...args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function prepareScriptRelease(fixture: string, agentRoot: string) {
  const opsVersion = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version as string;
  const skillVersion = readFileSync(
    join(root, "skills/VERSION"),
    "utf8",
  ).trim();
  const baseVersion = readFileSync(join(root, "deploy/VERSION"), "utf8").trim();
  const parts = baseVersion.split(".").map(Number);
  const nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  const published = join(fixture, "published");
  execFileSync(
    "sh",
    [
      join(root, "scripts/package-release.sh"),
      opsVersion,
      skillVersion,
      published,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const initial = join(fixture, "initial-release");
  mkdirSync(initial);
  execFileSync("tar", [
    "-xzf",
    join(published, `pipkerops-deploy-${baseVersion}.tar.gz`),
    "-C",
    initial,
  ]);
  cpSync(join(initial, "pipkerops/deploy"), agentRoot, { recursive: true });
  assert.equal(
    existsSync(join(agentRoot, "config")),
    false,
    "release package must not carry private configuration",
  );
  assert.equal(
    existsSync(join(agentRoot, "data")),
    false,
    "release package must not carry private runtime state",
  );
  const future = join(fixture, "future-release");
  mkdirSync(future);
  cpSync(join(initial, "pipkerops"), join(future, "pipkerops"), {
    recursive: true,
  });
  const deployment = join(future, "pipkerops/deploy");
  writeFileSync(join(deployment, "VERSION"), `${nextVersion}\n`);
  writeFileSync(
    join(deployment, "menu.py"),
    `${readFileSync(join(deployment, "menu.py"), "utf8")}\n# Managed future release ${nextVersion}\n`,
  );
  writeFileSync(
    join(deployment, "internal/managed_fixture.py"),
    `VERSION = ${JSON.stringify(nextVersion)}\n`,
  );
  const previous = JSON.parse(
    readFileSync(join(deployment, "managed-files.json"), "utf8"),
  ) as { files: Record<string, string> };
  const files = Object.fromEntries(
    [...Object.keys(previous.files), "internal/managed_fixture.py"].map(
      (name) => [name, digest(readFileSync(join(deployment, name)))],
    ),
  );
  writeFileSync(
    join(deployment, "managed-files.json"),
    JSON.stringify({ format: 1, version: nextVersion, files }),
  );
  const name = `pipkerops-deploy-${nextVersion}.tar.gz`;
  const archive = join(published, name);
  execFileSync("tar", ["-czf", archive, "-C", future, "pipkerops"]);
  return {
    opsVersion,
    baseVersion,
    nextVersion,
    name,
    archive,
    sha256: digest(readFileSync(archive)),
  };
}

function githubFixtures(
  fixture: string,
  release: ReturnType<typeof prepareScriptRelease>,
  binary: string,
) {
  const api = "https://api.github.com/repos/holic512/PipkerOps/releases";
  const validTag = "managed-future-scripts",
    invalidTag = "managed-invalid-digest";
  const agentVersion = "0.1.1";
  const arch = process.arch === "x64" ? "amd64" : "arm64";
  const registry: Record<
    string,
    { file?: string; contentType?: string; location?: string; status?: number }
  > = {};
  const entries = [];
  for (const [tag, checksum] of [
    [validTag, release.sha256],
    [invalidTag, "0".repeat(64)],
  ] as const) {
    const assetBase = `https://github.com/holic512/PipkerOps/releases/download/${tag}`;
    const manifest = {
      format: 1,
      protocolVersion: 1,
      versions: {
        ops: release.opsVersion,
        agent: agentVersion,
        scripts: release.nextVersion,
      },
      assets: {
        scripts: { name: release.name, sha256: checksum },
        [`agent-${arch}`]: {
          name: `pipker-agent-${agentVersion}-linux-${arch}`,
          sha256: digest(readFileSync(binary)),
        },
      },
    };
    const manifestPath = join(fixture, `${tag}-manifest.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const metadata = {
      tag_name: tag,
      name: `Managed fixture ${tag}`,
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "release-manifest.json",
          browser_download_url: `${assetBase}/release-manifest.json`,
        },
        {
          name: release.name,
          browser_download_url: `${assetBase}/${release.name}`,
        },
        {
          name: `pipker-agent-${agentVersion}-linux-${arch}`,
          browser_download_url: `${assetBase}/pipker-agent-${agentVersion}-linux-${arch}`,
        },
      ],
    };
    const metadataPath = join(fixture, `${tag}-release.json`);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    entries.push(metadata);
    registry[`${api}/tags/${tag}`] = {
      file: metadataPath,
      contentType: "application/json",
    };
    registry[`${assetBase}/release-manifest.json`] = {
      file: manifestPath,
      contentType: "application/json",
    };
    const redirected = `https://release-assets.githubusercontent.com/managed-fixture/${tag}/${release.name}`;
    registry[`${assetBase}/${release.name}`] = {
      status: 302,
      location: redirected,
    };
    registry[redirected] = { file: release.archive };
    registry[`${assetBase}/pipker-agent-${agentVersion}-linux-${arch}`] = {
      file: binary,
    };
  }
  const listing = join(fixture, "github-release-list.json");
  writeFileSync(listing, JSON.stringify(entries));
  registry[`${api}?per_page=30`] = {
    file: listing,
    contentType: "application/json",
  };
  writeFileSync(
    join(fixture, "github-responses.json"),
    JSON.stringify(registry),
  );
  return { validTag, invalidTag };
}

test(
  "生产构建经HTTPS代理接入独立Agent、执行任务、同源终端、备份、真实更新pipeline及恢复连接",
  { timeout: process.env.KEEP_MANAGED_FIXTURE === "true" ? 900000 : 300000 },
  async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pko-managed-")));
    const id = `pko-managed-${randomUUID().slice(0, 8)}`;
    const pg = `${id}-pg`,
      redis = `${id}-redis`,
      agentContainer = `${id}-agent`;
    const children: ChildProcess[] = [];
    const logs: string[] = [];
    const webPort = await freePort(),
      gatewayPort = await freePort(),
      agentPort = await freePort();
    const agentRoot = join(fixture, "agent-deploy");
    mkdirSync(agentRoot);

    const child = (command: string, args: string[], cwd = fixture) => {
      const preload =
        command === globalThis.process.execPath
          ? `--import=${JSON.stringify(join(root, "tests/fixtures/managed-github.mjs"))}`
          : "";
      const process = spawn(command, args, {
        cwd,
        env: {
          ...globalThis.process.env,
          NODE_ENV: "production",
          PORT: String(webPort),
          HOSTNAME: "127.0.0.1",
          NODE_OPTIONS: preload,
          PIPKEROPS_TEST_GITHUB_FIXTURE: join(fixture, "github-responses.json"),
          PIPKEROPS_TEST_GITHUB_AUDIT: join(fixture, "github-network.jsonl"),
          PATH: `${fixture}/bin:${globalThis.process.env.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stdout?.on("data", (data) => logs.push(data.toString()));
      process.stderr?.on("data", (data) => logs.push(data.toString()));
      children.push(process);
      return process;
    };
    let proxy: ReturnType<typeof httpsServer> | undefined;
    try {
      const scriptRelease = prepareScriptRelease(fixture, agentRoot);
      writeFileSync(
        join(agentRoot, ".pipkerops-installation.json"),
        JSON.stringify({
          format: 1,
          root: agentRoot,
          components: ["agent"],
          scriptsVersion: scriptRelease.baseVersion,
        }),
      );
      writeFileSync(join(fixture, "github-responses.json"), "{}");
      docker(
        "run",
        "-d",
        "--name",
        pg,
        "-p",
        "127.0.0.1::5432",
        "-e",
        "POSTGRES_PASSWORD=fixture-only",
        "-e",
        "POSTGRES_USER=pipkerops",
        "-e",
        "POSTGRES_DB=managed",
        "postgres:17-alpine",
      );
      docker(
        "run",
        "-d",
        "--name",
        redis,
        "-p",
        "127.0.0.1::6379",
        "redis:7-alpine",
        "redis-server",
        "--requirepass",
        "fixture-only",
      );
      const pgPort = docker("port", pg, "5432").split(":").at(-1)!;
      const redisPort = docker("port", redis, "6379").split(":").at(-1)!;
      await wait(
        async () =>
          docker("exec", pg, "pg_isready", "-U", "pipkerops", "-d", "managed"),
        (s) => s.includes("accepting"),
        "PostgreSQL",
      );
      mkdirSync(join(fixture, "config"));
      writeFileSync(
        join(fixture, "config/app.conf"),
        `DATABASE_HOST=127.0.0.1\nDATABASE_PORT=${pgPort}\nDATABASE_USERNAME=pipkerops\nDATABASE_PASSWORD=fixture-only\nDATABASE_NAME=managed\nREDIS_HOST=127.0.0.1\nREDIS_PORT=${redisPort}\nREDIS_PASSWORD=fixture-only\nBOOTSTRAP_EMAIL=managed@fixture.test\nBOOTSTRAP_PASSWORD=fixture-only-password-for-tests\nBOOTSTRAP_NAME=Fixture\nGATEWAY_PORT=${gatewayPort}\nNODE_CREDENTIALS_DIR=${fixture}/data/ops/credentials\nBACKUP_DIR=${fixture}/data/ops/backups\nRELEASE_CACHE_DIR=${fixture}/data/ops/releases\nWORKER_INTERVAL_MS=300\n`,
      );
      cpSync(join(root, ".next/standalone"), fixture, { recursive: true });
      cpSync(join(root, ".next/static"), join(fixture, ".next/static"), {
        recursive: true,
      });
      for (const name of [
        "src",
        "scripts",
        "tsconfig.json",
        "prisma.config.ts",
        "node_modules/tsx",
      ])
        assert.equal(existsSync(join(fixture, name)), false, name);
      execFileSync(process.execPath, ["runtime/runtime.mjs", "init"], {
        cwd: fixture,
        stdio: "pipe",
        env: { ...process.env, NODE_ENV: "production" },
      });
      mkdirSync(join(fixture, "bin"));
      writeFileSync(
        join(fixture, "bin/pg_dump"),
        `#!/bin/sh\nexec docker exec ${pg} pg_dump -U pipkerops -d managed "$@"\n`,
        { mode: 0o700 },
      );
      for (const role of ["web", "gateway", "worker"])
        child(process.execPath, ["runtime/runtime.mjs", role]);
      await wait(
        () =>
          fetch(`http://127.0.0.1:${webPort}/api/health`).then((r) => r.status),
        (s) => s === 200,
        "Web",
      );
      await wait(
        () =>
          fetch(`http://127.0.0.1:${gatewayPort}/health`).then((r) => r.status),
        (status) => status === 200,
        "Gateway",
      );
      execFileSync(process.execPath, ["runtime/health.mjs"], {
        cwd: fixture,
        stdio: "pipe",
      });
      const blocked = await fetch(
        `http://127.0.0.1:${webPort}/api/auth/login`,
        { method: "POST", body: "{}" },
      );
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).error, "请以 HTTPS 访问");
      assert.equal(
        (await fetch(`http://127.0.0.1:${webPort}/login`)).status,
        200,
      );
      const binary = join(fixture, "pipker-agent");
      execFileSync(
        "go",
        [
          "build",
          "-ldflags",
          "-X github.com/holic512/PipkerOps/agent/internal/agent.Version=0.1.1",
          "-o",
          binary,
          "./cmd/pipker-agent",
        ],
        {
          cwd: join(root, "agent"),
          env: {
            ...process.env,
            GOCACHE: join(tmpdir(), "pipkerops-go-cache"),
            GOOS: "linux",
            GOARCH: process.arch === "x64" ? "amd64" : "arm64",
            CGO_ENABLED: "0",
          },
          stdio: "pipe",
        },
      );
      const releases = githubFixtures(fixture, scriptRelease, binary);
      const agentArgs = [
        "--listen",
        "0.0.0.0:9443",
        "--url",
        `https://127.0.0.1:${agentPort}`,
        "--deploy-root",
        agentRoot,
        "--name",
        "Managed fixture",
      ];
      docker(
        "run",
        "-d",
        "--name",
        agentContainer,
        "-p",
        `127.0.0.1:${agentPort}:9443`,
        "-v",
        `${binary}:/tmp/pipker-agent:ro`,
        "-v",
        `${agentRoot}:${agentRoot}`,
        "--entrypoint",
        "/tmp/pipker-agent",
        process.env.MANAGED_AGENT_IMAGE ?? "pipkerops-systemd-fixture:local",
        ...agentArgs,
      );
      const bundle = await wait(
        async () => {
          try {
            return JSON.parse(
              docker(
                "exec",
                agentContainer,
                "/tmp/pipker-agent",
                ...agentArgs,
                "--export-connection",
              ),
            );
          } catch {
            return null;
          }
        },
        (value) => !!value,
        "Agent identity",
      );
      writeFileSync(join(fixture, "connection.json"), JSON.stringify(bundle), {
        mode: 0o600,
      });
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(fixture, "web.key"),
          "-out",
          join(fixture, "web.crt"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
      proxy = httpsServer(
        {
          key: readFileSync(join(fixture, "web.key")),
          cert: readFileSync(join(fixture, "web.crt")),
        },
        (req, res) => {
          const upstream = httpRequest(
            {
              host: "127.0.0.1",
              port: webPort,
              method: req.method,
              path: req.url,
              headers: { ...req.headers, "x-forwarded-proto": "https" },
            },
            (response) => {
              res.writeHead(response.statusCode!, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", () => res.writeHead(502).end());
          req.pipe(upstream);
        },
      );
      proxy.on("upgrade", (req, socket, head) => {
        const upstream = httpRequest({
          host: "127.0.0.1",
          port: gatewayPort,
          method: "GET",
          path: req.url,
          headers: { ...req.headers, "x-forwarded-proto": "https" },
        });
        upstream.on("upgrade", (response, target, initial) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(
              response.headers,
            )
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n")}\r\n\r\n`,
          );
          if (initial.length) socket.write(initial);
          if (head.length) target.write(head);
          socket.pipe(target).pipe(socket);
          socket.on("error", () => target.destroy());
          target.on("error", () => socket.destroy());
        });
        upstream.on("error", () => socket.destroy());
        upstream.end();
      });
      await new Promise<void>((done) => proxy!.listen(0, "127.0.0.1", done));
      const origin = `https://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      let cookie = "";
      const request = (path: string, body?: unknown) =>
        new Promise<{
          status: number;
          value: Record<string, unknown>;
          cookie?: string;
        }>((done, reject) => {
          const outgoing = httpsRequest(
            origin + path,
            {
              ca: readFileSync(join(fixture, "web.crt")),
              method: body ? "POST" : "GET",
              headers: {
                Origin: origin,
                Cookie: cookie,
                "Content-Type": "application/json",
              },
            },
            (response) => {
              let text = "";
              response.on("data", (data) => {
                text += data;
              });
              response.on("end", () => {
                done({
                  status: response.statusCode!,
                  value: JSON.parse(text),
                  cookie: response.headers["set-cookie"]?.[0].split(";")[0],
                });
              });
            },
          );
          outgoing.on("error", reject);
          if (body) outgoing.write(JSON.stringify(body));
          outgoing.end();
        });
      const login = await request("/api/auth/login", {
        email: "managed@fixture.test",
        password: "fixture-only-password-for-tests",
      });
      assert.equal(login.status, 200, JSON.stringify(login.value));
      cookie = login.cookie!;
      const rpc = async <T = Record<string, unknown>>(
        method: string,
        params = {},
      ): Promise<T> => {
        const response = await request("/api/rpc", { method, params });
        assert.equal(
          response.status,
          200,
          `${method}: ${JSON.stringify(response.value)}`,
        );
        return response.value.data as T;
      };
      const bad = await request("/api/rpc", {
        method: "nodes.test",
        params: { connection: { ...bundle, accessKey: "x".repeat(43) } },
      });
      assert.equal(bad.status, 403);
      const info = await rpc("nodes.test", { connection: bundle });
      assert.equal(info.agentId, bundle.agentId);
      const node = await rpc<{ id: string }>("nodes.import", {
        connection: bundle,
        confirmed: true,
      });
      const rows = await wait(
        () =>
          rpc<
            {
              id: string;
              connected: boolean;
              agentCredentialRef?: string;
              agentCaPem?: string;
              metrics: unknown[];
            }[]
          >("nodes.list"),
        (rows) =>
          rows.some(
            (r) => r.id === node.id && r.connected && r.metrics.length > 0,
          ),
        "metrics",
      );
      assert.equal(rows[0].agentCredentialRef, undefined);
      assert.equal(rows[0].agentCaPem, undefined);
      await rpc("nodes.deployment", {
        nodeId: node.id,
        deployRoot: agentRoot,
        component: "agent",
        confirmed: true,
      });
      const task = await rpc<{ id: string }>("tasks.create", {
        type: "shell.exec",
        nodeId: node.id,
        payload: { script: "printf managed-task-ok", timeoutSeconds: 10 },
        confirmed: true,
      });
      const result = await wait(
        () =>
          rpc<{ status: string; output: string; error?: string }>("tasks.get", {
            id: task.id,
          }),
        (r) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(r.status),
        "task",
      );
      assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
      assert.match(result.output, /managed-task-ok/);
      const ticket = await rpc<{ path: string }>("terminal.ticket", {
        nodeId: node.id,
        confirmed: true,
      });
      const ws = new WebSocket(origin.replace("https:", "wss:") + ticket.path, {
        ca: readFileSync(join(fixture, "web.crt")),
        origin,
      });
      await new Promise<void>((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      ws.close();
      const backup = await rpc<{ id: string }>("backups.create", {
        confirmed: true,
        idempotencyKey: randomUUID(),
      });
      await wait(
        () =>
          rpc<{ status: string; error?: string }>("tasks.get", {
            id: backup.id,
          }),
        (r) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(r.status),
        "backup",
      ).then((value) => {
        assert.equal(value.status, "SUCCEEDED", JSON.stringify(value));
      });
      const archive = join(
        fixture,
        `data/ops/backups/${backup.id}/archive.tar.gz`,
      );
      const names = execFileSync("tar", ["-tzf", archive], {
        encoding: "utf8",
      });
      assert.match(names, /credentials\/[a-f0-9-]{36}/);
      // These private files are created only after extracting the public deployment
      // package. Updating managed programs must preserve both components' state.
      const sentinelFiles = {
        "config/ops/app.conf": "fixture Ops configuration stays private\n",
        "config/agent/agent.env": `PIPKEROPS_DEPLOY_ROOT=${agentRoot}\n`,
        "data/ops/preserved.txt": "fixture Ops runtime data\n",
        "data/agent/preserved.txt": "fixture Agent runtime data\n",
      };
      for (const [name, value] of Object.entries(sentinelFiles)) {
        mkdirSync(resolve(agentRoot, name, ".."), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(join(agentRoot, name), value, { mode: 0o600 });
      }
      const preservedPaths = [
        join(fixture, "config/app.conf"),
        ...Object.keys(sentinelFiles).map((name) => join(agentRoot, name)),
        join(agentRoot, "data/agent/identity/identity.json"),
        ...readdirSync(join(fixture, "data/ops/credentials")).map((name) =>
          join(fixture, "data/ops/credentials", name),
        ),
      ];
      const preserved = preservedPaths.map(
        (path) => [path, digest(readFileSync(path))] as const,
      );
      const assertPreserved = () => {
        for (const [path, expected] of preserved)
          assert.equal(
            digest(readFileSync(path)),
            expected,
            `private file changed: ${path}`,
          );
      };
      const listed =
        await rpc<{ tag: string; name: string }[]>("updates.releases");
      assert.ok(listed.some((release) => release.tag === releases.validTag));
      assert.ok(listed.some((release) => release.tag === releases.invalidTag));
      type UpdateTask = {
        id: string;
        status: string;
        error?: string;
        output?: string;
        result: { executionTaskId?: string; expectedVersion?: string };
      };
      const awaitUpdate = (id: string) =>
        wait(
          () => rpc<UpdateTask>("tasks.get", { id }),
          (task) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(task.status),
          "managed update pipeline",
          90000,
        );
      const queueUpdate = (
        component: "scripts" | "agent",
        releaseTag = releases.validTag,
      ) =>
        rpc<{ id: string }>("updates.create", {
          nodeId: node.id,
          component,
          releaseTag,
          deployRoot: agentRoot,
          confirmed: true,
          idempotencyKey: randomUUID(),
        });
      const originalMenu = readFileSync(join(agentRoot, "menu.py"));
      const checksumFailure = await awaitUpdate(
        (await queueUpdate("scripts", releases.invalidTag)).id,
      );
      assert.equal(
        checksumFailure.status,
        "FAILED",
        JSON.stringify(checksumFailure),
      );
      assert.match(checksumFailure.error ?? "", /SHA-256/);
      assert.equal(checksumFailure.result.executionTaskId, undefined);
      assert.equal(
        digest(readFileSync(join(agentRoot, "menu.py"))),
        digest(originalMenu),
      );
      assert.equal(
        readFileSync(join(agentRoot, "VERSION"), "utf8").trim(),
        scriptRelease.baseVersion,
      );
      assertPreserved();

      const modifiedMenu = Buffer.concat([
        originalMenu,
        Buffer.from("\n# Intentional local fixture modification\n"),
      ]);
      writeFileSync(join(agentRoot, "menu.py"), modifiedMenu);
      const conflict = await awaitUpdate((await queueUpdate("scripts")).id);
      assert.equal(conflict.status, "FAILED", JSON.stringify(conflict));
      assert.ok(
        conflict.result.executionTaskId,
        "valid archive should reach the real Agent executor",
      );
      assert.match(
        `${conflict.output ?? ""} ${conflict.error ?? ""}`,
        /本地修改|路径冲突/,
      );
      assert.equal(
        digest(readFileSync(join(agentRoot, "menu.py"))),
        digest(modifiedMenu),
      );
      assert.equal(
        readFileSync(join(agentRoot, "VERSION"), "utf8").trim(),
        scriptRelease.baseVersion,
      );
      assertPreserved();
      // Restore only this deliberate edit so the next update can apply cleanly.
      writeFileSync(join(agentRoot, "menu.py"), originalMenu);
      const scriptUpdate = await awaitUpdate((await queueUpdate("scripts")).id);
      assert.equal(
        scriptUpdate.status,
        "SUCCEEDED",
        JSON.stringify(scriptUpdate),
      );
      assert.ok(
        scriptUpdate.result.executionTaskId,
        "pipeline must dispatch a real deployment.update task",
      );
      const execution = await rpc<UpdateTask>("tasks.get", {
        id: scriptUpdate.result.executionTaskId,
      });
      assert.equal(execution.status, "SUCCEEDED", JSON.stringify(execution));
      assert.equal(
        readFileSync(join(agentRoot, "VERSION"), "utf8").trim(),
        scriptRelease.nextVersion,
      );
      assert.match(
        readFileSync(join(agentRoot, "menu.py"), "utf8"),
        /Managed future release/,
      );
      assert.equal(
        readFileSync(join(agentRoot, "internal/managed_fixture.py"), "utf8"),
        `VERSION = ${JSON.stringify(scriptRelease.nextVersion)}\n`,
      );
      const installation = JSON.parse(
        readFileSync(join(agentRoot, ".pipkerops-installation.json"), "utf8"),
      );
      assert.equal(installation.scriptsVersion, scriptRelease.nextVersion);
      const persistedExecution = JSON.parse(
        readFileSync(
          join(
            agentRoot,
            `data/agent/tasks/${scriptUpdate.result.executionTaskId}.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(persistedExecution.state, "DONE");
      assert.equal(persistedExecution.response.success, true);
      assertPreserved();

      const pidBefore = docker(
        "inspect",
        "--format",
        "{{.State.Pid}}",
        agentContainer,
      );
      const sameVersion = await awaitUpdate((await queueUpdate("agent")).id);
      assert.equal(
        sameVersion.status,
        "SUCCEEDED",
        JSON.stringify(sameVersion),
      );
      assert.match(sameVersion.output ?? "", /无需更新/);
      assert.equal(sameVersion.result.executionTaskId, undefined);
      assert.equal(
        docker("inspect", "--format", "{{.State.Pid}}", agentContainer),
        pidBefore,
      );
      assertPreserved();
      const network = readFileSync(
        join(fixture, "github-network.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { url: string; status: number });
      assert.ok(
        network.some(
          (entry) =>
            entry.url.includes("release-assets.githubusercontent.com") &&
            entry.status === 200,
        ),
        "real archive bytes must pass through the GitHub download path",
      );
      assert.equal(
        network.some((entry) => /pipker-agent-.*-linux-/.test(entry.url)),
        false,
        "same-version update must not download or install the Agent binary",
      );
      console.log(
        "PASS real release manifest/download/hash/upload/Python script update, bad digest/local-change rejection, private config/data/Key preservation and same-version no-op",
      );
      const saved = readFileSync(
        join(agentRoot, "data/agent/identity/identity.json"),
      );
      const gateway = children[1];
      gateway.kill("SIGTERM");
      await new Promise<void>((done) => gateway.once("exit", () => done()));
      child(process.execPath, ["runtime/runtime.mjs", "gateway"]);
      await wait(
        () => rpc<{ connected: boolean }[]>("nodes.list"),
        (r) => r[0].connected,
        "reconnected",
      );
      assert.equal(
        createHash("sha256").update(saved).digest("hex"),
        createHash("sha256")
          .update(
            readFileSync(join(agentRoot, "data/agent/identity/identity.json")),
          )
          .digest("hex"),
      );
      if (process.env.KEEP_MANAGED_FIXTURE === "true") {
        writeFileSync(
          "/private/tmp/pipkerops-managed-validation.json",
          JSON.stringify({
            fixture,
            origin,
            httpOrigin: `http://127.0.0.1:${webPort}`,
          }),
        );
        console.log(
          "Managed UI fixture ready; metadata: /private/tmp/pipkerops-managed-validation.json",
        );
        await wait(
          async () => {
            try {
              readFileSync(join(fixture, "finish-ui"));
              return true;
            } catch {
              return false;
            }
          },
          Boolean,
          "manual UI verification",
          600000,
        );
      }
      console.log(
        "PASS HTTP gate, production HTTPS proxy, private CA/Key validation, node import, metrics, task, terminal, credential backup, managed updates and reconnect",
      );
    } catch (error) {
      console.error(logs.slice(-12).join("\n"));
      throw error;
    } finally {
      proxy?.closeAllConnections();
      proxy?.close();
      for (const process of children) process.kill("SIGTERM");
      await sleep(500);
      for (const process of children)
        if (process.exitCode === null) process.kill("SIGKILL");
      for (const name of [agentContainer, pg, redis]) {
        try {
          docker("rm", "-f", name);
        } catch {}
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
