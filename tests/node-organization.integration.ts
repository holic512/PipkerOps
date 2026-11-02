import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { organizationFixture } from "./helpers/organization-fixture";
import {
  prepareHostAgent,
  stopAgent,
  waitForAgent,
} from "./helpers/agent-fixture";
import { execute } from "../src/lib/services/platform";
import { configValues } from "../src/lib/config";
import { methodOutputSchemas } from "../src/lib/services/contracts";
import type { Actor } from "../src/lib/auth";
import type { NodeFolderData, NodeData } from "../src/lib/client";
import type { PrismaClient } from "../src/generated/prisma/client";

const runFile = promisify(execFile);
test(
  "隔离 PostgreSQL：文件夹分类、授权、事务审计与真实 Agent 重新接入",
  { timeout: 180000 },
  async (t) => {
    const fixture = await organizationFixture();
    const globalDb = globalThis as unknown as { db?: PrismaClient };
    const previousDb = globalDb.db;
    const previousCredentials = configValues.NODE_CREDENTIALS_DIR;
    globalDb.db = fixture.client;
    configValues.NODE_CREDENTIALS_DIR = fixture.config.NODE_CREDENTIALS_DIR;
    const client = fixture.client;
    let agent: ChildProcess | undefined;
    try {
      for (const [id, role] of [
        ["admin", "ADMIN"],
        ["operator", "OPERATOR"],
        ["viewer", "VIEWER"],
      ] as const)
        await client.user.create({
          data: {
            id,
            email: `${id}@organization.test`,
            displayName: id,
            role,
            passwordHash: "test-fixture-no-login",
          },
        });
      const admin: Actor = { userId: "admin", role: "ADMIN" };
      const operator: Actor = { userId: "operator", role: "OPERATOR" };
      const viewer: Actor = { userId: "viewer", role: "VIEWER" };
      const call = <T>(
        actor: Actor,
        method: string,
        params: Record<string, unknown> = {},
      ) => execute(actor, method, params) as Promise<T>;
      const folder = (name: string, parentId: string | null = null) =>
        call<NodeFolderData>(admin, "nodeFolders.save", { name, parentId });
      const prod = await folder("生产");
      const zone = await folder("华东", prod.id);
      const deep = await folder("Web", zone.id);
      const empty = await folder("预留");
      await client.node.createMany({
        data: [
          { id: "a", name: "api", labels: ["old"], folderId: deep.id },
          { id: "b", name: "db", folderId: zone.id },
          { id: "hidden", name: "hidden", folderId: empty.id },
        ],
      });
      await client.metricSample.create({
        data: {
          nodeId: "a",
          cpuPercent: 10,
          memoryPercent: 20,
          payload: { marker: "history" },
        },
      });

      await t.test("嵌套目录、根目录唯一约束、名称修剪与循环拒绝", async () => {
        await call(operator, "nodeFolders.save", { name: " 运维 " });
        assert.ok(
          await client.nodeFolder.findFirst({ where: { name: "运维" } }),
        );
        for (const parentId of [prod.id, zone.id, deep.id])
          await assert.rejects(
            call(admin, "nodeFolders.save", {
              id: prod.id,
              name: "生产",
              parentId,
            }),
            { status: 400 },
          );
        await assert.rejects(folder("生产"), { status: 409 });
        await assert.rejects(folder("bad", "missing"), { status: 404 });
        await assert.rejects(
          client.nodeFolder.create({ data: { name: "生产" } }),
          { code: "P2002" },
        );
        await call(admin, "nodeFolders.save", { id: deep.id, name: "前端" });
        assert.equal(
          (
            await client.nodeFolder.findUniqueOrThrow({
              where: { id: deep.id },
            })
          ).parentId,
          zone.id,
        );
      });

      await t.test(
        "批量移动、更新与审计原子执行，缺失节点时整体保留",
        async () => {
          const before = await client.auditEvent.count();
          await assert.rejects(
            call(admin, "nodes.move", {
              nodeIds: ["a", "missing"],
              folderId: empty.id,
            }),
            { status: 404 },
          );
          assert.equal(
            (await client.node.findUniqueOrThrow({ where: { id: "a" } }))
              .folderId,
            deep.id,
          );
          assert.equal(await client.auditEvent.count(), before);
          await assert.rejects(
            call({ ...operator, userId: "missing-actor" }, "nodes.move", {
              nodeIds: ["a", "b"],
              folderId: empty.id,
            }),
            { code: "P2003" },
          );
          assert.equal(
            (await client.node.findUniqueOrThrow({ where: { id: "a" } }))
              .folderId,
            deep.id,
          );
          assert.equal(
            (await client.node.findUniqueOrThrow({ where: { id: "b" } }))
              .folderId,
            zone.id,
          );
          assert.equal(await client.auditEvent.count(), before);
          await call(operator, "nodes.move", {
            nodeIds: ["a", "b", "a"],
            folderId: prod.id,
          });
          assert.equal(
            await client.auditEvent.count({ where: { action: "nodes.move" } }),
            2,
          );
          await call(operator, "nodes.update", {
            id: "a",
            name: "api2",
            labels: [" web ", "web", "关键"],
          });
          const a = await client.node.findUniqueOrThrow({ where: { id: "a" } });
          assert.equal(a.folderId, prod.id);
          assert.deepEqual(a.labels, ["web", "关键"]);
          assert.equal(
            await client.metricSample.count({ where: { nodeId: "a" } }),
            1,
          );
          const result = await call<NodeData[]>(admin, "nodes.list");
          assert.equal(
            methodOutputSchemas["nodes.list"]!.safeParse({
              data: JSON.parse(JSON.stringify(result)),
            }).success,
            true,
          );
          assert.ok(!JSON.stringify(result).includes("agentCredentialRef"));
        },
      );

      await t.test(
        "受限 Key 只见授权祖先，拒绝越界目标、混合批次和共享结构修改",
        async () => {
          const key = await client.apiKey.create({
            data: {
              userId: "admin",
              name: "scoped",
              keyHash: "fixture-scoped",
              keyPrefix: "fixture",
              scopes: ["nodes:read", "nodes:write"],
              nodeIds: ["a"],
            },
          });
          const actor: Actor = {
            ...admin,
            apiKeyId: key.id,
            scopes: key.scopes,
            nodeIds: key.nodeIds,
          };
          await call(admin, "nodes.move", {
            nodeIds: ["a"],
            folderId: deep.id,
          });
          assert.deepEqual(
            new Set(
              (await call<NodeFolderData[]>(actor, "nodeFolders.list")).map(
                (item) => item.id,
              ),
            ),
            new Set([prod.id, zone.id, deep.id]),
          );
          await call(actor, "nodes.move", {
            nodeIds: ["a"],
            folderId: prod.id,
          });
          assert.deepEqual(
            (await call<NodeFolderData[]>(actor, "nodeFolders.list")).map(
              (item) => item.id,
            ),
            [prod.id],
          );
          assert.deepEqual(
            await call({ ...actor, nodeIds: [] }, "nodeFolders.list"),
            [],
          );
          assert.deepEqual(
            (await call<NodeData[]>(actor, "nodes.list")).map(
              (item) => item.id,
            ),
            ["a"],
          );
          await assert.rejects(
            call({ ...actor, scopes: ["nodes:write"] }, "nodeFolders.list"),
            { status: 403 },
          );
          await assert.rejects(
            call(actor, "nodeFolders.save", { name: "unauthorized" }),
            { status: 403 },
          );
          await assert.rejects(
            call(actor, "nodeFolders.delete", { id: prod.id, confirmed: true }),
            { status: 403 },
          );
          await assert.rejects(
            call(actor, "nodes.move", { nodeIds: ["a"], folderId: empty.id }),
            { status: 403 },
          );
          await assert.rejects(
            call(actor, "nodes.update", {
              id: "a",
              name: "changed",
              labels: [],
              folderId: empty.id,
            }),
            { status: 403 },
          );
          await assert.rejects(
            call(actor, "nodes.move", { nodeIds: ["a", "b"], folderId: null }),
            { status: 403 },
          );
          assert.equal(
            (await client.node.findUniqueOrThrow({ where: { id: "a" } }))
              .folderId,
            prod.id,
          );
          await call(actor, "nodes.move", {
            nodeIds: ["a"],
            folderId: prod.id,
          });
          await call(actor, "nodes.move", { nodeIds: ["a"], folderId: null });
          assert.deepEqual(await call(actor, "nodeFolders.list"), []);
          const full: Actor = { ...actor, nodeIds: ["*"] };
          const created = await call<NodeFolderData>(full, "nodeFolders.save", {
            name: "全范围",
          });
          await call(full, "nodeFolders.delete", {
            id: created.id,
            confirmed: true,
          });
        },
      );

      await t.test("只读角色拒绝所有分类写入", async () => {
        for (const [method, params] of [
          ["nodeFolders.save", { name: "no" }],
          ["nodeFolders.delete", { id: prod.id, confirmed: true }],
          ["nodes.move", { nodeIds: ["a"], folderId: null }],
          ["nodes.update", { id: "a", name: "no", labels: [] }],
        ] as const)
          await assert.rejects(call(viewer, method, params), { status: 403 });
        assert.ok(
          (await call<NodeFolderData[]>(viewer, "nodeFolders.list")).length,
        );
      });

      await t.test(
        "删除提升直属内容并保留深层归属与指标；同名冲突完整回滚",
        async () => {
          await client.node.create({
            data: { id: "leaf", name: "deep-node", folderId: deep.id },
          });
          await call(admin, "nodes.move", {
            nodeIds: ["a"],
            folderId: zone.id,
          });
          await assert.rejects(
            call(admin, "nodeFolders.delete", { id: zone.id }),
            { status: 400 },
          );
          await call(admin, "nodeFolders.delete", {
            id: zone.id,
            confirmed: true,
          });
          assert.equal(
            (await client.node.findUniqueOrThrow({ where: { id: "a" } }))
              .folderId,
            prod.id,
          );
          assert.equal(
            (await client.node.findUniqueOrThrow({ where: { id: "leaf" } }))
              .folderId,
            deep.id,
          );
          assert.equal(
            (
              await client.nodeFolder.findUniqueOrThrow({
                where: { id: deep.id },
              })
            ).parentId,
            prod.id,
          );
          assert.equal(
            await client.metricSample.count({ where: { nodeId: "a" } }),
            1,
          );
          const blocked = await folder("待删除");
          const child = await folder("生产", blocked.id);
          await call(admin, "nodes.move", {
            nodeIds: ["b"],
            folderId: blocked.id,
          });
          await assert.rejects(
            call(admin, "nodeFolders.delete", {
              id: blocked.id,
              confirmed: true,
            }),
            { status: 409 },
          );
          assert.equal(
            (await client.node.findUniqueOrThrow({ where: { id: "b" } }))
              .folderId,
            blocked.id,
          );
          assert.equal(
            (
              await client.nodeFolder.findUniqueOrThrow({
                where: { id: child.id },
              })
            ).parentId,
            blocked.id,
          );
          const same = await folder("同名");
          const sameChild = await folder("同名", same.id);
          await call(admin, "nodeFolders.delete", {
            id: same.id,
            confirmed: true,
          });
          assert.equal(
            (
              await client.nodeFolder.findUniqueOrThrow({
                where: { id: sameChild.id },
              })
            ).parentId,
            null,
          );
        },
      );

      await t.test(
        "真实 Agent 新接入可指定分类，重新接入省略分类时保留历史",
        async () => {
          const binary = join(fixture.directory, "pipker-agent");
          await runFile("go", ["build", "-o", binary, "./cmd/pipker-agent"], {
            cwd: resolve("agent"),
            timeout: 90000,
          });
          const host = await prepareHostAgent(
            binary,
            join(fixture.directory, "agent"),
            "organization-agent",
          );
          agent = host.start();
          agent.stderr?.resume();
          await waitForAgent(host.connection);
          const imported = await call<{ id: string }>(admin, "nodes.import", {
            connection: host.connection,
            folderId: prod.id,
            labels: [" keep ", "keep"],
            confirmed: true,
          });
          await client.metricSample.create({
            data: { nodeId: imported.id, cpuPercent: 5, memoryPercent: 15 },
          });
          await call(admin, "nodes.import", {
            id: imported.id,
            connection: host.connection,
            confirmed: true,
          });
          const node = await client.node.findUniqueOrThrow({
            where: { id: imported.id },
          });
          assert.equal(node.folderId, prod.id);
          assert.deepEqual(node.labels, ["keep"]);
          assert.equal(
            await client.metricSample.count({ where: { nodeId: imported.id } }),
            1,
          );
          await call(admin, "nodes.import", {
            id: imported.id,
            connection: host.connection,
            folderId: null,
            labels: [],
            confirmed: true,
          });
          assert.equal(
            (
              await client.node.findUniqueOrThrow({
                where: { id: imported.id },
              })
            ).folderId,
            null,
          );
        },
      );
    } finally {
      await stopAgent(agent);
      globalDb.db = previousDb;
      if (previousCredentials === undefined)
        delete configValues.NODE_CREDENTIALS_DIR;
      else configValues.NODE_CREDENTIALS_DIR = previousCredentials;
      await fixture.close();
    }
  },
);
