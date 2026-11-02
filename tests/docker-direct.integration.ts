/** Isolated PostgreSQL, Redis and Docker-in-Docker; never uses configured business backends. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
import { configValues } from "../src/lib/config";
import { execute } from "../src/lib/services/platform";
import {
  methodOutputSchemas,
  type Method,
} from "../src/lib/services/contracts";
import { canonicalJson, hashToken, randomToken } from "../src/lib/crypto";
import type {
  DockerOperation,
  DockerContainer,
  ComposeProject,
} from "../src/lib/docker-contracts";
import type { PrismaClient } from "../src/generated/prisma/client";

const runFile = promisify(execFile);
test(
  "隔离 Linux：Docker 全部直连、独立日志、Gateway 回传与任务兼容",
  { timeout: process.env.DOCKER_UI_TEST === "true" ? 1800000 : 420000 },
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
      runtime = runtimeFixture(await availablePort());
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
        'services:\n  web:\n    image: localhost:5000/direct-fixture:latest\n    command: [sh, -c, "echo docker-direct-ready; sleep 600"]\n';
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
      if (process.env.DOCKER_UI_TEST === "true") {
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
        await fixture.client.session.create({
          data: {
            tokenHash: hashToken(token),
            userId: user.id,
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
        const cookieName = (await import("../src/lib/auth")).sessionCookie;
        await mkdir(join(runtime.directory, "ui"), { recursive: true });
        await writeFile(
          join(runtime.directory, "ui", "cookie.curl"),
          `curl 'http://127.0.0.1:${port}/' -H 'Cookie: ${cookieName}=${token}'\n`,
          { mode: 0o600 },
        );
        await writeFile(
          join(runtime.directory, "ui", "context.json"),
          JSON.stringify({
            pid: process.pid,
            port,
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
