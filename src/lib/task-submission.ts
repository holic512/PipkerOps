/**
 * @file task-submission.ts
 * @project PipkerOps
 * @module client-task-submission
 * @description 保存尚未收到成功响应的任务提交身份，复用服务端幂等机制。
 * @logic 同一表单请求失败后保留原键供显式重试；收到响应后允许新的独立提交，不自动重放。
 * @dependencies RPC
 * @index_tags tasks, idempotency, client
 * @author holic512
 */
import { rpc } from "./client";

export function createTaskSubmission(send: typeof rpc = rpc) {
  const pending = new Map<string, string>();
  return async function submit<T>(
    method: "tasks.create" | "actions.run",
    params: Record<string, unknown>,
  ): Promise<T> {
    const fingerprint = JSON.stringify({ method, params });
    const key = pending.get(fingerprint) ?? crypto.randomUUID();
    pending.set(fingerprint, key);
    const result = await send<T>(method, { ...params, idempotencyKey: key });
    pending.delete(fingerprint);
    return result;
  };
}
