/** Isolated PostgreSQL, Redis and Docker-in-Docker; never uses configured business backends. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { writeFile, symlink, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { organizationFixture } from "./helpers/organization-fixture";
import {
  docker,
  dockerWrite,
  prepareContainerAgent,
  waitForAgent,
  until,
  availablePort,
  stopAgent,
} from "./helpers/agent-fixture";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { uiProxy } from "./helpers/ui-proxy";
import { configValues } from "../src/lib/config";
import { redis } from "../src/lib/redis";
import { execute } from "../src/lib/services/platform";
import {
  methodOutputSchemas,
  type Method,
} from "../src/lib/services/contracts";
import { canonicalJson, hashToken, randomToken } from "../src/lib/crypto";
import type { ResourceData } from "../src/lib/resource-contracts";
import type {
  DockerOperation,
  DockerContainer,
  ComposeProject,
} from "../src/lib/docker-contracts";
import type { PrismaClient } from "../src/generated/prisma/client";

const runFile = promisify(execFile);
test(
  "隔离 Linux：Docker 全部直连、独立日志、Gateway 回传与任务兼容",
  { timeout: process.env.DOCKER_UI_TEST === "true" ? 7200000 : 420000 },
  async (t) => {
    const fixture = await organizationFixture();
    const previousConfig = { ...configValues };
    const globalDb = globalThis as unknown as { db?: PrismaClient };
    const previousDb = globalDb.db;
    globalDb.db = fixture.client;
    const name = "pipkerops-direct-" + randomUUID().slice(0, 8);
    const owned: string[] = [];
    let gateway: ChildProcess | undefined;
    let web: ChildProcess | undefined;
    let runtime: ReturnType<typeof runtimeFixture> | undefined;
    let proxy: Awaited<ReturnType<typeof uiProxy>> | undefined;
    let terminalRedis: Awaited<ReturnType<typeof redis>> | undefined;
    let gatewayLog = "";
    try {
      const redisPassword = randomBytes(24).toString("hex");
      const envFile = join(fixture.directory, "redis.env");
      await writeFile(envFile, `TEST_REDIS_PASSWORD=${redisPassword}\n`, {
        mode: 0o600,
      });
      const redisName = name + "-redis";
      docker(
        "create",
        "--name",
        redisName,
        "--label",
        "io.pipkerops.docker-direct-test=true",
        "--publish",
        "127.0.0.1::6379",
        "--env-file",
        envFile,
        "redis:7-alpine",
        "sh",
        "-c",
        'exec redis-server --requirepass "$TEST_REDIS_PASSWORD"',
      );
      owned.push(redisName);
      docker("start", redisName);
      const redisPort = docker("port", redisName, "6379/tcp")
        .split(":")
        .at(-1)!;
      Object.assign(configValues, fixture.config, {
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: redisPort,
        REDIS_USERNAME: "",
        REDIS_PASSWORD: redisPassword,
        REDIS_DATABASE: "0",
        REDIS_TLS: "false",
        DATABASE_CA_FILE: "",
        REDIS_CA_FILE: "",
      });
      const agentBinary = join(fixture.directory, "pipkerops-agent");
      await runFile("go", ["build", "-o", agentBinary, "./cmd/pipker-agent"], {
        cwd: resolve("agent"),
        env: {
          ...process.env,
          GOOS: "linux",
          GOARCH: process.arch === "arm64" ? "arm64" : "amd64",
          CGO_ENABLED: "0",
        },
        timeout: 120000,
      });
      docker(
        "create",
        "--privileged",
        "--name",
        name,
        "--label",
        "io.pipkerops.docker-direct-test=true",
        "--env",
        "DOCKER_TLS_CERTDIR=",
        "--publish",
        "127.0.0.1::9443",
        "docker:28-dind",
        "--storage-driver",
        "vfs",
      );
      owned.push(name);
      docker("start", name);
      await until(
        async () => {
          try {
            return docker(
              "exec",
              name,
              "docker",
              "info",
              "--format",
              "{{.ServerVersion}}",
            );
          } catch {
            return "";
          }
        },
        Boolean,
        "isolated Docker daemon",
      );
      docker("cp", agentBinary, `${name}:/usr/local/bin/pipkerops-agent`);
      const agent = await prepareContainerAgent(name, name);
      agent.start();
      await waitForAgent(agent.connection);
      for (const image of ["nginx:1.28-alpine"]) {
        const platform = docker(
          "image",
          "inspect",
          image,
          "--format",
          "{{.Os}}/{{.Architecture}}{{if .Variant}}/{{.Variant}}{{end}}",
        );
        await new Promise<void>((done, reject) => {
          const save = spawn(
            "docker",
            ["save", "--platform", platform, image],
            {
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const load = spawn("docker", ["exec", "-i", name, "docker", "load"], {
            stdio: ["pipe", "ignore", "pipe"],
          });
          let importError = "";
          let exportError = "";
          save.stderr.on("data", (part) => {
            exportError += String(part);
          });
          load.stderr.on("data", (part) => {
            importError += String(part);
          });
          save.stdout.pipe(load.stdin);
          save.on("error", reject);
          load.on("error", reject);
          save.on("exit", (code) => {
            if (code)
              reject(
                new Error(
                  `fixture image export failed: ${exportError.slice(-1800)}`,
                ),
              );
          });
          load.on("exit", (code) =>
            code === 0
              ? done()
              : reject(
                  new Error(
                    `fixture image import failed: ${importError.slice(-1800)}`,
                  ),
                ),
          );
        });
      }
      docker("exec", name, "docker", "pull", "registry:3");
      docker(
        "exec",
        name,
        "docker",
        "run",
        "-d",
        "--name",
        "fixture-registry",
        "-p",
        "5000:5000",
        "registry:3",
      );
      await until(
        async () => {
          try {
            return docker(
              "exec",
              name,
              "wget",
              "-qO-",
              "http://127.0.0.1:5000/v2/",
            );
          } catch {
            return "";
          }
        },
        Boolean,
        "local fixture registry",
      );
      docker(
        "exec",
        name,
        "docker",
        "tag",
        "nginx:1.28-alpine",
        "localhost:5000/direct-fixture:latest",
      );
      docker(
        "exec",
        name,
        "docker",
        "push",
        "localhost:5000/direct-fixture:latest",
      );
      const user = await fixture.client.user.create({
        data: {
          email: `${name}@fixture.test`,
          displayName: "Docker fixture",
          role: "ADMIN",
          passwordHash: "fixture-no-password-login",
        },
      });
      const actor = { userId: user.id, role: "ADMIN" as const };
      const call = async <T>(
        method: Method,
        params: Record<string, unknown>,
      ) => {
        const data = await execute(actor, method, params);
        methodOutputSchemas[method]?.parse({
          data: JSON.parse(JSON.stringify(data)),
        });
        return data as T;
      };
      const node = await call<{ id: string }>("nodes.import", {
        name: "直连验证节点",
        connection: agent.connection,
        confirmed: true,
      });
      const folder = await call<{ id: string }>("nodeFolders.save", {
        name: "Docker 联调",
      });
      await call("nodes.move", { nodeIds: [node.id], folderId: folder.id });
      await fixture.client.node.create({
        data: { name: "离线验证节点", status: "APPROVED", folderId: folder.id },
      });
      const gatewayPort = await availablePort();
      runtime = runtimeFixture(gatewayPort);
      gateway = runtime.start("gateway");
      gateway.stdout?.on("data", (part) => {
        gatewayLog += String(part);
      });
      gateway.stderr?.on("data", (part) => {
        gatewayLog += String(part);
      });
      await until(
        () => fixture.client.node.findUniqueOrThrow({ where: { id: node.id } }),
        (value) => !!value.lastSeenAt,
        "Gateway connects owned Agent",
      );
      const start = (
        method: "docker.action" | "docker.pull" | "compose.deploy",
        params: Record<string, unknown>,
        key = randomUUID(),
      ) =>
        call<DockerOperation>(method, {
          nodeId: node.id,
          ...params,
          idempotencyKey: key,
          confirmed: true,
        });
      // Reading the database here proves Gateway completion works without an open page or snapshot polling.
      const finished = (id: string) =>
        until(
          () =>
            fixture.client.dockerOperation.findUniqueOrThrow({ where: { id } }),
          (value) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(value.status),
          "Gateway persists Docker result",
          90000,
        );
      const project = "direct-fixture";
      const yaml =
        'services:\n  web:\n    image: localhost:5000/direct-fixture:latest\n    command: [sh, -c, "echo docker-direct-ready; sleep 10800"]\n';
      let containerId = "";
      await t.test(
        "镜像拉取、部署离页继续、资源解析和日志回看均不创建任务",
        async () => {
          assert.equal(
            (
              await finished(
                (
                  await start("docker.pull", {
                    image: "localhost:5000/direct-fixture:latest",
                  })
                ).id,
              )
            ).status,
            "SUCCEEDED",
          );
          const operation = await start("compose.deploy", { project, yaml });
          assert.equal((await finished(operation.id)).status, "SUCCEEDED");
          const list = await call<{ containers: DockerContainer[] }>(
            "docker.list",
            { nodeId: node.id },
          );
          const container = list.containers.find(
            (value) => value.name === project + "-web-1",
          );
          assert.ok(container);
          containerId = container.id;
          const logs = await call<{ output: string }>("docker.logs", {
            nodeId: node.id,
            id: containerId,
            tail: 20,
          });
          assert.match(logs.output, /docker-direct-ready/);
          await call("docker.stats", { nodeId: node.id, id: containerId });
          const inspected = await call<{
            containers: Record<string, unknown>[];
          }>("docker.inspect", { nodeId: node.id, id: containerId });
          assert.equal(inspected.containers[0].Name, "/" + project + "-web-1");
          assert.ok(!JSON.stringify(inspected).includes('"Env"'));
          const stored = await call<DockerOperation>("docker.operations.get", {
            id: operation.id,
          });
          assert.equal(stored.status, "SUCCEEDED");
          assert.ok(stored.logs.length > 0);
          assert.equal(await fixture.client.task.count(), 0);
          assert.equal(await fixture.client.taskLog.count(), 0);
          const paths = docker(
            "exec",
            name,
            "sh",
            "-c",
            `find '${agent.state}/tasks' -type f | wc -l`,
          );
          assert.equal(Number(paths), 0);
        },
      );
      await t.test("容器启停重启、重复请求与跨节点日志隔离", async () => {
        const key = randomUUID();
        const [first, concurrent] = await Promise.all([
          start("docker.action", { id: containerId, action: "stop" }, key),
          start("docker.action", { id: containerId, action: "stop" }, key),
        ]);
        assert.equal(first.id, concurrent.id);
        assert.equal((await finished(first.id)).status, "SUCCEEDED");
        const repeated = await start(
          "docker.action",
          { id: containerId, action: "stop" },
          key,
        );
        assert.equal(repeated.id, first.id);
        await assert.rejects(
          start("docker.action", { id: containerId, action: "start" }, key),
          { status: 409 },
        );
        assert.equal(
          (
            await finished(
              (
                await start("docker.action", {
                  id: containerId,
                  action: "start",
                })
              ).id,
            )
          ).status,
          "SUCCEEDED",
        );
        assert.equal(
          (
            await finished(
              (
                await start("docker.action", {
                  id: containerId,
                  action: "restart",
                })
              ).id,
            )
          ).status,
          "SUCCEEDED",
        );
        await assert.rejects(
          execute(
            {
              ...actor,
              apiKeyId: "scope-test",
              scopes: ["docker:read"],
              nodeIds: ["other"],
            },
            "docker.operations.get",
            { id: first.id },
          ),
          { status: 403 },
        );
        const directOnly = {
          ...actor,
          apiKeyId: "scope-test",
          scopes: ["docker:read"],
          nodeIds: [node.id],
        };
        await execute(directOnly, "docker.list", { nodeId: node.id });
        const own = await fixture.client.dockerOperation.count({
          where: { idempotencyKey: key },
        });
        assert.equal(own, 1);
      });
      await t.test(
        "Compose 部分失败保留配置、空资源受管项目可见且可显式修正",
        async () => {
          const failed = await start("compose.deploy", {
            project: "broken",
            yaml: yaml.replace(
              "  web:\n",
              "  web:\n    user: fixture-user-missing\n",
            ),
          });
          assert.equal((await finished(failed.id)).status, "FAILED");
          const detail = await call<DockerOperation>("docker.operations.get", {
            id: failed.id,
          });
          assert.equal(detail.result.configurationSaved, true);
          assert.equal(detail.result.runtimeMayBePartial, true);
          await call("compose.read", { nodeId: node.id, project: "broken" });
          await call("compose.status", { nodeId: node.id, project: "broken" });
          assert.equal(
            (
              await finished(
                (await start("compose.deploy", { project: "broken", yaml })).id,
              )
            ).status,
            "SUCCEEDED",
          );
          docker(
            "exec",
            name,
            "mkdir",
            "-p",
            `${agent.state}/compose/saved-only`,
          );
          dockerWrite(
            name,
            `${agent.state}/compose/saved-only/compose.yaml`,
            yaml,
          );
          const list = await call<{ projects: ComposeProject[] }>(
            "compose.list",
            { nodeId: node.id },
          );
          assert.deepEqual(
            list.projects.find((value) => value.name === "saved-only"),
            { name: "saved-only", status: "not deployed", managed: true },
          );
          const before = await fixture.client.task.count();
          await call("docker.operations.list", { nodeId: node.id });
          assert.equal(await fixture.client.task.count(), before);
        },
      );
      await t.test(
        "未确认的原请求只对账，不重新发送；容器删除保留无任务语义",
        async () => {
          const id = randomUUID();
          const key = randomUUID();
          const payload = { project: "never-sent", yaml };
          await fixture.client.dockerOperation.create({
            data: {
              id,
              nodeId: node.id,
              actorId: actor.userId,
              source: "WEB",
              target: payload.project,
              method: "compose.deploy",
              idempotencyKey: key,
              requestHash: hashToken(
                canonicalJson({
                  method: "compose.deploy",
                  nodeId: node.id,
                  payload,
                  actorId: actor.userId,
                  apiKeyId: null,
                }),
              ),
            },
          });
          const record = await start("compose.deploy", payload, key);
          assert.equal(record.id, id);
          assert.equal(record.status, "UNKNOWN");
          const projects = await call<{ projects: ComposeProject[] }>(
            "compose.list",
            { nodeId: node.id },
          );
          assert.ok(
            !projects.projects.some(
              (project) => project.name === payload.project,
            ),
          );
          const disposable = docker(
            "exec",
            name,
            "docker",
            "create",
            "--name",
            "remove-fixture",
            "nginx:1.28-alpine",
          );
          assert.equal(
            (
              await finished(
                (
                  await start("docker.action", {
                    id: disposable,
                    action: "remove",
                  })
                ).id,
              )
            ).status,
            "SUCCEEDED",
          );
          assert.equal(await fixture.client.task.count(), 0);
        },
      );
      await t.test(
        "执行位占满时旧任务恢复排队且不消耗尝试次数，直连查询不创建任务",
        async () => {
          const occupied: string[] = [];
          for (let index = 0; index < 4; index++)
            occupied.push(
              docker(
                "exec",
                name,
                "docker",
                "run",
                "-d",
                "--name",
                `capacity-${index}`,
                "--stop-signal",
                "SIGTERM",
                "--entrypoint",
                "sh",
                "nginx:1.28-alpine",
                "-c",
                "trap '' TERM; sleep 600",
              ),
            );
          const operations = await Promise.all(
            occupied.map((id) =>
              start("docker.action", { id, action: "stop" }),
            ),
          );
          assert.ok(
            operations.every((operation) => operation.status === "RUNNING"),
          );
          const before = Date.now();
          const task = await call<{ id: string }>("tasks.create", {
            nodeId: node.id,
            type: "docker.list",
          });
          const completed = await until(
            () =>
              fixture.client.task.findUniqueOrThrow({ where: { id: task.id } }),
            (value) => value.status === "SUCCEEDED",
            "legacy Docker task",
          );
          assert.ok(
            Date.now() - before > 5000,
            "task bypassed shared execution capacity",
          );
          assert.equal(
            completed.attempts,
            1,
            "busy rejection consumed execution attempts",
          );
          for (const operation of operations)
            assert.equal((await finished(operation.id)).status, "SUCCEEDED");
          await call("docker.list", { nodeId: node.id });
          assert.equal(await fixture.client.task.count(), 1);
        },
      );
      await t.test(
        "远程工作台：宿主机/容器文件、边界、权限及PTY互相读写",
        async () => {
          const task = async (
            type: string,
            payload: Record<string, unknown>,
            expected = "SUCCEEDED",
          ) => {
            const created = await call<{ id: string }>("tasks.create", {
              type,
              payload,
              nodeId: node.id,
              confirmed: true,
            });
            const completed = await until(
              () =>
                fixture.client.task.findUniqueOrThrow({
                  where: { id: created.id },
                }),
              (value) =>
                ["SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"].includes(
                  value.status,
                ),
              type,
            );
            assert.equal(
              completed.status,
              expected,
              `${type}: ${completed.error}`,
            );
            return completed;
          };
          const root = "/tmp/workspace 中文 '目录";
          const file = `${root}/file '中文.txt`;
          await task("files.mkdir", { path: root });
          await task("container.files.mkdir", { containerId, path: root });
          await task("files.write", { path: file, content: "host-only" });
          await task("container.files.write", {
            containerId,
            path: file,
            content: "container-only",
          });
          assert.equal(
            (await task("files.read", { path: file })).output,
            "host-only",
          );
          assert.equal(
            (await task("container.files.read", { containerId, path: file }))
              .output,
            "container-only",
          );
          const listed = await task("container.files.list", {
            containerId,
            path: root,
          });
          assert.ok(JSON.stringify(listed.result).includes("file '中文.txt"));
          const quote = (value: string) =>
            `'${value.replaceAll("'", "'\\''")}'`;
          terminalRedis = await redis();
          const wsTicket = await call<{ path: string }>("terminal.ticket", {
            nodeId: node.id,
            containerId,
            confirmed: true,
          });
          const ws = new WebSocket(
            new URL(wsTicket.path, `ws://127.0.0.1:${gatewayPort}`),
            {
              headers: {
                Host: "localhost",
                Origin: "https://localhost",
                "X-Forwarded-Proto": "https",
              },
            },
          );
          let output = "";
          ws.on("message", (raw) => {
            const packet = JSON.parse(String(raw));
            if (packet.type === "terminal.output") output += packet.data;
          });
          await new Promise<void>((done, reject) => {
            ws.once("open", done);
            ws.once("error", reject);
          });
          try {
            await until(
              async () => output,
              (value) => value.includes("#") || value.includes("$"),
              "container prompt",
            );
            ws.send(
              JSON.stringify({
                type: "terminal.input",
                data: `cat ${quote(file)}; printf 'terminal-new' > ${quote(file)}; printf '\\nPTY_file_done\\n'\n`,
              }),
            );
            await until(
              async () => output,
              (value) =>
                value.includes("container-only") &&
                value.includes("PTY_file_done\r\n"),
              "PTY reads file task and writes new content",
            );
            assert.equal(
              (await task("container.files.read", { containerId, path: file }))
                .output,
              "terminal-new",
            );
          } finally {
            ws.close();
          }
          docker(
            "exec",
            name,
            "docker",
            "exec",
            containerId,
            "sh",
            "-c",
            'ln -s "$1" "$2"; printf data > "$3"; mkdir "$4"; printf "binary\\000value" > "$5"',
            "fixture",
            file,
            `${root}/link`,
            `${root}/line\nfile`,
            `${root}/nested`,
            `${root}/binary`,
          );
          await task(
            "container.files.read",
            { containerId, path: `${root}/link` },
            "FAILED",
          );
          await task(
            "container.files.read",
            { containerId, path: "/proc/self/environ" },
            "FAILED",
          );
          await task(
            "container.files.remove",
            { containerId, path: root },
            "FAILED",
          );
          const metadata = await task("container.files.list", {
            containerId,
            path: root,
          });
          assert.ok(JSON.stringify(metadata.result).includes("line\\nfile"));
          const binary = await task("container.files.read", {
            containerId,
            path: `${root}/binary`,
          });
          assert.equal((binary.result as { binary: boolean }).binary, true);
          docker(
            "exec",
            name,
            "docker",
            "exec",
            containerId,
            "sh",
            "-c",
            'head -c 262145 /dev/zero > "$1"; for i in $(seq 1 1001); do : > "$2/item-$i"; done',
            "fixture",
            `${root}/large`,
            `${root}/nested`,
          );
          const large = await task("container.files.read", {
            containerId,
            path: `${root}/large`,
          });
          assert.equal(
            (large.result as { truncated: boolean }).truncated,
            true,
          );
          docker(
            "exec",
            name,
            "docker",
            "exec",
            containerId,
            "sh",
            "-c",
            'awk \'BEGIN {for (i=0;i<90000;i++) printf "中"}\' > "$1"',
            "fixture",
            `${root}/chinese`,
          );
          const chinese = await task("container.files.read", {
            containerId,
            path: `${root}/chinese`,
          });
          assert.equal(chinese.output, "中".repeat(87381));
          assert.equal(
            (chinese.result as { truncated: boolean }).truncated,
            true,
          );
          assert.equal((chinese.result as { binary: boolean }).binary, false);
          const limited = await task("container.files.list", {
            containerId,
            path: `${root}/nested`,
          });
          assert.equal((limited.result as { limited: boolean }).limited, true);
          assert.equal(
            (limited.result as { entries: unknown[] }).entries.length,
            1000,
          );
          await task("container.files.remove", { containerId, path: file });
          await task(
            "container.files.read",
            { containerId: "missing-workspace-target", path: "/etc/hostname" },
            "FAILED",
          );
          for (const scopes of [["files:read"], ["docker:read"]]) {
            await assert.rejects(
              execute(
                {
                  ...actor,
                  apiKeyId: "scope-test",
                  nodeIds: [node.id],
                  scopes,
                },
                "tasks.create",
                {
                  nodeId: node.id,
                  type: "container.files.list",
                  payload: { containerId, path: "/" },
                },
              ),
              { status: 403 },
            );
          }
          await assert.rejects(
            call("tasks.create", {
              nodeId: node.id,
              type: "container.files.write",
              payload: { containerId, path: file, content: "no-confirm" },
            }),
            { status: 400 },
          );
          const deniedKey = await fixture.client.apiKey.create({
            data: {
              userId: user.id,
              name: "file-dispatch-denial",
              keyPrefix: "fixture",
              keyHash: hashToken(randomToken()),
              scopes: ["files:read"],
              nodeIds: [node.id],
              allowDangerous: false,
            },
          });
          const deniedTask = await fixture.client.task.create({
            data: {
              type: "container.files.list",
              nodeId: node.id,
              actorId: user.id,
              apiKeyId: deniedKey.id,
              source: "WEB",
              status: "QUEUED",
              payload: { containerId, path: "/" },
              idempotent: true,
              maxAttempts: 1,
            },
          });
          const denied = await until(
            () =>
              fixture.client.task.findUniqueOrThrow({
                where: { id: deniedTask.id },
              }),
            (value) => value.status === "CANCELLED",
            "Gateway checks additional container scope",
          );
          assert.equal(denied.error, "执行前权限已失效");
          await fixture.client.apiKey.update({
            where: { id: deniedKey.id },
            data: { revokedAt: new Date() },
          });
          const stopped = docker(
            "exec",
            name,
            "docker",
            "create",
            "nginx:1.28-alpine",
          );
          await task(
            "container.files.list",
            { containerId: stopped, path: "/" },
            "FAILED",
          );
          docker("exec", name, "docker", "rm", stopped);
          const readonly = docker(
            "exec",
            name,
            "docker",
            "run",
            "-d",
            "--read-only",
            "--entrypoint",
            "sh",
            "nginx:1.28-alpine",
            "-c",
            "sleep 600",
          );
          await task(
            "container.files.write",
            { containerId: readonly, path: "/tmp/file", content: "blocked" },
            "FAILED",
          );
          docker("exec", name, "docker", "rm", "-f", readonly);
          await task("files.remove", { path: file });
          await task("files.remove", { path: root });
        },
      );
      let managedResourceId = "";
      await t.test(
        "长期资源：保存部署标签、登记A、两应用共享、重建B及操作实例不漂移",
        async () => {
          const stableProject = "resource-identity-fixture";
          const label = randomUUID();
          const yamlFor = (revision: string) => `services:
  api:
    image: localhost:5000/direct-fixture:latest
    labels:
      pipkerops.resource-id: "${label}"
    command: [sh, -c, "echo ${revision}; sleep 10800"]
`;
          const deployed = await start("compose.deploy", {
            project: stableProject,
            yaml: yamlFor("A"),
          });
          assert.equal((await finished(deployed.id)).status, "SUCCEEDED");
          const getInstance = async () =>
            (
              await call<{ containers: DockerContainer[] }>("docker.list", {
                nodeId: node.id,
              })
            ).containers.find((c) => c.name === stableProject + "-api-1")!;
          const a = await getInstance();
          assert.ok(a);
          const resource = await call<ResourceData>("resources.register", {
            nodeId: node.id,
            containerId: a.id,
            strategy: "label",
            name: "共享 API 资源",
            confirmed: true,
            persistenceConfirmed: true,
          });
          managedResourceId = resource.id;
          assert.notEqual(resource.id, a.id);
          const apps = await Promise.all(
            ["资源验收应用 A", "资源验收应用 B"].map((name) =>
              call<{ id: string }>("applications.save", { name }),
            ),
          );
          for (const app of apps)
            await call("resources.associate", {
              resourceId: resource.id,
              applicationId: app.id,
            });
          const oldKey = randomUUID();
          const oldOperation = await call<DockerOperation>("resources.action", {
            resourceId: resource.id,
            expectedContainerId: a.id,
            action: "restart",
            confirmed: true,
            idempotencyKey: oldKey,
          });
          assert.equal((await finished(oldOperation.id)).status, "SUCCEEDED");
          const saved = await call<{ yaml: string }>("compose.read", {
            nodeId: node.id,
            project: stableProject,
          });
          assert.match(saved.yaml, new RegExp(label));
          const rebuilt = await start("compose.deploy", {
            project: stableProject,
            yaml: yamlFor("B"),
          });
          assert.equal((await finished(rebuilt.id)).status, "SUCCEEDED");
          assert.equal(rebuilt.resourceId, resource.id);
          assert.ok(rebuilt.resolvedContainerIds?.includes(a.id));
          const b = await getInstance();
          assert.notEqual(a.id, b.id);
          assert.equal(b.labels["pipkerops.resource-id"], label);
          const rawOperation = await start("docker.action", {
            id: b.id,
            action: "restart",
          });
          assert.equal(
            rawOperation.resourceId,
            resource.id,
            "裸容器入口也必须在B重建后解析资源身份",
          );
          assert.equal((await finished(rawOperation.id)).status, "SUCCEEDED");
          const discovered = await call<ResourceData>("resources.discover", {
            resourceId: resource.id,
          });
          assert.equal(discovered.id, resource.id);
          assert.deepEqual(
            discovered.instances.map((c) => c.id),
            [b.id],
          );
          assert.equal(discovered.applications.length, 2);
          await assert.rejects(
            call("resources.action", {
              resourceId: resource.id,
              expectedContainerId: a.id,
              action: "stop",
              confirmed: true,
              idempotencyKey: randomUUID(),
            }),
            /实例已变化/,
          );
          const replay = await call<DockerOperation>("resources.action", {
            resourceId: resource.id,
            expectedContainerId: a.id,
            action: "restart",
            confirmed: true,
            idempotencyKey: oldKey,
          });
          assert.equal(replay.id, oldOperation.id);
          assert.equal(replay.target, a.id);
          const newOperation = await call<DockerOperation>("resources.action", {
            resourceId: resource.id,
            expectedContainerId: b.id,
            action: "restart",
            confirmed: true,
            idempotencyKey: randomUUID(),
          });
          assert.equal((await finished(newOperation.id)).status, "SUCCEEDED");
          assert.equal(newOperation.resourceId, resource.id);
          assert.equal(newOperation.target, b.id);
          assert.deepEqual(newOperation.resolvedContainerIds, [b.id]);
          await call("resources.unlink", {
            resourceId: resource.id,
            applicationId: apps[0].id,
            confirmed: true,
          });
          const shared = await call<ResourceData>("resources.get", {
            resourceId: resource.id,
          });
          assert.deepEqual(
            shared.applications.map((link) => link.applicationId),
            [apps[1].id],
          );
          await call("resources.associate", {
            resourceId: resource.id,
            applicationId: apps[0].id,
          });
        },
      );
      if (process.env.DOCKER_UI_TEST === "true") {
        docker("exec", name, "mkdir", "-p", "/tmp/workspace-ui/sub");
        dockerWrite(name, "/tmp/workspace-ui/sample.txt", "host-ui-original");
        docker(
          "exec",
          name,
          "docker",
          "exec",
          containerId,
          "sh",
          "-c",
          "mkdir -p /tmp/workspace-ui/sub; printf container-ui-original > /tmp/workspace-ui/sample.txt",
        );
        for (const path of [
          ".next",
          "package.json",
          "next.config.ts",
          "public",
        ])
          try {
            await symlink(resolve(path), join(runtime.directory, path));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        const port = await availablePort();
        web = spawn(
          process.execPath,
          [
            resolve("node_modules/next/dist/bin/next"),
            "start",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(port),
          ],
          { cwd: runtime.directory, stdio: ["ignore", "pipe", "pipe"] },
        );
        web.stdout?.on("data", () => {});
        web.stderr?.on("data", () => {});
        await until(
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${port}/login`)).ok;
            } catch {
              return false;
            }
          },
          Boolean,
          "isolated Web",
        );
        const token = randomToken();
        await (
          await import("../src/lib/session-store")
        ).sessions.create(user.id, token);
        const cookieName = (await import("../src/lib/auth")).sessionCookie;
        proxy = await uiProxy(port, gatewayPort, fixture.directory);
        await mkdir(join(runtime.directory, "ui"), { recursive: true });
        await writeFile(
          join(runtime.directory, "ui", "cookie.curl"),
          `curl '${proxy.origin}/' -H 'Cookie: ${cookieName}=${token}'\n`,
          { mode: 0o600 },
        );
        await writeFile(
          join(runtime.directory, "ui", "context.json"),
          JSON.stringify({
            pid: process.pid,
            port: proxy.port,
            origin: proxy.origin,
            agentContainer: name,
            managedResourceId,
            nodeId: node.id,
            containerId,
            project,
            cookieFile: join(runtime.directory, "ui", "cookie.curl"),
          }),
          { mode: 0o600 },
        );
        console.log(
          `DOCKER_UI_READY ${join(runtime.directory, "ui", "context.json")}`,
        );
        await new Promise<void>((done) => process.once("SIGINT", done));
      }
    } catch (error) {
      console.error("Owned Docker fixture Gateway:", gatewayLog.slice(-1200));
      throw error;
    } finally {
      terminalRedis?.destroy();
      await proxy?.close();
      await stopAgent(web);
      await stopAgent(gateway);
      runtime?.cleanup();
      for (const id of owned.reverse()) docker("rm", "-f", "-v", id);
      globalDb.db = previousDb;
      for (const key of Object.keys(configValues)) delete configValues[key];
      Object.assign(configValues, previousConfig);
      await fixture.close();
    }
  },
);
