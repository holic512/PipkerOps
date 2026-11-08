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
export function updateTaskSteps(
  status: string,
  hasChild: boolean,
  childStatus?: string,
): string[] {
  if (status === "SUCCEEDED")
    return ["done", hasChild ? "done" : "skipped", "done"];
  if (!hasChild)
    return [
      status === "FAILED"
        ? "failed"
        : status === "UNKNOWN"
          ? "unknown"
          : status === "RUNNING"
            ? "active"
            : "waiting",
      "waiting",
      "waiting",
    ];
  if (childStatus === "SUCCEEDED")
    return [
      "done",
      "done",
      status === "FAILED"
        ? "failed"
        : status === "UNKNOWN"
          ? "unknown"
          : "active",
    ];
  return [
    "done",
    childStatus === "UNKNOWN" || status === "UNKNOWN"
      ? "unknown"
      : ["FAILED", "CANCELLED"].includes(childStatus ?? "")
        ? "failed"
        : "active",
    "waiting",
  ];
}
export function updateVersionRelation(
  current: string | null | undefined,
  target: string | undefined,
) {
  if (
    !current ||
    !target ||
    !/^\d+\.\d+\.\d+$/.test(current) ||
    !/^\d+\.\d+\.\d+$/.test(target)
  )
    return "unknown";
  const a = current.split(".").map(Number),
    b = target.split(".").map(Number);
  if (![...a, ...b].every(Number.isSafeInteger)) return "unknown";
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? "upgrade" : "downgrade";
  }
  return "same";
}
