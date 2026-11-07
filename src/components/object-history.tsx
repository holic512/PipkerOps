"use client";
import { useEffect, useId, useRef, useState } from "react";
import { DataTable, QueryState, useOperation, useQuery } from "./shared";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { TrendChart } from "@/components/ui/chart";
import { date, rpc } from "@/lib/client";
import {
  objectMetricUnits,
  processIdentity,
  processObjectId,
  type ObjectKind,
} from "@/lib/object-monitoring";
import {
  useMonitoringWorkspace,
  type ObjectSelection,
} from "./monitoring-workspace";

type Row = Record<string, unknown>;
type History = {
  unit: string;
  bucketSeconds: number;
  coverage: string;
  reason: string;
  from: string;
  to: string;
  objects: {
    objectId: string;
    identity: Row;
    state: string;
    coverage: string;
  }[];
  series: {
    objectId: string;
    name: string;
    identity: Row;
    points: {
      recordedAt: string;
      value: number | null;
      mean: number | null;
      maximum: number | null;
      gapCount: number;
      validCount: number;
      bootId: string | null;
    }[];
  }[];
};
type Watches = {
  revision: number;
  ackRevision: number;
  ackedAt: string | null;
  watches: {
    objectId: string;
    name: string;
    pid: number;
    bootId: string;
    startTicks: string;
  }[];
};
const metricLabels: Record<string, string> = {
  cpuPercent: "CPU（按单核）",
  memoryPercent: "内存使用率",
  rss: "RSS",
  vms: "VMS",
  readRate: "读取速率",
  writeRate: "写入速率",
  threads: "线程数",
  memoryUsed: "内存使用量",
  memoryLimit: "内存限制",
  networkRecv: "网络接收",
  networkSent: "网络发送",
  ioRead: "磁盘读取",
  ioWrite: "磁盘写入",
  restartCount: "累计重启次数",
  observations: "有效观察样本",
  durationMs: "采集耗时",
  intervalMs: "观察间隔",
  freshnessMs: "接收时新鲜度",
};
export function ObjectActions({
  row,
  kind,
  supported,
}: {
  row: Row;
  kind: ObjectKind;
  supported: boolean;
}) {
  const actionId = useId();
  const workspace = useMonitoringWorkspace();
  const user = useQuery<{ role: string }>("users.me", {}, 0);
  const watches = useQuery<Watches>(
    workspace && kind === "process" && supported
      ? "nodes.processWatches.list"
      : null,
    { nodeId: workspace?.nodeId },
  );
  const operation = useOperation(() => void watches.mutate());
  const identity = processIdentity.safeParse(row);
  const objectId =
    kind === "process"
      ? identity.success
        ? processObjectId(identity.data)
        : ""
      : kind === "container"
        ? String(row.id ?? "")
        : String(row.name ?? row.category ?? "");
  const enabled =
    supported &&
    !!objectId &&
    (kind !== "container" || /^[a-f0-9]{64}$/.test(objectId));
  const watching = watches.data?.watches.some((w) => w.objectId === objectId);
  const focusId = `object-history-${kind}-${objectId}-${actionId}`;
  return (
    <div className="inline-actions">
      <Button
        id={focusId}
        variant="link"
        disabled={!enabled || !workspace}
        title={
          enabled
            ? "查看此准确实例的历史与观察事件"
            : "需要升级 Agent 并等待准确实例身份采样"
        }
        onClick={() => {
          workspace?.setState((s) => ({
            ...s,
            object: {
              kind,
              objectIds: [objectId],
              metric: Object.keys(objectMetricUnits[kind])[0],
              hours: s.hours,
              to: new Date().toISOString(),
              focusId,
            },
            returnTab:
              kind === "process"
                ? "processes"
                : kind === "diagnostics"
                  ? "details"
                  : "services",
          }));
        }}
      >
        历史 / 事件{!enabled ? "（需要升级）" : ""}
      </Button>
      {kind === "process" && user.data?.role !== "VIEWER" && (
        <Button
          variant="link"
          disabled={
            !enabled ||
            !identity.success ||
            operation.busy ||
            !watches.data ||
            (!watching && watches.data.watches.length >= 20)
          }
          onClick={() =>
            operation.run(() =>
              rpc(
                watching
                  ? "nodes.processWatches.delete"
                  : "nodes.processWatches.save",
                watching
                  ? { nodeId: workspace?.nodeId, objectId }
                  : { nodeId: workspace?.nodeId, ...identity.data },
              ),
            )
          }
        >
          {watching ? "取消关注" : "关注实例"}
        </Button>
      )}
      {operation.ui}
    </div>
  );
}

export function ProcessWatches({ nodeId }: { nodeId: string }) {
  const q = useQuery<Watches>("nodes.processWatches.list", { nodeId });
  const user = useQuery<{ role: string }>("users.me", {}, 0);
  const operation = useOperation(() => void q.mutate());
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>节点共享进程关注 · {q.data?.watches.length ?? "—"}/20</h2>
      </div>
      {operation.ui}
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
        empty={!q.data?.watches.length}
        emptyText="可从进程明细关注准确实例。退出后结束关注，不跟随复用的 PID。"
      >
        <p className="monitoring-panel-note">
          配置版本 {q.data?.revision} ·{" "}
          {q.data?.ackRevision === q.data?.revision
            ? `Agent 已确认 ${date(q.data?.ackedAt)}`
            : "等待 Agent 确认 / 30秒核对"}
        </p>
        <DataTable
          label="关注进程实例"
          headers={["名称", "PID", "启动 ticks", "启动身份", "操作"]}
        >
          {q.data?.watches.map((w) => (
            <tr key={w.objectId}>
              <td>{w.name}</td>
              <td>{w.pid}</td>
              <td>{w.startTicks}</td>
              <td>{w.bootId}</td>
              <td>
                <ObjectActions row={w} kind="process" supported />
                {user.data?.role !== "VIEWER" && (
                  <Button
                    variant="link"
                    disabled={operation.busy}
                    onClick={() =>
                      operation.run(() =>
                        rpc("nodes.processWatches.delete", {
                          nodeId,
                          objectId: w.objectId,
                        }),
                      )
                    }
                  >
                    移除关注
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </QueryState>
    </section>
  );
}

type Cursor = { recordedAt: string; id: string };
function ObjectTimeline({
  nodeId,
  selection,
}: {
  nodeId: string;
  selection: ObjectSelection;
}) {
  const [eventObject, setEventObject] = useState(selection.objectIds[0]);
  const [cursor, setCursor] = useState<Cursor>();
  const [stack, setStack] = useState<(Cursor | undefined)[]>([]);
  const q = useQuery<{
    events: {
      id: string;
      recordedAt: string;
      objectId: string;
      fromState: string | null;
      toState: string;
      coverage: string;
      reason: string;
      bootId: string;
    }[];
    nextCursor: Cursor | null;
    semantics: string;
  }>(
    "nodes.events.list",
    {
      nodeId,
      kind: selection.kind,
      objectId: eventObject,
      hours: selection.hours,
      from: selection.from,
      to: selection.to,
      cursor,
    },
    0,
  );
  return (
    <section>
      <h3>采样观察时间线</h3>
      <label>
        事件对象
        <NativeSelect
          value={eventObject}
          onChange={(e) => {
            setEventObject(e.target.value);
            setCursor(undefined);
            setStack([]);
          }}
        >
          {selection.objectIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </NativeSelect>
      </label>
      <p className="muted">
        {q.data?.semantics ?? "记录采样观察，不推断采样间隔内的全部事件。"}
      </p>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        empty={!q.data?.events.length}
        emptyText="所选范围没有已观察到的状态变化。"
        retry={() => void q.mutate()}
      >
        <DataTable
          label="对象状态与采样缺口时间线"
          headers={["时间", "对象", "变化", "覆盖", "原因", "节点启动分段"]}
        >
          {q.data?.events.map((e) => (
            <tr key={e.id}>
              <td>{date(e.recordedAt)}</td>
              <td>{e.objectId}</td>
              <td>
                {e.fromState ?? "首次观察"} → {e.toState}
              </td>
              <td>{e.coverage}</td>
              <td>{e.reason || "采样观察"}</td>
              <td>{e.bootId}</td>
            </tr>
          ))}
        </DataTable>
      </QueryState>
      <nav className="toolbar" aria-label="状态事件分页">
        <Button
          variant="outline"
          disabled={!stack.length || q.isLoading}
          onClick={() => {
            setCursor(stack.at(-1));
            setStack((s) => s.slice(0, -1));
          }}
        >
          上一页
        </Button>
        <span>每页最多100条</span>
        <Button
          variant="outline"
          disabled={!q.data?.nextCursor || q.isLoading}
          onClick={() => {
            setStack((s) => [...s, cursor]);
            setCursor(q.data!.nextCursor!);
          }}
        >
          下一页
        </Button>
      </nav>
    </section>
  );
}

export function ObjectHistory({ nodeId }: { nodeId: string }) {
  const workspace = useMonitoringWorkspace();
  const selection = workspace?.state.object;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selection) {
      ref.current?.focus();
      ref.current?.scrollIntoView({ block: "start" });
    }
  }, [selection]);
  const q = useQuery<History>(
    selection ? "nodes.history" : null,
    { nodeId, ...selection },
    30000,
  );
  if (!selection || !workspace) return null;
  const update = (patch: Partial<ObjectSelection>) =>
    workspace.setState((s) => ({
      ...s,
      hours: patch.hours ?? s.hours,
      object: { ...selection, ...patch },
    }));
  const localDate = (v?: string) =>
    v
      ? new Date(Date.parse(v) - new Date(v).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : "";
  const kindLabels = {
    process: "进程实例",
    container: "容器实例",
    service: "服务",
    diagnostics: "采集诊断",
  };
  const identities = new Map(
    q.data?.objects.map((o) => [o.objectId, o.identity]),
  );
  for (const id of selection.objectIds)
    if (!identities.has(id)) identities.set(id, { id });
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="panel monitoring-object-history"
      aria-label="对象历史与观察事件"
    >
      <div className="panel-header">
        <h2>{kindLabels[selection.kind]}历史与事件</h2>
        <Button
          variant="outline"
          onClick={() => {
            workspace.setState((s) => ({ ...s, object: undefined }));
            requestAnimationFrame(() => {
              const target = document.getElementById(selection.focusId ?? "");
              target?.focus();
              target?.scrollIntoView({ block: "center" });
            });
          }}
        >
          返回原筛选
        </Button>
      </div>
      <div className="toolbar monitoring-history-controls">
        <label>
          指标
          <NativeSelect
            value={selection.metric}
            onChange={(e) => update({ metric: e.target.value })}
          >
            {Object.entries(objectMetricUnits[selection.kind]).map(
              ([key, unit]) => (
                <option key={key} value={key}>
                  {metricLabels[key]} · {unit || "数量"}
                </option>
              ),
            )}
          </NativeSelect>
        </label>
        <label>
          时间范围
          <NativeSelect
            value={selection.hours}
            onChange={(e) =>
              update({
                hours: Number(e.target.value),
                from: undefined,
                to: new Date().toISOString(),
              })
            }
          >
            {[1, 6, 24, 72, 168, 720].map((h) => (
              <option key={h} value={h}>
                {h} 小时
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          开始
          <Input
            type="datetime-local"
            value={localDate(selection.from)}
            onChange={(e) =>
              update({
                from: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : undefined,
              })
            }
          />
        </label>
        <label>
          结束
          <Input
            type="datetime-local"
            value={localDate(selection.to)}
            onChange={(e) =>
              update({
                to: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : undefined,
              })
            }
          />
        </label>
        <label>
          比较对象（最多5个）
          <NativeSelect
            multiple
            size={3}
            value={selection.objectIds}
            onChange={(e) => {
              const ids = Array.from(e.target.selectedOptions)
                .map((o) => o.value)
                .slice(0, 5);
              if (ids.length) update({ objectIds: ids });
            }}
          >
            {[...identities].map(([id, identity]) => (
              <option key={id} value={id}>
                {String(identity.name ?? id)} · {id}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
      >
        <p className="monitoring-panel-note" role="status">
          {q.data?.reason} · 原始7天 / 5分钟聚合与事件30天 · 分辨率{" "}
          {q.data?.bucketSeconds ?? "—"}秒
        </p>
        {q.data?.coverage === "upgrade_required" ? (
          <p className="muted">需要升级 Agent，未生成新增对象历史。</p>
        ) : q.data?.series.some((s) =>
            s.points.some((p) => p.value !== null),
          ) ? (
          <TrendChart
            label={`${kindLabels[selection.kind]} ${metricLabels[selection.metric]}`}
            unit={q.data.unit}
            series={q.data.series.map((s) => ({
              ...s,
              name: `${String(s.identity.name ?? s.objectId)} · ${s.objectId}`,
            }))}
          />
        ) : (
          <p className="muted monitoring-panel-note">
            当前范围无有效数值采样；下方时间线保留状态及缺口。
          </p>
        )}
        <p className="muted monitoring-panel-note">
          {q.data?.series.reduce(
            (sum, s) => sum + s.points.filter((p) => p.gapCount > 0).length,
            0,
          ) ?? 0}{" "}
          个含缺口的时间桶；图线不跨缺口或节点启动分段连接。状态事件不参与均值。
        </p>
        {q.data && (
          <ObjectTimeline
            key={JSON.stringify(selection)}
            nodeId={nodeId}
            selection={{ ...selection, from: q.data.from, to: q.data.to }}
          />
        )}
      </QueryState>
    </section>
  );
}
