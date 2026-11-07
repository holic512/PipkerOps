import type { Snapshot } from "./telemetry";
import { availabilityStates } from "./telemetry";

type State = (typeof availabilityStates)[number];
export const availabilityLabels: Record<State, string> = {
  ok: "正常",
  waiting_sample: "等待采样",
  waiting_baseline: "等待基线",
  not_applicable: "不适用",
  unsupported: "不支持",
  permission_denied: "权限不足",
  failed: "采集失败",
  stale: "过期",
  upgrade_required: "需要升级",
};
export function failureState(reason: string): State {
  if (/permission denied|operation not permitted|access denied/i.test(reason))
    return "permission_denied";
  if (
    /not supported|not implemented|executable file not found|no such file or directory/i.test(
      reason,
    )
  )
    return "unsupported";
  return "failed";
}
export function availability({
  value,
  snapshot,
  legacy,
  row = {},
  field = "value",
}: {
  value: unknown;
  snapshot?: Snapshot & { stale?: boolean };
  legacy?: boolean;
  row?: Record<string, unknown>;
  field?: string;
}): { state: State; reason: string } {
  if (!snapshot)
    return { state: "waiting_sample", reason: "尚未收到此类别采样" };
  if (snapshot.stale)
    return {
      state: "stale",
      reason: "节点离线或采样已过期；检查 Agent 连接和采集周期",
    };
  const fieldError =
    row.fieldErrors && typeof row.fieldErrors === "object"
      ? (row.fieldErrors as Record<string, unknown>)[field]
      : undefined;
  if (typeof fieldError === "string" && (value == null || value === ""))
    return { state: failureState(fieldError), reason: fieldError };
  if (value !== undefined && value !== null) {
    if (value === "none" || value === "")
      return { state: "not_applicable", reason: "对象未配置此项" };
    return { state: "ok", reason: "已采集" };
  }
  if (legacy)
    return {
      state: "upgrade_required",
      reason: "旧版采样未提供此字段；请升级 Agent",
    };
  if (field === "stats" && row.state !== "running")
    return {
      state: "not_applicable",
      reason: "Docker 仅为运行中的容器提供实时 stats",
    };
  if (field === "stats" && row.statsError) {
    const reason = String(row.statsError);
    return { state: failureState(reason), reason };
  }
  if (row.collectionError) {
    const reason = String(row.collectionError);
    return { state: failureState(reason), reason };
  }
  if (
    row.inspectError &&
    ["health", "restartCount", "composeProject", "composeService"].includes(
      field,
    )
  ) {
    const reason = String(row.inspectError);
    return { state: failureState(reason), reason };
  }
  const group = String(row.rawMetric ?? row.metric ?? "").split(".")[0];
  const errors = snapshot.errors.filter((e) =>
    group ? e.startsWith(group + ":") : false,
  );
  if (errors.length)
    return {
      state: failureState(errors.join("；")),
      reason: errors.join("；"),
    };
  if (
    typeof row.status === "string" &&
    availabilityStates.includes(row.status as State)
  )
    return {
      state: row.status as State,
      reason: String(row.reason ?? "采集器报告此状态"),
    };
  const rateMetrics: Record<string, string> = {
    readPerSecond: "io.read",
    writePerSecond: "io.write",
    readIOPS: "io.readIOPS",
    writeIOPS: "io.writeIOPS",
    recvPerSecond: "network.recv",
    sentPerSecond: "network.sent",
    utilPercent: "io.util",
    queueDepth: "io.queue",
    readLatency: "io.readLatency",
    writeLatency: "io.writeLatency",
  };
  const point = snapshot.series.find(
    (p) => p.metric === rateMetrics[field] && p.device === row.name,
  );
  if (point?.status)
    return { state: point.status, reason: point.reason ?? "等待连续有效计数" };
  if (point && point.value === null) {
    return {
      state: "waiting_baseline",
      reason:
        "此版 Agent 未报告具体速率状态；需连续样本，持续缺失时检查设备身份或升级 Agent",
    };
  }
  if (field === "speedMbps")
    return { state: "unsupported", reason: "网卡驱动或虚拟链路未提供速率" };
  if (
    ["readLatency", "writeLatency"].includes(field) &&
    row[field === "readLatency" ? "readIOPS" : "writeIOPS"] === 0
  )
    return {
      state: "not_applicable",
      reason: "采样期间没有对应 IO 操作，无法计算平均延迟",
    };
  if (field === "cpuPercent")
    return {
      state: "waiting_baseline",
      reason: "进程需要两个连续样本，进程重启后重新采样",
    };
  return {
    state: "failed",
    reason: "采样未返回此字段；检查采集诊断及 Agent 版本",
  };
}
export function diagnosticAdvice(errors: string[], truncated: boolean) {
  const state = failureState(errors.join("；"));
  return [
    errors.length
      ? state === "permission_denied"
        ? "检查 Agent 运行用户及 Docker socket、procfs/sysfs 的读取权限"
        : state === "unsupported"
          ? "检查平台、内核及 Docker/systemd 安装情况"
          : "检查 Agent 日志、命令超时和对象是否已退出；修复后等待重新采样"
      : "采集正常；速率首次采样或计数重置后需等待基线",
    truncated
      ? "结果已达上限，仅代表已采集范围；缩小排查范围或在节点核对完整清单"
      : "未报告截断",
  ].join("；");
}

/** Keep expected host gauges visible even when a collector returns no point. */
export function hostMetricRows(snapshot: Snapshot) {
  const points = snapshot.series.filter((p) => !p.device);
  const expected = [
    ["cpu.total", "%"],
    ["load.1", ""],
    ["load.5", ""],
    ["load.15", ""],
    ["memory.percent", "%"],
    ["swap.percent", "%"],
    ["swap.used", "B"],
  ];
  return [
    ...points,
    ...expected
      .filter(([metric]) => !points.some((p) => p.metric === metric))
      .map(([metric, unit]) => ({ metric, unit, device: "", value: null })),
  ];
}
