export const activeContainerMetric = "containerActiveFailure";

type ContainerAssessment = {
  status: "failure" | "completed" | "clear" | "unknown";
  reason: string;
};

export function assessContainer(
  row: Record<string, unknown>,
): ContainerAssessment {
  if (row.state === "dead")
    return { status: "failure", reason: "容器状态为 dead" };
  if (row.state === "restarting")
    return { status: "failure", reason: "容器正在重启" };
  if (row.inspectError || typeof row.state !== "string" || !row.state)
    return { status: "unknown", reason: "容器详情采集不完整" };
  if (row.state === "exited" && row.lifecycle === "oneshot") {
    if (row.exitCode === 0)
      return { status: "completed", reason: "已完成（退出码 0）" };
    if (typeof row.exitCode === "number")
      return {
        status: "failure",
        reason: `执行失败（退出码 ${row.exitCode}）`,
      };
    return { status: "unknown", reason: "等待一次性任务退出码" };
  }
  if (row.health === "unhealthy")
    return { status: "failure", reason: "健康检查失败" };
  const count = row.recentRestartCount;
  const hasCount =
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  if (hasCount && count >= 3) {
    const measured =
      row.restartWindowComplete === true ? count : `至少 ${count}`;
    return { status: "failure", reason: `近 5 分钟重启 ${measured} 次` };
  }
  if (!Object.hasOwn(row, "restartWindowComplete"))
    return {
      status: "unknown",
      reason: "未采集近期重启窗口；检查采集诊断或 Agent 版本",
    };
  if (row.restartWindowComplete !== true || !hasCount)
    return { status: "unknown", reason: "等待连续采样确认近 5 分钟重启次数" };
  if (typeof row.health !== "string" || !row.health)
    return { status: "unknown", reason: "健康状态未采集" };
  return { status: "clear", reason: "未观察到异常" };
}
