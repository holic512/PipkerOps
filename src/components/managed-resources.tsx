/**
 * @file managed-resources.tsx
 * @project PipkerOps
 * @module managed-resource-ui
 * @description 独立资源列表、定向登记、固定定位规则与多应用共享管理。
 * @logic 登记先预览再确认；详情以资源身份导航，操作核对实例与受影响应用。
 * @dependencies shared UI, resource RPC, Docker operations
 * @index_tags resources, discovery, applications, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { rpc, date, type AppData, type NodeData } from "@/lib/client";
import type { ResourceData } from "@/lib/resource-contracts";
import type { DockerContainer, DockerOperation } from "@/lib/docker-contracts";
import {
  DataTable,
  PageTitle,
  QueryState,
  Status,
  ResourceForm,
  useOperation,
  useQuery,
} from "./shared";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Checkbox } from "./ui/checkbox";
import { BusinessDialog } from "./ui/dialog";
import { OperationDialog } from "./docker-manager";

const strategyNames: Record<string, string> = {
  compose: "Compose 项目 / 服务",
  label: "资源标签",
  name: "固定容器名",
  unconfirmed: "待确认定位规则",
};
export function locatorText(
  r: Pick<
    ResourceData,
    "strategy" | "project" | "service" | "containerName" | "labelValue"
  >,
) {
  return r.strategy === "compose"
    ? `${r.project} / ${r.service}`
    : r.strategy === "label"
      ? `pipkerops.resource-id=${r.labelValue}`
      : r.strategy === "name"
        ? r.containerName
        : "请重新指定实例与规则";
}
export function ManagedResources({ resourceId }: { resourceId?: string }) {
  const search = useSearchParams();
  const [nodeId, setNodeId] = useState(search.get("node") ?? "");
  const [type, setType] = useState("");
  const [identification, setIdentification] = useState("");
  const [runtimeState, setRuntimeState] = useState("");
  const [applicationId, setApplicationId] = useState(
    search.get("applicationId") ?? "",
  );
  const q = useQuery<ResourceData[]>("resources.list", {
    ...(nodeId && { nodeId }),
    ...(type && { type }),
    ...(identification && { identification }),
    ...(runtimeState && { runtimeState }),
    ...(applicationId && { applicationId }),
  });
  const apps = useQuery<AppData[]>("applications.list");
  const nodes = useQuery<NodeData[]>("nodes.list");
  const detail = useQuery<ResourceData>(resourceId ? "resources.get" : null, {
    resourceId,
  });
  const [registration, setRegistration] = useState<{
    nodeId: string;
    containerId: string;
    resource?: ResourceData;
  } | null>(() =>
    search.get("register")
      ? {
          nodeId: search.get("node") ?? "",
          containerId: search.get("register")!,
        }
      : null,
  );
  return (
    <>
      <PageTitle title="资源管理">
        <Button
          variant="outline"
          onClick={() => {
            void q.mutate();
            void detail.mutate();
          }}
        >
          刷新
        </Button>
        <Button asChild>
          <Link href={`/docker${nodeId ? `?node=${nodeId}` : ""}`}>
            从容器登记资源
          </Link>
        </Button>
      </PageTitle>
      <div className="toolbar">
        <label>
          节点
          <NativeSelect
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
          >
            <option value="">全部节点</option>
            {nodes.data?.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          资源类型
          <NativeSelect value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">全部类型</option>
            {[
              "docker",
              "compose",
              "systemd",
              "process",
              "database",
              "nginx",
            ].map((v) => (
              <option key={v} value={v}>
                {v === "compose" ? "Compose 服务" : v}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          识别状态
          <NativeSelect
            value={identification}
            onChange={(e) => setIdentification(e.target.value)}
          >
            <option value="">全部识别状态</option>
            {Object.entries({
              LOCATED: "已定位",
              MISSING: "缺失 / 待确认",
              CONFLICT: "冲突",
              STALE: "数据过期",
              UNCONFIRMED: "待确认",
            }).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          运行状态
          <NativeSelect
            value={runtimeState}
            onChange={(e) => setRuntimeState(e.target.value)}
          >
            <option value="">全部运行状态</option>
            {["RUNNING", "STOPPED", "FAILED", "UNKNOWN", "PARTIAL"].map((v) => (
              <option key={v} value={v}>
                {
                  {
                    RUNNING: "运行",
                    STOPPED: "停止",
                    FAILED: "失败",
                    UNKNOWN: "未知",
                    PARTIAL: "部分运行",
                  }[v]
                }
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          关联应用
          <NativeSelect
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
          >
            <option value="">全部应用</option>
            {apps.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <p className="muted">
        资源身份长期保留。识别与运行状态分别展示；业务健康以应用探针为准。
      </p>
      <section className="panel">
        <QueryState
          loading={q.isLoading}
          error={q.error}
          retry={() => void q.mutate()}
          empty={!q.data?.length}
          emptyTitle="暂无符合条件的资源"
          emptyText="调整筛选，或前往 Docker 列表选择容器并登记。"
        >
          <DataTable
            headers={[
              "资源名称",
              "所属节点",
              "定位方式",
              "识别 / 运行",
              "当前实例",
              "关联应用",
              "最近发现",
            ]}
          >
            {q.data?.map((r) => (
              <tr key={r.id}>
                <td>
                  <Button variant="link" asChild>
                    <Link href={`/resources/${r.id}`}>{r.name}</Link>
                  </Button>
                  <small>
                    {r.type === "compose" ? "服务资源 · 支持多副本" : r.type}
                  </small>
                </td>
                <td>
                  <Button variant="link" asChild>
                    <Link href={`/nodes/${r.nodeId}`}>{r.node.name}</Link>
                  </Button>
                </td>
                <td>
                  {strategyNames[r.strategy]}
                  <small>{locatorText(r)}</small>
                </td>
                <td>
                  <Status value={r.identification} />
                  <small>
                    <Status
                      value={
                        r.runtimeState === "RUNNING"
                          ? "running"
                          : r.runtimeState
                      }
                    />
                  </small>
                </td>
                <td>
                  {r.instances.length
                    ? r.instances.map((c) => (
                        <small key={c.id}>
                          {c.name} · {c.id.slice(0, 12)}
                        </small>
                      ))
                    : "暂无匹配实例"}
                </td>
                <td>
                  {r.applications.map((a) => a.application.name).join("、") ||
                    "独立资源"}
                </td>
                <td>{date(r.lastDiscoveredAt)}</td>
              </tr>
            ))}
          </DataTable>
        </QueryState>
      </section>
      {resourceId && (
        <QueryState
          loading={detail.isLoading}
          error={detail.error}
          retry={() => void detail.mutate()}
        >
          {detail.data && (
            <ResourceDetail
              key={resourceId}
              resource={detail.data}
              apps={apps.data ?? []}
              refresh={() => {
                void detail.mutate();
                void q.mutate();
              }}
              rebind={() =>
                setRegistration({
                  nodeId: detail.data!.nodeId,
                  containerId: "",
                  resource: detail.data,
                })
              }
            />
          )}
        </QueryState>
      )}
      {registration && (
        <ResourceRegistration
          {...registration}
          close={() => setRegistration(null)}
          saved={() => {
            setRegistration(null);
            void q.mutate();
            void detail.mutate();
          }}
        />
      )}
    </>
  );
}
function ResourceDetail({
  resource: r,
  apps,
  refresh,
  rebind,
}: {
  resource: ResourceData;
  apps: AppData[];
  refresh: () => void;
  rebind: () => void;
}) {
  const router = useRouter();
  const op = useOperation(refresh, true);
  const [tab, setTab] = useState("details");
  const [instanceId, setInstanceId] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  const [operationId, setOperationId] = useState("");
  const pending = useRef(new Map<string, string>());
  const current =
    r.instances.find((c) => c.id === instanceId) ??
    (r.instances.length === 1 ? r.instances[0] : undefined);
  const affected =
    r.applications.map((a) => a.application.name).join("、") || "无关联应用";
  return (
    <>
      <BusinessDialog
        title={r.name}
        size="detail"
        operation={op}
        onClose={() => {
          router.push("/resources");
        }}
      >
        <div className="inline-actions">
          <Button
            variant="outline"
            onClick={() =>
              void op.run(() => rpc("resources.discover", { resourceId: r.id }))
            }
          >
            重新发现
          </Button>
          <Button
            variant="outline"
            onClick={() => setTab(tab === "edit" ? "details" : "edit")}
          >
            编辑名称
          </Button>
          <Button variant="outline" onClick={rebind}>
            重新指定实例
          </Button>
        </div>
        <p>
          <code>{r.id}</code>
        </p>
        <p>
          {r.node.name} · {strategyNames[r.strategy]} · {locatorText(r)}
        </p>
        <p>
          <Status value={r.identification} />{" "}
          <Status
            value={r.runtimeState === "RUNNING" ? "running" : r.runtimeState}
          />{" "}
          · 最近成功发现：{date(r.lastDiscoveredAt)} · 最近匹配：
          {date(r.lastSeenAt)}
        </p>
        {r.discoveryError && (
          <p role="alert" className="inline-error">
            {r.discoveryError}。保留上次实例，仅在重新成功定位后允许操作。
          </p>
        )}
        {r.identification === "MISSING" && (
          <p role="status">
            原定位规则未匹配，资源和应用关联继续保留，等待确认。可重新指定实例及后续规则。
          </p>
        )}
        {r.identification === "CONFLICT" && (
          <p role="alert">
            单实例资源匹配到多个候选，操作已禁用。请检查重复标签或重新指定定位规则。
          </p>
        )}
        {tab === "edit" && (
          <ResourceForm
            busy={op.busy}
            fields={[
              {
                name: "name",
                label: "资源名称",
                required: true,
                defaultValue: r.name,
              },
            ]}
            onSubmit={(d) =>
              op.run(() => rpc("resources.update", { resourceId: r.id, ...d }))
            }
          />
        )}
        <h2>关联应用</h2>
        <p>共享资源操作将影响：{affected}</p>
        <div className="inline-actions">
          {r.applications.map((a) => (
            <span key={a.applicationId}>
              <Button variant="link" asChild>
                <Link href={`/applications?applicationId=${a.applicationId}`}>
                  {a.application.name}
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  op.ask(
                    "解除此应用关联？",
                    `只解除 ${a.application.name} 与 ${r.name} 的关系。其他应用和资源保留。`,
                    () =>
                      rpc("resources.unlink", {
                        resourceId: r.id,
                        applicationId: a.applicationId,
                        confirmed: true,
                      }),
                  )
                }
              >
                解除关联
              </Button>
            </span>
          ))}
        </div>
        <ResourceForm
          fields={[
            {
              name: "applicationId",
              label: "关联应用",
              type: "select",
              required: true,
              options: apps
                .filter(
                  (a) => !r.applications.some((l) => l.applicationId === a.id),
                )
                .map((a) => ({ value: a.id, label: a.name })),
            },
          ]}
          submit="建立关联"
          busy={op.busy}
          onSubmit={(d) =>
            op.run(() => rpc("resources.associate", { resourceId: r.id, ...d }))
          }
        />
        <h2>{r.type === "compose" ? "服务运行实例" : "当前运行实例"}</h2>
        <DataTable headers={["容器", "实例 ID", "运行状态"]}>
          {r.instances.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>
                <code>{c.id}</code>
              </td>
              <td>
                <Status value={c.state} />
              </td>
            </tr>
          ))}
        </DataTable>
        {r.instances.length > 1 && (
          <label>
            选择操作实例
            <NativeSelect
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
            >
              <option value="">请选择明确实例</option>
              {r.instances.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.id.slice(0, 12)}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        <div className="inline-actions">
          <Button
            variant="outline"
            disabled={!current || r.identification !== "LOCATED" || op.busy}
            onClick={() =>
              void op.run(async () => {
                const result = await rpc<{ output: string }>("resources.logs", {
                  resourceId: r.id,
                  expectedContainerId: current!.id,
                });
                setLogs(result.output);
                return result;
              })
            }
          >
            查看日志
          </Button>
          {["start", "stop", "restart", "remove"].map((action) => (
            <Button
              key={action}
              variant={action === "remove" ? "destructive" : "outline"}
              disabled={!current || r.identification !== "LOCATED" || op.busy}
              onClick={() =>
                op.ask(
                  "确认资源操作",
                  `资源：${r.name}（${r.id}）；节点：${r.node.name}；当前实例：${current!.id}；操作：${action}；受影响应用：${affected}。执行前重新核对实例，变化后须重新确认。`,
                  async () => {
                    const fingerprint = `${current!.id}:${action}`;
                    const key =
                      pending.current.get(fingerprint) ?? crypto.randomUUID();
                    pending.current.set(fingerprint, key);
                    const result = await rpc<DockerOperation>(
                      "resources.action",
                      {
                        resourceId: r.id,
                        expectedContainerId: current!.id,
                        action,
                        confirmed: true,
                        idempotencyKey: key,
                      },
                    );
                    setOperationId(result.id);
                    if (result.status !== "UNKNOWN")
                      pending.current.delete(fingerprint);
                    return result;
                  },
                )
              }
            >
              {
                {
                  start: "启动",
                  stop: "停止",
                  restart: "重启",
                  remove: "删除实例",
                }[action]
              }
            </Button>
          ))}
          {current && (
            <Button variant="outline" asChild>
              <Link
                href={`/terminal?${new URLSearchParams({ node: r.nodeId, target: current.id, resourceId: r.id })}`}
              >
                远程工作台
              </Link>
            </Button>
          )}
          {r.strategy === "compose" && (
            <Button variant="outline" asChild>
              <Link
                href={`/docker?${new URLSearchParams({ resourceId: r.id, action: "compose.deploy" })}`}
              >
                部署配置与更新
              </Link>
            </Button>
          )}
        </div>
        <p className="muted">
          删除实例保留资源及关联。历史操作与已建立的终端会话保持原实例目标。
        </p>
        {logs !== null && (
          <section>
            <h2>实例日志</h2>
            <pre className="code-block">{logs || "暂无日志"}</pre>
          </section>
        )}
      </BusinessDialog>
      {operationId && (
        <OperationDialog
          id={operationId}
          onClose={() => setOperationId("")}
          onStatus={() => {}}
          onCompleted={refresh}
        />
      )}
    </>
  );
}
type Preview = {
  locator: Pick<
    ResourceData,
    "strategy" | "project" | "service" | "containerName" | "labelValue"
  >;
  instances: DockerContainer[];
  identification: string;
  duplicates: { id: string; name: string }[];
};
function ResourceRegistration({
  nodeId,
  containerId: initialId,
  resource,
  close,
  saved,
}: {
  nodeId: string;
  containerId: string;
  resource?: ResourceData;
  close: () => void;
  saved: () => void;
}) {
  const containers = useQuery<{ containers: DockerContainer[] }>(
    "docker.list",
    { nodeId },
    0,
  );
  const node = useQuery<NodeData[]>("nodes.list");
  const [containerId, setContainerId] = useState(initialId);
  const selected = containers.data?.containers.find(
    (c) => c.id === containerId,
  );
  const [name, setName] = useState(resource?.name ?? "");
  const [strategy, setStrategy] = useState("name");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [draftLabel] = useState(() => crypto.randomUUID());
  const op = useOperation(undefined, true);
  const labelValue = selected?.labels["pipkerops.resource-id"] || draftLabel;
  const params = {
    nodeId,
    containerId,
    strategy,
    ...(resource && { resourceId: resource.id }),
  };
  return (
    <BusinessDialog
      title={resource ? "重新指定实例与定位规则" : "登记为长期资源"}
      operation={op}
      onClose={close}
      size="detail"
      formId="register-resource"
      submit={preview ? "确认登记" : "预览匹配"}
      disabled={
        !selected ||
        !name.trim() ||
        !!preview?.duplicates.length ||
        preview?.identification === "CONFLICT"
      }
    >
      <form
        id="register-resource"
        onSubmit={(e) => {
          e.preventDefault();
          if (!preview) {
            void op.run(async () => {
              const result = await rpc<Preview>("resources.preview", params);
              setPreview(result);
              return null;
            });
          } else {
            op.ask(
              "确认定位规则与登记",
              `资源：${name}；节点：${node.data?.find((n) => n.id === nodeId)?.name ?? nodeId}；规则：${strategyNames[strategy]} ${locatorText(preview.locator)}；匹配 ${preview.instances.length} 个实例。${strategy === "name" ? "固定名称必须在重建后保持一致。" : "后续仅按此规则定位，不自动切换。"}`,
              async () => {
                const result = await rpc(
                  resource ? "resources.rebind" : "resources.register",
                  {
                    ...params,
                    ...Object.fromEntries(
                      Object.entries(preview.locator).filter(
                        ([, value]) => value !== null,
                      ),
                    ),
                    name,
                    confirmed: true,
                    persistenceConfirmed: persistent,
                  },
                );
                saved();
                return result;
              },
            );
          }
        }}
      >
        <fieldset
          disabled={op.busy}
          className="form-grid"
          onChange={() => {
            setPreview(null);
            op.clear();
          }}
        >
          <label>
            资源名称
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            所属节点
            <Input
              readOnly
              value={node.data?.find((n) => n.id === nodeId)?.name ?? nodeId}
            />
          </label>
          <label>
            当前容器
            <NativeSelect
              required
              value={containerId}
              onChange={(e) => setContainerId(e.target.value)}
            >
              <option value="">选择当前真实实例</option>
              {containers.data?.containers.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name} · {c.id.slice(0, 12)}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label>
            定位规则
            <NativeSelect
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              <option value="name">固定容器名（依赖重建后名称一致）</option>
              <option value="compose">
                Compose 节点 / 项目 / 服务（允许多副本）
              </option>
              <option value="label">自定义资源标签（必须写入部署配置）</option>
            </NativeSelect>
          </label>
        </fieldset>
        <QueryState
          loading={containers.isLoading}
          error={containers.error}
          retry={() => void containers.mutate()}
        >
          {selected && (
            <p>
              当前实例：<code>{selected.id}</code> · {selected.name} ·{" "}
              <Status value={selected.state} />
            </p>
          )}
        </QueryState>
        {strategy === "compose" && (
          <p>
            项目：
            {selected?.labels["com.docker.compose.project"] || "未发现项目标签"}
            ；服务：
            {selected?.labels["com.docker.compose.service"] || "未发现服务标签"}
            。定位整个服务，包含全部副本。
          </p>
        )}
        {strategy === "name" && (
          <p>
            仅按此节点的完整容器名精确匹配。重建时必须保留名称；改名后资源进入待确认。
          </p>
        )}
        {strategy === "label" && (
          <section>
            <p>
              请将以下标签写入实际 Compose 或 docker run
              脚本并审查。当前容器必须已携带该标签后才能登记；平台不会修改配置或重建容器。
            </p>
            <pre className="code-block">{`# Compose 服务下\nlabels:\n  pipkerops.resource-id: "${labelValue}"\n\n# docker run 参数\n--label pipkerops.resource-id=${labelValue}`}</pre>
            <label>
              <Checkbox
                checked={persistent}
                onChange={(e) => setPersistent(e.target.checked)}
              />
              我已确认标签保存在实际部署配置中，重建时继续携带
            </label>
          </section>
        )}
        {preview && (
          <section aria-live="polite">
            <h2>匹配预览</h2>
            <p>
              {locatorText(preview.locator)} ·{" "}
              <Status value={preview.identification} /> ·{" "}
              {preview.instances.length} 个候选
            </p>
            {preview.instances.map((c) => (
              <p key={c.id}>
                {c.name} · <code>{c.id}</code>
              </p>
            ))}
            {preview.duplicates.map((d) => (
              <p key={d.id} role="alert">
                已登记同一逻辑资源：
                <Button variant="link" asChild>
                  <Link href={`/resources/${d.id}`}>{d.name}</Link>
                </Button>
                ，请直接关联该资源。
              </p>
            ))}
          </section>
        )}
      </form>
    </BusinessDialog>
  );
}
