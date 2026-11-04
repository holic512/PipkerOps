"use client";
/**
 * @file remote-workspace.tsx
 * @project PipkerOps
 * @module remote-workspace
 * @description 共用节点和容器上下文的文件树、PTY多会话工作台。
 * @logic 选目标激活匹配会话，聚焦会话同步文件树；文件树按目标保留；跨页面保持连接，目录命令只粘贴。
 * @dependencies React, Next.js navigation, RPC, RemoteFiles, TerminalSession
 * @index_tags workspace, terminal, files, container
 * @author holic512
 */
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import {
  Columns2,
  FolderTree,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { rpc, type NodeData } from "@/lib/client";
import {
  createFileTaskRunner,
  remoteTargetKey,
  terminalDirectoryCommand,
  type RemoteTarget,
} from "@/lib/remote-files";
import { PageTitle, QueryState, useOperation, useQuery } from "./shared";
import { Button } from "./ui/button";
import { RemoteFiles } from "./remote-files";
import {
  TerminalSession,
  type TerminalHandle,
  type TerminalState,
} from "./terminal-session";

type Session = RemoteTarget & { id: string; name: string; url: string };

export function RemoteWorkspace({ visible }: { visible: boolean }) {
  const q = useQuery<NodeData[]>("nodes.list");
  const user = useQuery<{ role: string }>("users.me", {}, 0);
  const search = useSearchParams();
  const router = useRouter();
  const requested = {
    nodeId: search.get("node") ?? "",
    containerId: search.get("target") ?? "",
  };
  const requestKey = remoteTargetKey(requested);
  const [lastRequest, setLastRequest] = useState({ key: requestKey, visible });
  const [target, setTarget] = useState<RemoteTarget>(requested);
  const [targets, setTargets] = useState<RemoteTarget[]>(
    requested.nodeId ? [requested] : [],
  );
  const [containerInput, setContainerInput] = useState(requested.containerId);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState("");
  const [states, setStates] = useState<Record<string, TerminalState>>({});
  const [split, setSplit] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [mobilePane, setMobilePane] = useState<"files" | "terminal">(
    "terminal",
  );
  const [runFileTask] = useState(() => createFileTaskRunner());
  const handles = useRef(new Map<string, TerminalHandle>());
  const op = useOperation();
  const key = remoteTargetKey(target);
  if (
    lastRequest.visible !== visible ||
    (visible && lastRequest.key !== requestKey)
  ) {
    setLastRequest({ key: visible ? requestKey : lastRequest.key, visible });
    if (
      visible &&
      (search.has("node") || search.has("target")) &&
      requestKey !== key
    ) {
      setTarget(requested);
      setContainerInput(requested.containerId);
      setActive(
        sessions.find((session) => remoteTargetKey(session) === requestKey)
          ?.id ?? "",
      );
      if (
        requested.nodeId &&
        !targets.some((item) => remoteTargetKey(item) === requestKey)
      )
        setTargets([...targets, requested]);
    }
  }
  const selectedNode = q.data?.find(
    (node) => node.id === target.nodeId && node.status === "APPROVED",
  );
  const canWrite =
    user.data?.role === "ADMIN" || user.data?.role === "OPERATOR";
  const activeSession = sessions.find((session) => session.id === active);
  const canEnter =
    !!activeSession &&
    remoteTargetKey(activeSession) === key &&
    states[active] === "connected";
  const onStateChange = useCallback((id: string, state: TerminalState) => {
    setStates((previous) =>
      previous[id] === state ? previous : { ...previous, [id]: state },
    );
  }, []);
  const selectTarget = (next: RemoteTarget, sessionId?: string) => {
    const nextKey = remoteTargetKey(next);
    setTarget(next);
    setContainerInput(next.containerId);
    setActive(
      sessionId ??
        sessions.find((session) => remoteTargetKey(session) === nextKey)?.id ??
        "",
    );
    if (
      next.nodeId &&
      !targets.some((item) => remoteTargetKey(item) === nextKey)
    )
      setTargets([...targets, next]);
    op.clear();
    if (visible && nextKey !== key) {
      const params = new URLSearchParams(search.toString());
      if (next.nodeId) params.set("node", next.nodeId);
      else params.delete("node");
      if (next.containerId) params.set("target", next.containerId);
      else params.delete("target");
      router.replace(`/terminal${params.size ? `?${params}` : ""}`, {
        scroll: false,
      });
    }
  };
  const activate = (session: Session) =>
    selectTarget(
      { nodeId: session.nodeId, containerId: session.containerId },
      session.id,
    );
  return (
    <>
      <PageTitle title="远程工作台">
        <Button
          className="remote-files-toggle"
          variant="outline"
          aria-expanded={!filesCollapsed}
          onClick={() => setFilesCollapsed(!filesCollapsed)}
        >
          {filesCollapsed ? (
            <PanelLeftOpen size={15} />
          ) : (
            <PanelLeftClose size={15} />
          )}
          {filesCollapsed ? "显示文件" : "收起文件"}
        </Button>
        <Button
          variant="outline"
          aria-pressed={split}
          onClick={() => setSplit(!split)}
        >
          <Columns2 size={15} />
          {split ? "取消分屏" : "终端分屏"}
        </Button>
      </PageTitle>
      {op.ui}
      <section className="panel remote-workspace">
        <div className="remote-workspace-toolbar">
          <label>
            节点
            <NativeSelect
              aria-label="工作台节点"
              value={target.nodeId}
              onChange={(event) =>
                selectTarget({ nodeId: event.target.value, containerId: "" })
              }
            >
              <option value="">选择节点</option>
              {q.data
                ?.filter((node) => node.status === "APPROVED")
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                    {node.connected ? "" : "（离线）"}
                  </option>
                ))}
            </NativeSelect>
          </label>
          <form
            className="remote-target-form"
            onSubmit={(event) => {
              event.preventDefault();
              selectTarget({
                nodeId: target.nodeId,
                containerId: containerInput.trim(),
              });
            }}
          >
            <label>
              目标
              <Input
                aria-label="容器名称或 ID（留空为宿主机）"
                placeholder="容器名称或 ID，留空为宿主机"
                value={containerInput}
                onChange={(event) => setContainerInput(event.target.value)}
                pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"
                maxLength={128}
              />
            </label>
            <Button
              type="submit"
              variant="outline"
              disabled={!target.nodeId || containerInput === target.containerId}
            >
              切换目标
            </Button>
          </form>
          <Button
            disabled={
              !selectedNode?.connected ||
              !canWrite ||
              op.busy ||
              sessions.length >= 6 ||
              containerInput !== target.containerId
            }
            onClick={() => {
              const current = {
                nodeId: target.nodeId,
                containerId: target.containerId,
              };
              const name = `${selectedNode?.name ?? target.nodeId}${target.containerId ? ` / ${target.containerId}` : " / 宿主机"}`;
              op.ask(
                "打开远程终端？",
                `节点：${selectedNode?.name}；目标：${target.containerId ? `容器 ${target.containerId}` : "宿主机 Shell"}。将启动交互式 Shell，会话建立和结束均被审计。`,
                async () => {
                  const ticket = await rpc<{ path: string }>(
                    "terminal.ticket",
                    {
                      nodeId: current.nodeId,
                      containerId: current.containerId || undefined,
                      ...(search.get("resourceId") &&
                      current.nodeId === requested.nodeId &&
                      current.containerId === requested.containerId
                        ? { resourceId: search.get("resourceId") }
                        : {}),
                      confirmed: true,
                    },
                  );
                  const id = crypto.randomUUID();
                  setSessions((previous) => [
                    ...previous,
                    {
                      ...current,
                      id,
                      name,
                      url: new URL(
                        ticket.path,
                        window.location.origin.replace(/^http/, "ws"),
                      ).href,
                    },
                  ]);
                  setActive(id);
                  setMobilePane("terminal");
                  return ticket;
                },
                "终端会话已创建，请查看连接状态",
              );
            }}
          >
            <Plus size={14} />
            新建会话
          </Button>
          <span className="muted remote-session-count">
            {sessions.length} / 6 个会话
          </span>
        </div>
        {q.error && (
          <QueryState
            error={q.error}
            loading={false}
            retry={() => void q.mutate()}
          >
            {null}
          </QueryState>
        )}
        {q.isLoading && (
          <p className="remote-workspace-notice" role="status" aria-busy="true">
            正在加载节点…
          </p>
        )}
        {target.nodeId &&
          !q.isLoading &&
          !q.error &&
          !selectedNode?.connected && (
            <p className="remote-workspace-notice error-text" role="alert">
              {selectedNode
                ? "节点离线，恢复连接后可读取文件和新建会话。"
                : "节点不存在或无权访问，请重新选择节点。"}
            </p>
          )}
        <div
          className="remote-mobile-switch"
          role="group"
          aria-label="切换工作区视图"
        >
          <Button
            variant={mobilePane === "files" ? "default" : "ghost"}
            aria-pressed={mobilePane === "files"}
            onClick={() => setMobilePane("files")}
          >
            <FolderTree size={15} />
            文件
          </Button>
          <Button
            variant={mobilePane === "terminal" ? "default" : "ghost"}
            aria-pressed={mobilePane === "terminal"}
            onClick={() => setMobilePane("terminal")}
          >
            <SquareTerminal size={15} />
            终端
          </Button>
        </div>
        <div
          className={`remote-workspace-body ${filesCollapsed ? "files-collapsed" : ""} mobile-${mobilePane}`}
        >
          <div className="remote-files-area">
            {!target.nodeId && (
              <div className="empty-state">
                <FolderTree size={26} />
                <h2>选择文件目标</h2>
                <p>选择节点，可浏览宿主机或容器文件。</p>
              </div>
            )}
            {targets.map((item) => (
              <RemoteFiles
                key={remoteTargetKey(item)}
                target={item}
                nodeName={
                  q.data?.find((node) => node.id === item.nodeId)?.name ??
                  item.nodeId
                }
                visible={key === remoteTargetKey(item)}
                online={
                  !!q.data?.some(
                    (node) =>
                      node.id === item.nodeId &&
                      node.status === "APPROVED" &&
                      node.connected,
                  )
                }
                canWrite={canWrite}
                canEnter={canEnter && key === remoteTargetKey(item)}
                run={runFileTask}
                onEnter={(path) =>
                  void op.run(async () => {
                    const command = terminalDirectoryCommand(path);
                    setMobilePane("terminal");
                    await new Promise<void>((resolve) =>
                      requestAnimationFrame(() => {
                        handles.current.get(active)?.paste(command);
                        resolve();
                      }),
                    );
                  }, "已填入目录命令，请在终端按回车执行。")
                }
              />
            ))}
          </div>
          <div className="remote-terminal" role="region" aria-label="远程终端">
            <div
              className="inner-tabs remote-session-tabs"
              aria-label="终端会话"
              role="group"
            >
              {sessions.map((session) => (
                <div key={session.id} className="terminal-tab">
                  <button
                    data-ui-native="持久终端会话选择支持分屏多面板，保留分组按钮语义"
                    className={active === session.id ? "active" : ""}
                    aria-pressed={active === session.id}
                    onClick={() => activate(session)}
                  >
                    {session.name}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`关闭${session.name}会话`}
                    onClick={() => {
                      const remaining = sessions.filter(
                        (item) => item.id !== session.id,
                      );
                      setSessions(remaining);
                      if (active === session.id) {
                        const next =
                          remaining.find(
                            (item) => remoteTargetKey(item) === key,
                          ) ?? remaining[0];
                        if (next) activate(next);
                        else setActive("");
                      }
                    }}
                  >
                    <X size={13} />
                  </Button>
                </div>
              ))}
            </div>
            {!activeSession && (
              <div className="empty-state">
                <SquareTerminal size={28} />
                <h2>
                  {target.nodeId ? "当前目标尚无终端会话" : "开始远程操作"}
                </h2>
                <p>
                  {target.nodeId
                    ? "文件管理可独立使用；确认新建会话后，在右侧打开远程 Shell。"
                    : "先选择已批准且在线的 Linux 节点。"}
                </p>
              </div>
            )}
            <div className={split ? "terminal-grid split" : "terminal-grid"}>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  hidden={!activeSession || (!split && active !== session.id)}
                  className={`terminal-pane ${active === session.id ? "current" : ""}`}
                  onFocusCapture={() => {
                    if (active !== session.id) activate(session);
                  }}
                  onPointerDown={() => {
                    if (active !== session.id) activate(session);
                  }}
                >
                  <div className="terminal-pane-title">
                    <SquareTerminal size={14} />
                    <span>{session.name}</span>
                    {active === session.id && (
                      <span className="terminal-current-label">
                        当前操作会话
                      </span>
                    )}
                  </div>
                  <TerminalSession
                    url={session.url}
                    sessionId={session.id}
                    onStateChange={onStateChange}
                    ref={(handle) => {
                      if (handle) handles.current.set(session.id, handle);
                      else handles.current.delete(session.id);
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
