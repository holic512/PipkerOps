import { ApiError } from "./auth";

export const updatePreparationStages = {
  authorization: "校验更新权限",
  connection: "检查 Agent 连接",
  registration: "核对部署登记",
  release: "获取发布清单",
  artifact: "下载并校验发布制品",
  transfer: "向 Agent 传输制品",
  backup: "创建更新前备份",
  execution: "创建节点执行任务",
} as const;
export type UpdatePreparationStage = keyof typeof updatePreparationStages;

/** Only emit known codes and trusted API messages, never arbitrary driver text. */
export function updatePreparationFailure(
  stage: UpdatePreparationStage,
  error: unknown,
) {
  const labels: Record<string, string> = {
    TimeoutError: "请求超时",
    AbortError: "请求中断",
    UND_ERR_CONNECT_TIMEOUT: "建立下载连接超时",
    UND_ERR_HEADERS_TIMEOUT: "等待下载响应超时",
    UND_ERR_BODY_TIMEOUT: "下载数据传输超时",
    ENOTFOUND: "域名解析失败",
    EAI_AGAIN: "域名解析暂时失败",
    ECONNREFUSED: "连接被拒绝",
    ECONNRESET: "连接中断",
    ETIMEDOUT: "网络请求超时",
    EACCES: "文件或目录权限不足",
    EPERM: "操作权限不足",
    ENOENT: "所需文件或程序不存在",
    ENOSPC: "磁盘空间不足",
    EROFS: "文件系统只读",
    CERT_HAS_EXPIRED: "证书已过期",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "证书校验失败",
    DEPTH_ZERO_SELF_SIGNED_CERT: "证书不受信任",
  };
  let current: unknown = error;
  let code = "UNKNOWN";
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    const e = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof e.code === "string" && Object.hasOwn(labels, e.code)) {
      code = e.code;
      break;
    }
    if (typeof e.name === "string" && Object.hasOwn(labels, e.name)) {
      code = e.name;
      break;
    }
    current = e.cause;
  }
  const reason =
    error instanceof ApiError
      ? error.message.slice(0, 3000)
      : error instanceof SyntaxError
        ? "返回内容不是有效的 JSON"
        : error &&
            typeof error === "object" &&
            "name" in error &&
            error.name === "ZodError"
          ? "返回数据格式不符合更新协议"
          : (labels[code] ?? "准备操作失败，请检查 Worker 日志及相关服务");
  const advice =
    stage === "artifact" || stage === "release"
      ? "检查主控到 GitHub 及发布文件下载域名的网络、代理和下载耗时。"
      : stage === "connection" || stage === "transfer"
        ? "检查 Agent 地址、证书、凭证和节点连接。"
        : stage === "backup"
          ? "检查备份目录、可用空间及备份程序。"
          : "检查权限、部署登记及数据库连接。";
  const message = `${updatePreparationStages[stage]}失败：${reason}`;
  return {
    error: message,
    output: `更新准备失败\n阶段：${updatePreparationStages[stage]}\n原因：${reason}\n${advice}`,
    result: { preparationStage: stage, preparationErrorCode: code },
  };
}
