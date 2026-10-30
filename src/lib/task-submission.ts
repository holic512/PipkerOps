/**
 * @file task-submission.ts
 * @project PipkerOps
 * @module client-task-submission
 * @description 保存尚未收到成功响应的任务提交身份，复用服务端幂等机制。
 * @logic 请求结果不明时说明入队可能并保留原键供相同参数显式找回；收到响应后允许独立提交，不自动重放。
 * @dependencies RPC
 * @index_tags tasks, idempotency, client
 * @author holic512
 */
import { rpc, RequestError } from "./client";

export function createTaskSubmission(send: typeof rpc = rpc) {
  const pending = new Map<string, string>();
  return async function submit<T>(
    method: "tasks.create" | "actions.run",
    params: Record<string, unknown>,
  ): Promise<T> {
    const fingerprint = JSON.stringify({ method, params });
    const key = pending.get(fingerprint) ?? crypto.randomUUID();
    pending.set(fingerprint, key);
    try {
      const result = await send<T>(method, { ...params, idempotencyKey: key });
      pending.delete(fingerprint);
      return result;
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) throw error;
      throw new Error(
        "未收到明确的任务提交结果，任务可能已入队。请保留当前页面和原参数，可再次确认以找回原任务；刷新页面或修改参数后重新提交可能重复执行。",
        { cause: error },
      );
    }
  };
}
