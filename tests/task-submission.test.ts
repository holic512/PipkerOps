import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskSubmission } from "../src/lib/task-submission";
import { RequestError, type rpc } from "../src/lib/client";

test("提交响应丢失与服务器错误提示结果未知，相同参数显式找回原键，不自动重试", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const send: typeof rpc = async <T>(method: string, params = {}) => {
    calls.push({ method, params });
    if (calls.length === 1) throw new TypeError("Failed to fetch");
    if (calls.length === 2) throw new RequestError("response failed", 500);
    return { id: "original-task" } as T;
  };
  const submit = createTaskSubmission(send);
  const input = {
    type: "shell.exec",
    nodeId: "node-a",
    payload: { script: "run" },
  };
  await assert.rejects(submit("tasks.create", input), /任务可能已入队/);
  assert.equal(calls.length, 1);
  await assert.rejects(submit("tasks.create", input), /保留当前页面和原参数/);
  assert.equal(calls.length, 2);
  assert.deepEqual(await submit("tasks.create", input), {
    id: "original-task",
  });
  assert.equal(new Set(calls.map((c) => c.params.idempotencyKey)).size, 1);
  await submit("tasks.create", input);
  assert.notEqual(
    calls[3].params.idempotencyKey,
    calls[2].params.idempotencyKey,
  );
});

test("动作权限拒绝保留准确错误，不声称已入队", async () => {
  const forbidden = new RequestError("API Key 未授权高危操作", 403);
  const submit = createTaskSubmission(async () => {
    throw forbidden;
  });
  await assert.rejects(
    submit("actions.run", { id: "action-a" }),
    (error) => error === forbidden,
  );
});
