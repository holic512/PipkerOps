/**
 * @file docker-manager.tsx
 * @project PipkerOps
 * @module docker-management-ui
 * @description 节点树与 Docker/Compose 资源表格、上下文操作及独立日志工作区。
 * @logic 选节点自动查询；行操作绑定准确资源，写入显式确认；关闭进度不取消 Agent 执行。
 * @dependencies React, SWR, node-tree, Docker RPC, shared tables and dialogs
 * @index_tags docker, compose, tree, realtime, operation-log, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Server,
  RotateCw,
  Plus,
  Download,
  ScrollText,
  PanelLeft,
} from "lucide-react";
import { rpc, date, type NodeData, type NodeFolderData } from "@/lib/client";
import { buildNodeTree, type FolderBranch } from "@/lib/node-tree";
import type {
  DockerContainer,
  ComposeProject,
  DockerOperation,
  DockerOperationSummary,
} from "@/lib/docker-contracts";
import {
  useQuery,
  useOperation,
  PageTitle,
  DataTable,
  Status,
  QueryState,
  ResourceForm,
} from "./shared";
import { BusinessDialog } from "./ui/dialog";
import { Button } from "./ui/button";

type Stats = { containers: Record<string, string | number>[] };
type Popup =
  | { kind: "inspect" | "logs" | "stats"; id: string; name: string }
  | {
      kind: "compose-status" | "compose-read" | "compose-edit";
      project: string;
    }
  | { kind: "compose-create" | "pull" | "history" }
  | { kind: "operation"; id: string };
type Start = (
  method: "docker.action" | "docker.pull" | "compose.deploy",
  params: Record<string, unknown>,
) => Promise<DockerOperation>;
const running = (status?: string) =>
  !!status && ["REQUESTED", "RUNNING", "UNKNOWN"].includes(status);
const actionNames: Record<string, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  remove: "删除",
};
const methodNames: Record<string, string> = {
  "docker.action": "容器操作",
  "docker.pull": "拉取镜像",
  "compose.deploy": "Compose 部署",
};

export function DockerManagement() {
  const search = useSearchParams();
  return (
    <DockerWorkspace
      key={search.toString()}
      requestedNode={search.get("node") ?? ""}
      target={search.get("target") ?? ""}
      action={search.get("action") ?? ""}
    />
  );
}

function DockerWorkspace({
  requestedNode,
  target,
  action,
}: {
  requestedNode: string;
  target: string;
  action: string;
}) {
  const nodes = useQuery<NodeData[]>("nodes.list");
  const folders = useQuery<NodeFolderData[]>("nodeFolders.list");
  const user = useQuery<{ role: string }>("users.me", {}, 0);
  const [selectedId, setSelectedId] = useState(requestedNode);
  const approved =
    nodes.data?.filter((node) => node.status === "APPROVED") ?? [];
  const nodeId =
    selectedId ||
    approved.find((node) => node.connected)?.id ||
    approved[0]?.id ||
    "";
  const node = approved.find((item) => item.id === nodeId);
  const online = !!node?.connected;
  const canWrite = online && !!user.data && user.data.role !== "VIEWER";
  const [filter, setFilter] = useState("");
  const [popup, setPopup] = useState<Popup | null>(() => {
    if (!target || !requestedNode) return null;
    if (
      action === "docker.inspect" ||
      action === "docker.logs" ||
      action === "docker.stats"
    )
      return {
        kind: action.slice(7) as "inspect" | "logs" | "stats",
        id: target,
        name: target,
      };
    if (["compose.read", "compose.status", "compose.deploy"].includes(action))
      return {
        kind:
          action === "compose.deploy"
            ? "compose-edit"
            : action === "compose.read"
              ? "compose-read"
              : "compose-status",
        project: target,
      };
    return null;
  });
  const containers = useQuery<{ containers: DockerContainer[] }>(
    online ? "docker.list" : null,
    { nodeId },
    5000,
  );
  const projects = useQuery<{ projects: ComposeProject[] }>(
    online ? "compose.list" : null,
    { nodeId },
    5000,
  );
  const stats = useQuery<Stats>(
    online ? "docker.stats" : null,
    { nodeId },
    5000,
  );
  const pending = useRef(new Map<string, string>());
  const refresh = () =>
    Promise.all([
      nodes.mutate(),
      containers.mutate(),
      projects.mutate(),
      stats.mutate(),
    ]);
  const op = useOperation();
  const start: Start = async (method, payload) => {
    const params = { nodeId, ...payload };
    const fingerprint = JSON.stringify({ method, params });
    const key = pending.current.get(fingerprint) ?? crypto.randomUUID();
    pending.current.set(fingerprint, key);
    let operation: DockerOperation;
    try {
      operation = await rpc<DockerOperation>(method, {
        ...params,
        idempotencyKey: key,
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "请求失败"}。如未收到明确反馈，请查看节点操作日志；使用原参数再次确认只会查询原操作。`,
      );
    }
    if (operation.status !== "UNKNOWN") pending.current.delete(fingerprint);
    setPopup({ kind: "operation", id: operation.id });
    return operation;
  };
  const choose = (id: string) => {
    setSelectedId(id);
    setPopup(null);
    setFilter("");
    op.clear();
  };
  const matches = (values: string[]) =>
    values
      .join(" ")
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase());
  const rows =
    containers.data?.containers.filter((item) =>
      matches([item.name, item.id, item.image, item.state]),
    ) ?? [];
  const composeRows =
    projects.data?.projects.filter((item) =>
      matches([item.name, item.status]),
    ) ?? [];
  const close = () => {
    setPopup(null);
    op.clear();
  };

  return (
    <>
      <PageTitle title="Docker / Compose">
        <Button
          variant="outline"
          disabled={!nodeId}
          onClick={() => setPopup({ kind: "history" })}
        >
          <ScrollText size={15} />
          操作日志
        </Button>
        <Button variant="outline" onClick={() => void refresh()}>
          <RotateCw size={15} />
          刷新
        </Button>
      </PageTitle>
      {op.ui}
      <div className="docker-workspace">
        <NodePicker
          nodes={approved}
          folders={folders.data ?? []}
          value={nodeId}
          onChange={choose}
          loading={nodes.isLoading || folders.isLoading}
          error={nodes.error || folders.error}
          retry={() => void Promise.all([nodes.mutate(), folders.mutate()])}
        />
        <div className="docker-resources">
          {!node ? (
            <QueryState
              loading={nodes.isLoading}
              error={nodes.error}
              empty
              retry={() => void nodes.mutate()}
              emptyTitle={
                requestedNode
                  ? "节点不存在或无权访问"
                  : "暂无可访问的已批准节点"
              }
              emptyText="请在节点管理中检查接入状态和授权范围，再选择节点。"
            >
              {null}
            </QueryState>
          ) : (
            <>
              <div className="docker-node-heading">
                <h2>{node.name}</h2>
                <Status value={online ? "online" : "offline"} />
                <span className="muted">{node.hostname || "未上报主机名"}</span>
              </div>
              {!online ? (
                <div role="alert" className="inline-error">
                  {node.connectionError ||
                    "节点离线，请恢复 Agent 连接后刷新。"}
                </div>
              ) : (
                <>
                  <div className="list-toolbar">
                    <input
                      aria-label="搜索容器或 Compose 项目"
                      placeholder="搜索名称、镜像或状态"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                    <span className="muted">每 5 秒刷新</span>
                    <div className="inline-actions">
                      <Button
                        variant="outline"
                        disabled={!canWrite}
                        onClick={() => setPopup({ kind: "pull" })}
                      >
                        <Download size={15} />
                        拉取镜像
                      </Button>
                      <Button
                        disabled={!canWrite}
                        onClick={() => setPopup({ kind: "compose-create" })}
                      >
                        <Plus size={15} />
                        新建 Compose
                      </Button>
                    </div>
                  </div>
                  <section className="panel" aria-label="容器管理">
                    <div className="panel-header">
                      <h2>
                        容器{" "}
                        <span className="muted">
                          {containers.data?.containers.length ?? "—"}
                        </span>
                      </h2>
                      <span className="muted">
                        {containers.data ? "直接读取 Agent" : "读取节点资源"}
                      </span>
                    </div>
                    {stats.error && (
                      <p className="inline-error" role="status">
                        统计暂不可用：{stats.error.message}
                        {stats.data ? "；显示上次采样" : ""}
                      </p>
                    )}
                    {containers.error && containers.data && (
                      <p className="inline-error" role="status">
                        容器刷新失败，显示上次读取的数据：
                        {containers.error.message}
                      </p>
                    )}
                    <QueryState
                      loading={containers.isLoading}
                      error={containers.data ? undefined : containers.error}
                      empty={!rows.length}
                      retry={() => void containers.mutate()}
                      emptyTitle={filter ? "没有匹配的容器" : "此节点暂无容器"}
                      emptyText={
                        filter
                          ? "请调整搜索条件。"
                          : "可以拉取镜像，或新建 Compose 部署应用。"
                      }
                    >
                      <DataTable
                        headers={[
                          "名称 / ID",
                          "镜像",
                          "状态",
                          "端口",
                          "CPU / 内存",
                          "操作",
                        ]}
                      >
                        {rows.map((item) => {
                          const metric = stats.data?.containers.find(
                            (row) =>
                              row.ID === item.id ||
                              row.Container === item.id ||
                              row.Name === item.name,
                          );
                          const isRunning = item.state === "running";
                          return (
                            <tr
                              key={item.id}
                              className={
                                target &&
                                nodeId === requestedNode &&
                                [item.id, item.name].includes(target)
                                  ? "docker-target-row"
                                  : undefined
                              }
                            >
                              <td>
                                <button
                                  className="entity-link docker-resource-link"
                                  onClick={() =>
                                    setPopup({
                                      kind: "inspect",
                                      id: item.id,
                                      name: item.name,
                                    })
                                  }
                                >
                                  {item.name}
                                </button>
                                <small title={item.id}>
                                  {item.id.slice(0, 12)}
                                </small>
                              </td>
                              <td className="docker-image">{item.image}</td>
                              <td>
                                <Status value={item.state} />
                                <small>{item.status}</small>
                              </td>
                              <td className="docker-ports">
                                {item.ports || "—"}
                              </td>
                              <td className="docker-metrics">
                                {metric ? (
                                  <>
                                    {metric.CPUPerc ?? "—"}
                                    <small>
                                      {metric.MemUsage ?? "暂无采样"}
                                    </small>
                                  </>
                                ) : (
                                  "暂无采样"
                                )}
                              </td>
                              <td>
                                <div className="inline-actions docker-row-actions">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      setPopup({
                                        kind: "logs",
                                        id: item.id,
                                        name: item.name,
                                      })
                                    }
                                  >
                                    日志
                                  </Button>
                                  {(isRunning
                                    ? ["stop", "restart"]
                                    : ["start"]
                                  ).map((command) => (
                                    <Button
                                      key={command}
                                      size="sm"
                                      variant="outline"
                                      disabled={!canWrite || op.busy}
                                      onClick={() =>
                                        op.ask(
                                          `${actionNames[command]}容器？`,
                                          `节点：${node.name}；容器：${item.name}（${item.id}）。确认后直接请求 Agent，执行过程写入操作日志。`,
                                          () =>
                                            start("docker.action", {
                                              id: item.id,
                                              action: command,
                                              confirmed: true,
                                            }),
                                          "已收到 Agent 反馈，请查看操作日志",
                                        )
                                      }
                                    >
                                      {actionNames[command]}
                                    </Button>
                                  ))}
                                  <details className="docker-row-menu">
                                    <summary>更多操作</summary>
                                    <div>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                          setPopup({
                                            kind: "inspect",
                                            id: item.id,
                                            name: item.name,
                                          })
                                        }
                                      >
                                        详情
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                          setPopup({
                                            kind: "stats",
                                            id: item.id,
                                            name: item.name,
                                          })
                                        }
                                      >
                                        监控
                                      </Button>
                                      {canWrite && isRunning ? (
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          asChild
                                        >
                                          <Link
                                            href={`/terminal?${new URLSearchParams({ node: nodeId, target: item.id })}`}
                                          >
                                            终端
                                          </Link>
                                        </Button>
                                      ) : (
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          disabled
                                        >
                                          终端
                                        </Button>
                                      )}
                                      <Button
                                        size="sm"
                                        variant="destructive"
                                        disabled={
                                          !canWrite || isRunning || op.busy
                                        }
                                        onClick={() =>
                                          op.ask(
                                            "删除容器？",
                                            `节点：${node.name}；容器：${item.name}（${item.id}）。删除后无法恢复容器；挂载卷保留。运行中的容器请先停止。`,
                                            () =>
                                              start("docker.action", {
                                                id: item.id,
                                                action: "remove",
                                                confirmed: true,
                                              }),
                                            "已收到 Agent 反馈，请查看操作日志",
                                          )
                                        }
                                      >
                                        删除
                                      </Button>
                                    </div>
                                  </details>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </DataTable>
                    </QueryState>
                  </section>
                  <section className="panel" aria-label="Compose 项目管理">
                    <div className="panel-header">
                      <h2>
                        Compose 项目{" "}
                        <span className="muted">
                          {projects.data?.projects.length ?? "—"}
                        </span>
                      </h2>
                      <span className="muted">
                        平台受管项目支持配置编辑和部署更新
                      </span>
                    </div>
                    {projects.error && projects.data && (
                      <p className="inline-error" role="status">
                        项目刷新失败，显示上次读取的数据：
                        {projects.error.message}
                      </p>
                    )}
                    <QueryState
                      loading={projects.isLoading}
                      error={projects.data ? undefined : projects.error}
                      empty={!composeRows.length}
                      retry={() => void projects.mutate()}
                      emptyTitle={
                        filter
                          ? "没有匹配的 Compose 项目"
                          : "此节点暂无 Compose 项目"
                      }
                      emptyText={
                        filter
                          ? "请调整搜索条件。"
                          : "点击“新建 Compose”，填写配置并确认部署。"
                      }
                    >
                      <DataTable headers={["项目", "状态", "管理方式", "操作"]}>
                        {composeRows.map((project) => (
                          <tr
                            key={project.name}
                            className={
                              project.name === target &&
                              nodeId === requestedNode
                                ? "docker-target-row"
                                : undefined
                            }
                          >
                            <td>
                              <button
                                className="entity-link docker-resource-link"
                                onClick={() =>
                                  setPopup({
                                    kind: "compose-status",
                                    project: project.name,
                                  })
                                }
                              >
                                {project.name}
                              </button>
                            </td>
                            <td>
                              {project.status === "not deployed"
                                ? "尚未部署"
                                : project.status}
                            </td>
                            <td>{project.managed ? "平台受管" : "外部项目"}</td>
                            <td>
                              <div className="inline-actions">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    setPopup({
                                      kind: "compose-status",
                                      project: project.name,
                                    })
                                  }
                                >
                                  服务状态
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!project.managed}
                                  title={
                                    !project.managed
                                      ? "外部项目未保存平台配置"
                                      : undefined
                                  }
                                  onClick={() =>
                                    setPopup({
                                      kind: "compose-read",
                                      project: project.name,
                                    })
                                  }
                                >
                                  配置
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!canWrite || !project.managed}
                                  onClick={() =>
                                    setPopup({
                                      kind: "compose-edit",
                                      project: project.name,
                                    })
                                  }
                                >
                                  部署更新
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </DataTable>
                    </QueryState>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {popup &&
        nodeId &&
        (popup.kind === "inspect" ||
          popup.kind === "logs" ||
          popup.kind === "stats") && (
          <ContainerDialog
            key={`${nodeId}:${popup.kind}:${popup.id}`}
            popup={{
              ...popup,
              name:
                containers.data?.containers.find(
                  (item) => item.id === popup.id || item.name === popup.id,
                )?.name ?? popup.name,
            }}
            nodeId={nodeId}
            onClose={close}
          />
        )}
      {popup &&
        nodeId &&
        [
          "compose-read",
          "compose-status",
          "compose-edit",
          "compose-create",
        ].includes(popup.kind) && (
          <ComposeDialog
            key={`${nodeId}:${popup.kind}:${"project" in popup ? popup.project : ""}`}
            popup={popup}
            nodeId={nodeId}
            nodeName={node?.name ?? nodeId}
            canWrite={canWrite}
            start={start}
            onClose={close}
          />
        )}
      {popup?.kind === "pull" && (
        <PullDialog
          nodeName={node?.name ?? nodeId}
          start={start}
          canWrite={canWrite}
          onClose={close}
        />
      )}
      {popup?.kind === "history" && (
        <OperationHistory
          nodeId={nodeId}
          onClose={close}
          onSelect={(id) => setPopup({ kind: "operation", id })}
        />
      )}
      {popup?.kind === "operation" && (
        <OperationDialog
          key={popup.id}
          id={popup.id}
          onCompleted={() => void refresh()}
          onClose={close}
          onStatus={(project) => setPopup({ kind: "compose-status", project })}
        />
      )}
    </>
  );
}

function NodePicker({
  nodes,
  folders,
  value,
  onChange,
  loading,
  error,
  retry,
}: {
  nodes: NodeData[];
  folders: NodeFolderData[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
  error?: Error;
  retry: () => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [mobileOpen, setMobileOpen] = useState(false);
  const tree = buildNodeTree(nodes, folders, query);
  const renderNode = (node: NodeData) => (
    <li key={node.id}>
      <button
        className={`docker-picker-node${value === node.id ? " active" : ""}`}
        aria-current={value === node.id ? "true" : undefined}
        onClick={() => {
          onChange(node.id);
          setMobileOpen(false);
        }}
      >
        <Server size={15} />
        <span>
          {node.name}
          <small>{node.connected ? "在线" : "离线"}</small>
        </span>
      </button>
    </li>
  );
  const renderFolder = (branch: FolderBranch<NodeData>): ReactNode => {
    const expanded = tree.searching || !collapsed.has(branch.folder.id);
    return (
      <li key={branch.folder.id}>
        <button
          className="docker-picker-folder"
          aria-expanded={expanded}
          onClick={() =>
            setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(branch.folder.id)) next.delete(branch.folder.id);
              else next.add(branch.folder.id);
              return next;
            })
          }
        >
          <ChevronRight
            size={14}
            className={expanded ? "node-chevron-open" : ""}
          />
          {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          <span>{branch.folder.name}</span>
          <small>{branch.total}</small>
        </button>
        {expanded && (
          <ul>
            {branch.children.map(renderFolder)}
            {branch.nodes.map(renderNode)}
          </ul>
        )}
      </li>
    );
  };
  return (
    <aside className="docker-node-picker panel" aria-label="节点选择">
      <button
        className="docker-picker-toggle"
        aria-expanded={mobileOpen}
        aria-controls="docker-picker-body"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        <PanelLeft size={16} />
        节点选择
        <span>
          {nodes.find((node) => node.id === value)?.name ?? "请选择节点"}
        </span>
      </button>
      <div
        id="docker-picker-body"
        className={`docker-picker-body${mobileOpen ? " is-open" : ""}`}
      >
        <div className="panel-header">
          <h2>节点选择</h2>
        </div>
        <label className="docker-picker-search">
          <span className="sr-only">搜索节点或文件夹</span>
          <input
            placeholder="搜索节点或文件夹"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <QueryState
          loading={loading}
          error={error}
          empty={!tree.folders.length && !tree.nodes.length}
          retry={retry}
          emptyTitle="没有匹配的节点"
          emptyText="请调整搜索或检查节点接入状态。"
        >
          <nav aria-label="Docker 节点选择">
            <ul>
              {tree.folders.map(renderFolder)}
              {tree.nodes.map(renderNode)}
            </ul>
          </nav>
        </QueryState>
      </div>
    </aside>
  );
}

function ContainerDialog({
  popup,
  nodeId,
  onClose,
}: {
  popup: Extract<Popup, { id: string; name: string }>;
  nodeId: string;
  onClose: () => void;
}) {
  const [tail, setTail] = useState(200);
  const query = useQuery<{
    containers?: Record<string, unknown>[];
    output?: string;
    truncated?: boolean;
  }>(
    `docker.${popup.kind}`,
    { nodeId, id: popup.id, ...(popup.kind === "logs" ? { tail } : {}) },
    popup.kind === "inspect" ? 0 : 5000,
  );
  const item = query.data?.containers?.[0];
  const state = (item?.State ?? {}) as Record<string, unknown>;
  const mounts = (item?.Mounts ?? []) as Record<string, unknown>[];
  const ports = (item?.Ports ?? {}) as Record<
    string,
    { HostIp: string; HostPort: string }[] | null
  >;
  return (
    <BusinessDialog
      title={`${popup.name} · ${{ inspect: "容器详情", logs: "容器日志", stats: "容器监控" }[popup.kind]}`}
      size="detail"
      readOnly
      onClose={onClose}
    >
      <div className="list-toolbar">
        <code>{popup.id}</code>
        <Button variant="outline" size="sm" onClick={() => void query.mutate()}>
          刷新
        </Button>
        {popup.kind === "logs" && (
          <label>
            日志行数{" "}
            <select
              value={tail}
              onChange={(event) => setTail(Number(event.target.value))}
            >
              {[100, 200, 500, 1000, 2000].map((count) => (
                <option key={count}>{count}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        retry={() => void query.mutate()}
      >
        {popup.kind === "logs" ? (
          <>
            <pre className="terminal-output">
              {query.data?.output || "容器尚无日志输出。"}
            </pre>
            {query.data?.truncated && (
              <p className="inline-error">输出达到大小上限，已截断。</p>
            )}
          </>
        ) : popup.kind === "stats" ? (
          <QueryState
            loading={false}
            empty={!query.data?.containers?.length}
            retry={() => void query.mutate()}
            emptyTitle="暂无容器运行统计"
            emptyText="请确认容器正在运行。"
          >
            <DataTable
              headers={[
                "CPU",
                "内存用量",
                "内存占比",
                "网络 I/O",
                "磁盘 I/O",
                "进程数",
              ]}
            >
              {query.data?.containers?.map((row, index) => (
                <tr key={index}>
                  {[
                    "CPUPerc",
                    "MemUsage",
                    "MemPerc",
                    "NetIO",
                    "BlockIO",
                    "PIDs",
                  ].map((key) => (
                    <td key={key}>{String(row[key] ?? "暂无采样")}</td>
                  ))}
                </tr>
              ))}
            </DataTable>
          </QueryState>
        ) : (
          item && (
            <>
              <dl className="docker-detail-fields">
                {Object.entries({
                  名称: item.Name,
                  镜像: item.Image,
                  创建时间: item.Created,
                  状态: state.Status,
                  启动时间: state.StartedAt,
                  退出时间: state.FinishedAt,
                  退出码: state.ExitCode,
                  重启次数: item.RestartCount,
                }).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value ?? "—")}</dd>
                  </div>
                ))}
              </dl>
              {state.Error ? (
                <p className="inline-error">{String(state.Error)}</p>
              ) : null}
              <h3>端口映射</h3>
              <DataTable headers={["容器端口", "主机地址", "主机端口"]}>
                {Object.entries(ports).flatMap(([port, bindings]) =>
                  (bindings?.length
                    ? bindings
                    : [{ HostIp: "—", HostPort: "未发布" }]
                  ).map((binding, index) => (
                    <tr key={`${port}:${index}`}>
                      <td>{port}</td>
                      <td>{binding.HostIp}</td>
                      <td>{binding.HostPort}</td>
                    </tr>
                  )),
                )}
              </DataTable>
              <h3>挂载</h3>
              <DataTable headers={["类型", "源路径", "容器路径", "读写"]}>
                {mounts.map((mount, index) => (
                  <tr key={index}>
                    <td>{String(mount.Type ?? "—")}</td>
                    <td>{String(mount.Source ?? "—")}</td>
                    <td>{String(mount.Destination ?? "—")}</td>
                    <td>{mount.RW ? "读写" : "只读"}</td>
                  </tr>
                ))}
              </DataTable>
            </>
          )
        )}
      </QueryState>
    </BusinessDialog>
  );
}

function ComposeDialog({
  popup,
  nodeId,
  nodeName,
  canWrite,
  start,
  onClose,
}: {
  popup: Popup;
  nodeId: string;
  nodeName: string;
  canWrite: boolean;
  start: Start;
  onClose: () => void;
}) {
  const project = "project" in popup ? popup.project : "";
  const status = popup.kind === "compose-status";
  const creating = popup.kind === "compose-create";
  const editing = creating || popup.kind === "compose-edit";
  const query = useQuery<{
    yaml?: string;
    services?: Record<string, unknown>[];
  }>(
    creating ? null : status ? "compose.status" : "compose.read",
    { nodeId, project },
    status ? 5000 : 0,
  );
  const op = useOperation(undefined, true);
  return (
    <BusinessDialog
      title={
        creating
          ? "新建 Compose"
          : `${project} · ${status ? "服务状态" : editing ? "部署更新" : "Compose 配置"}`
      }
      description={`节点：${nodeName}${project ? `；项目：${project}` : ""}`}
      size="detail"
      onClose={onClose}
      operation={op}
      formId={editing ? "docker-compose-form" : undefined}
      submit="部署"
      disabled={!canWrite || (!creating && !query.data?.yaml)}
      readOnly={!editing}
    >
      <QueryState
        loading={!creating && query.isLoading}
        error={query.error}
        retry={() => void query.mutate()}
      >
        {status ? (
          <QueryState
            loading={false}
            empty={!query.data?.services?.length}
            retry={() => void query.mutate()}
            emptyTitle="项目暂无运行资源"
            emptyText="如上一次部署失败，请查看操作日志和保存的配置，再显式修正部署。"
          >
            <DataTable headers={["服务", "容器", "镜像", "状态", "健康"]}>
              {query.data?.services?.map((service, index) => (
                <tr key={index}>
                  {["Service", "Name", "Image", "State", "Health"].map(
                    (key) => (
                      <td key={key}>{String(service[key] || "—")}</td>
                    ),
                  )}
                </tr>
              ))}
            </DataTable>
          </QueryState>
        ) : editing ? (
          <ResourceForm
            id="docker-compose-form"
            hideSubmit
            busy={op.busy}
            disabled={!canWrite}
            fields={[
              ...(creating
                ? [
                    {
                      name: "project",
                      label: "项目名",
                      required: true,
                      placeholder: "my-app",
                    },
                  ]
                : []),
              {
                name: "yaml",
                label: "Compose YAML",
                type: "textarea",
                required: true,
                defaultValue: query.data?.yaml ?? "",
                placeholder: "services:\n  web:\n    image: nginx:stable",
              },
            ]}
            onSubmit={async (data) => {
              const name = creating ? String(data.project) : project;
              op.ask(
                "确认部署 Compose？",
                `节点：${nodeName}；项目：${name}。将校验并保存配置，然后更新运行资源；失败时运行资源可能已部分改变，请查看状态与日志。`,
                () =>
                  start("compose.deploy", {
                    project: name,
                    yaml: data.yaml,
                    confirmed: true,
                  }),
                "已收到 Agent 反馈",
              );
            }}
          />
        ) : (
          <label className="docker-yaml">
            Compose YAML
            <textarea readOnly rows={18} value={query.data?.yaml ?? ""} />
          </label>
        )}
      </QueryState>
    </BusinessDialog>
  );
}

function PullDialog({
  nodeName,
  start,
  canWrite,
  onClose,
}: {
  nodeName: string;
  start: Start;
  canWrite: boolean;
  onClose: () => void;
}) {
  const op = useOperation(undefined, true);
  return (
    <BusinessDialog
      title="拉取镜像"
      description={`节点：${nodeName}。离开页面后 Agent 继续执行，可在操作日志中查看结果。`}
      operation={op}
      formId="docker-pull-form"
      submit="拉取"
      disabled={!canWrite}
      onClose={onClose}
    >
      <ResourceForm
        id="docker-pull-form"
        hideSubmit
        busy={op.busy}
        disabled={!canWrite}
        fields={[
          {
            name: "image",
            label: "镜像名称与标签",
            placeholder: "nginx:stable",
            required: true,
          },
        ]}
        onSubmit={async (data) => {
          await op.run(() => start("docker.pull", data), "已收到 Agent 反馈");
        }}
      />
    </BusinessDialog>
  );
}

function OperationHistory({
  nodeId,
  onClose,
  onSelect,
}: {
  nodeId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const query = useQuery<DockerOperationSummary[]>(
    "docker.operations.list",
    { nodeId },
    5000,
  );
  return (
    <BusinessDialog
      title="Docker 操作日志"
      description="最近 50 次直接操作；后台计划仍在执行任务中查看。"
      size="detail"
      readOnly
      onClose={onClose}
    >
      <QueryState
        loading={query.isLoading}
        error={query.error}
        empty={!query.data?.length}
        retry={() => void query.mutate()}
        emptyTitle="暂无 Docker 操作日志"
        emptyText="在资源表格执行操作后，这里会保存执行过程和结果。"
      >
        <DataTable
          headers={["操作类型", "目标", "状态", "来源", "时间", "查看"]}
        >
          {query.data?.map((operation) => (
            <tr key={operation.id}>
              <td>
                {operation.action
                  ? `${actionNames[operation.action]}容器`
                  : methodNames[operation.method]}
              </td>
              <td>{operation.target}</td>
              <td>
                <Status value={operation.status} />
              </td>
              <td>{operation.source}</td>
              <td>{date(operation.createdAt)}</td>
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onSelect(operation.id)}
                >
                  查看日志
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      </QueryState>
    </BusinessDialog>
  );
}

function OperationDialog({
  id,
  onClose,
  onStatus,
  onCompleted,
}: {
  id: string;
  onClose: () => void;
  onStatus: (project: string) => void;
  onCompleted: () => void;
}) {
  const completed = useRef(false);
  const query = useSWR<DockerOperation & { connectionError?: string }>(
    ["docker.operations.get", id],
    () => rpc("docker.operations.get", { id }),
    {
      refreshInterval: (data) => (running(data?.status) ? 1000 : 0),
      revalidateOnFocus: false,
      onSuccess: (data) => {
        if (
          !completed.current &&
          ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(data.status)
        ) {
          completed.current = true;
          onCompleted();
        }
      },
    },
  );
  const operation = query.data;
  return (
    <BusinessDialog
      title="Docker 操作日志"
      description={id}
      size="detail"
      readOnly
      onClose={onClose}
    >
      <QueryState
        loading={query.isLoading}
        error={query.error}
        retry={() => void query.mutate()}
      >
        {operation && (
          <>
            <div className="node-summary">
              <Status value={operation.status} />
              <span>
                {operation.action
                  ? `${actionNames[operation.action]}容器`
                  : methodNames[operation.method]}{" "}
                · {operation.target}
              </span>
              <span>开始 {date(operation.startedAt)}</span>
              <span>完成 {date(operation.finishedAt)}</span>
            </div>
            {operation.connectionError && (
              <p className="inline-error" role="alert">
                {operation.connectionError}
                。已保留收到的日志，请恢复连接后刷新。
              </p>
            )}
            {operation.error && (
              <p className="inline-error" role="alert">
                {operation.error}
              </p>
            )}
            {operation.status === "UNKNOWN" && (
              <p className="inline-error">
                执行结果待确认。请检查实际资源状态，不要重新发起同一操作。
              </p>
            )}
            {operation.method === "compose.deploy" &&
              operation.result.configurationSaved === true &&
              operation.status !== "SUCCEEDED" && (
                <p className="inline-error">
                  配置已保存，部署未完成，运行资源可能已部分改变。
                  <Button
                    variant="ghost"
                    onClick={() => onStatus(operation.target)}
                  >
                    查看项目状态
                  </Button>
                </p>
              )}
            <pre className="terminal-output">
              {operation.logs.length
                ? operation.logs
                    .map((entry) => `[${entry.stream}] ${entry.message}`)
                    .join("")
                : operation.output ||
                  (running(operation.status)
                    ? "等待 Agent 执行反馈…关闭此窗口不会取消操作。"
                    : operation.status === "SUCCEEDED"
                      ? "操作成功，未返回文本输出。"
                      : "未返回文本输出，请查看错误信息。")}
            </pre>
            {operation.truncated && (
              <p className="inline-error">输出达到大小上限，已截断。</p>
            )}
            <Button variant="outline" onClick={() => void query.mutate()}>
              刷新日志
            </Button>
          </>
        )}
      </QueryState>
    </BusinessDialog>
  );
}
