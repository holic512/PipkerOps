/**
 * @file remote-files.ts
 * @project PipkerOps
 * @module remote-workspace-client
 * @description 远程文件目标、目录数据及持久任务的浏览器流程。
 * @logic 宿主机与容器选择独立任务类型；轮询到终态停止，未知结果不自动重放；目录命令只生成可粘贴文本。
 * @dependencies RPC, task submission
 * @index_tags files, container, terminal, tasks
 * @author holic512
 */
import { rpc, type TaskData } from "./client";
import { createTaskSubmission } from "./task-submission";

export type RemoteTarget = { nodeId: string; containerId: string };
export type FileAction = "list" | "read" | "write" | "mkdir" | "remove";
export type RemoteFile = {
  name: string;
  directory: boolean;
  symlink: boolean;
  size: number;
  mode: string;
  modifiedAt: string;
};
export type RemoteDirectory = {
  path: string;
  entries: RemoteFile[];
  limited: boolean;
};
export const remoteTargetKey = (target: RemoteTarget) =>
  JSON.stringify([target.nodeId, target.containerId]);
export const remoteParent = (path: string) =>
  path.slice(0, path.lastIndexOf("/")) || "/";
export const remoteChild = (parent: string, name: string) =>
  `${parent === "/" ? "" : parent}/${name}`;

export function remotePath(value: string) {
  if (!value.startsWith("/") || value.includes("\0") || value.length > 4096)
    throw new Error("请输入不超过 4096 字符的绝对路径。");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}

export function terminalDirectoryCommand(path: string) {
  const target = remotePath(path);
  if (/[\x00-\x1f\x7f]/.test(target))
    throw new Error("路径包含控制字符，请在终端手动输入。");
  return `cd -- '${target.replaceAll("'", "'\\''")}'`;
}

export class FileTaskError extends Error {
  constructor(public task: TaskData) {
    super(
      task.status === "UNKNOWN"
        ? "任务结果未知，请查看原任务与实际文件，勿重复提交。"
        : task.type.startsWith("container.files.") &&
            /unsupported|unknown task/i.test(task.error ?? "")
          ? "当前 Agent 不支持容器文件管理，请升级至 0.1.3 或更新版本。"
          : (task.error ?? `文件任务未成功（${task.status}）`),
    );
  }
}

export function createFileTaskRunner(send: typeof rpc = rpc) {
  const submit = createTaskSubmission(send);
  const pendingWrites = new Map<string, TaskData>();
  return async (
    target: RemoteTarget,
    action: FileAction,
    payload: { path: string; content?: string },
    options: {
      confirmed?: boolean;
      signal?: AbortSignal;
      onTask?: (task: TaskData) => void;
    } = {},
  ) => {
    options.signal?.throwIfAborted();
    const writing = ["write", "mkdir", "remove"].includes(action);
    const fingerprint = JSON.stringify({
      target: remoteTargetKey(target),
      action,
      payload,
    });
    const pending = pendingWrites.get(fingerprint);
    let task = pending
      ? await send<TaskData>("tasks.get", { id: pending.id })
      : await submit<TaskData>("tasks.create", {
          type: `${target.containerId ? "container.files" : "files"}.${action}`,
          nodeId: target.nodeId,
          payload: {
            ...payload,
            ...(target.containerId ? { containerId: target.containerId } : {}),
          },
          confirmed: options.confirmed ?? false,
        });
    if (writing) pendingWrites.set(fingerprint, task);
    const deadline = Date.now() + 60000;
    while (true) {
      options.signal?.throwIfAborted();
      options.onTask?.(task);
      if (
        ["SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"].includes(task.status)
      ) {
        if (writing && task.status !== "UNKNOWN")
          pendingWrites.delete(fingerprint);
        if (task.status !== "SUCCEEDED") throw new FileTaskError(task);
        return task;
      }
      if (Date.now() >= deadline)
        throw new Error(
          "任务尚未结束，请查看原任务进度。再次确认相同写操作只会查询原任务，不会重新执行。",
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      options.signal?.throwIfAborted();
      task = await send<TaskData>("tasks.get", { id: task.id });
      if (writing) pendingWrites.set(fingerprint, task);
    }
  };
}
export type FileTaskRunner = ReturnType<typeof createFileTaskRunner>;
