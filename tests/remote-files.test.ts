import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TaskData, type rpc } from "../src/lib/client";
import { mcpTaskInput } from "../src/lib/services/contracts";
import { authorizeTask } from "../src/lib/services/tasks";
import {
  createFileTaskRunner,
  FileTaskError,
  remotePath,
  remoteTargetKey,
  terminalDirectoryCommand,
} from "../src/lib/remote-files";

test("容器文件契约保留独立类型、绝对路径和必填容器", () => {
  for (const action of ["list", "read", "write", "mkdir", "remove"]) {
    const input = {
      type: `container.files.${action}`,
      nodeId: "node",
      payload: {
        containerId: "app-1",
        path: "/tmp/file",
        ...(action === "write" ? { content: "" } : {}),
      },
    };
    assert.equal(mcpTaskInput.safeParse(input).success, true);
    for (const payload of [
      { ...input.payload, containerId: undefined },
      { ...input.payload, containerId: "--all" },
      { ...input.payload, path: "relative" },
      { ...input.payload, path: "/tmp/\0name" },
    ])
      assert.equal(
        mcpTaskInput.safeParse({ ...input, payload }).success,
        false,
      );
  }
  assert.equal(
    mcpTaskInput.safeParse({ type: "files.list", payload: { path: "/" } })
      .success,
    true,
  );
});

test("创建与派发共用授权：容器读取/写入分别需要两种scope", () => {
  const key = {
    userId: "u",
    role: "OPERATOR" as const,
    apiKeyId: "key",
    nodeIds: ["node"],
    allowDangerous: true,
  };
  for (const action of ["list", "read", "write", "mkdir", "remove"]) {
    const mode = ["list", "read"].includes(action) ? "read" : "write";
    const type = `container.files.${action}`;
    for (const scopes of [[`files:${mode}`], [`docker:${mode}`], []])
      assert.throws(() => authorizeTask({ ...key, scopes }, type, "node"), {
        status: 403,
      });
    const actor = { ...key, scopes: [`files:${mode}`, `docker:${mode}`] };
    authorizeTask(actor, type, "node");
    assert.throws(() => authorizeTask(actor, type, "other-node"), {
      status: 403,
    });
    if (mode === "write") {
      assert.throws(
        () => authorizeTask({ ...actor, allowDangerous: false }, type, "node"),
        { status: 403 },
      );
      assert.throws(
        () => authorizeTask({ ...actor, role: "VIEWER" }, type, "node"),
        { status: 403 },
      );
    }
  }
  authorizeTask({ ...key, scopes: ["files:read"] }, "files.list", "node");
});

test("目录命令正确引用中文空格单引号，且不包含回车", () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "pko 目录 '$()-")));
  try {
    const command = terminalDirectoryCommand(folder);
    assert.ok(!/[\r\n]/.test(command));
    assert.equal(
      execFileSync("/bin/sh", ["-c", `${command}; pwd`], {
        encoding: "utf8",
      }).trim(),
      folder,
    );
  } finally {
    rmSync(folder, { recursive: true });
  }
  assert.throws(() => terminalDirectoryCommand("/tmp/new\nline"));
  assert.equal(remotePath("/tmp/../var//log/./"), "/var/log");
  assert.notEqual(
    remoteTargetKey({ nodeId: "one", containerId: "" }),
    remoteTargetKey({ nodeId: "one", containerId: "app" }),
  );
});

function task(status: string): TaskData {
  return {
    id: "task",
    type: "container.files.list",
    status,
    nodeId: "node",
    payload: {},
    result: { path: "/", entries: [], limited: false },
    output: null,
    error: null,
    attempts: 1,
    maxAttempts: 3,
    idempotent: true,
    source: "WEB",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}
test("文件读取提交一次，完成后停止轮询，载荷包含当前容器", async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const send: typeof rpc = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ) => {
    calls.push({ method, params });
    return task(method === "tasks.create" ? "QUEUED" : "SUCCEEDED") as T;
  };
  const result = await createFileTaskRunner(send)(
    { nodeId: "node", containerId: "app" },
    "list",
    { path: "/" },
  );
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["tasks.create", "tasks.get"],
  );
  assert.equal(calls[0].params?.type, "container.files.list");
  assert.deepEqual(calls[0].params?.payload, { path: "/", containerId: "app" });
  assert.equal(calls[0].params?.confirmed, false);
});
test("未知和失败结果停止，不重放；卸载前取消不提交任务", async () => {
  for (const status of ["UNKNOWN", "FAILED", "CANCELLED"]) {
    let calls = 0;
    const send: typeof rpc = async <T>() => {
      calls++;
      return task(status) as T;
    };
    await assert.rejects(
      createFileTaskRunner(send)(
        { nodeId: "node", containerId: "app" },
        "remove",
        { path: "/tmp/file" },
        { confirmed: true },
      ),
      FileTaskError,
    );
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createFileTaskRunner(async () => {
      throw new Error("must not send");
    })(
      { nodeId: "node", containerId: "" },
      "list",
      { path: "/" },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
});

test("写入已提交但查询断线时，再次确认只查询原任务", async () => {
  const calls: string[] = [];
  const send: typeof rpc = async <T>(method: string) => {
    calls.push(method);
    if (calls.length === 2) throw new Error("query connection lost");
    return {
      ...task(method === "tasks.create" ? "RUNNING" : "SUCCEEDED"),
      type: "files.write",
    } as T;
  };
  const run = createFileTaskRunner(send);
  const target = { nodeId: "node", containerId: "" };
  await assert.rejects(
    run(
      target,
      "write",
      { path: "/tmp/file", content: "hello" },
      { confirmed: true },
    ),
    /query connection lost/,
  );
  assert.equal(
    (
      await run(
        target,
        "write",
        { path: "/tmp/file", content: "hello" },
        { confirmed: true },
      )
    ).status,
    "SUCCEEDED",
  );
  assert.deepEqual(calls, ["tasks.create", "tasks.get", "tasks.get"]);
});
