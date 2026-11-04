"use client";
/**
 * @file remote-files.tsx
 * @project PipkerOps
 * @module remote-files-ui
 * @description 远程工作台的懒加载文件树和文件操作弹窗。
 * @logic 每个节点/容器保留独立树状态；读取通过持久任务完成；写入核对目标后执行，截断与二进制内容只读。
 * @dependencies React, remote file tasks, shared dialog UI, Lucide
 * @index_tags files, tree, container, workspace
 * @author holic512
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  ChevronRight,
  ChevronDown,
  File,
  FilePlus2,
  Folder,
  FolderPlus,
  Link2,
  RotateCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { date, type TaskData } from "@/lib/client";
import {
  remoteChild,
  remoteParent,
  remotePath,
  type FileAction,
  type FileTaskRunner,
  type RemoteDirectory,
  type RemoteFile,
  type RemoteTarget,
} from "@/lib/remote-files";
import { Button } from "./ui/button";
import { BusinessDialog } from "./ui/dialog";
import { Status, useOperation } from "./shared";

type DirectoryState = {
  data?: RemoteDirectory;
  loading?: boolean;
  error?: string;
  task?: TaskData;
};
type FileDialog = { action: Exclude<FileAction, "list">; path: string };

export function RemoteFiles({
  target,
  nodeName,
  visible,
  online,
  canWrite,
  canEnter,
  run,
  onEnter,
}: {
  target: RemoteTarget;
  nodeName: string;
  visible: boolean;
  online: boolean;
  canWrite: boolean;
  canEnter: boolean;
  run: FileTaskRunner;
  onEnter: (path: string) => void;
}) {
  const [root, setRoot] = useState("/");
  const [directory, setDirectory] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [selected, setSelected] = useState("/");
  const [focused, setFocused] = useState("/");
  const [expanded, setExpanded] = useState(new Set(["/"]));
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >({});
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const [message, setMessage] = useState("");
  const [lastTask, setLastTask] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const load = useCallback(
    async (path: string) => {
      if (!online) return;
      const signal = lifetime.current?.signal;
      setDirectories((previous) => ({
        ...previous,
        [path]: { ...previous[path], loading: true, error: undefined },
      }));
      try {
        const task = await run(
          target,
          "list",
          { path },
          {
            signal,
            onTask: (task) => {
              setLastTask(task.id);
              setDirectories((previous) => ({
                ...previous,
                [path]: { ...previous[path], task },
              }));
            },
          },
        );
        if (!signal?.aborted)
          setDirectories((previous) => ({
            ...previous,
            [path]: { data: task.result as RemoteDirectory, task },
          }));
      } catch (error) {
        if (!signal?.aborted)
          setDirectories((previous) => ({
            ...previous,
            [path]: {
              ...previous[path],
              loading: false,
              error: error instanceof Error ? error.message : "目录读取失败",
            },
          }));
      }
    },
    [online, run, target],
  );
  useEffect(() => {
    if (visible && online && !directories[root]) void load(root);
  }, [directories, load, online, root, visible]);

  const navigate = (value: string) => {
    try {
      const path = remotePath(value);
      setMessage("");
      setRoot(path);
      setDirectory(path);
      setSelected(path);
      setFocused(path);
      setPathInput(path);
      setExpanded((previous) => new Set(previous).add(path));
      void load(path);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const toggle = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!directories[path]?.data && !directories[path]?.loading)
      void load(path);
  };
  const select = (file: RemoteFile, path: string) => {
    setSelected(path);
    setFocused(path);
    if (file.symlink) return;
    if (file.directory) {
      setDirectory(path);
      setPathInput(path);
      toggle(path);
    } else if (online) setDialog({ action: "read", path });
    else setMessage("节点离线，恢复连接后可读取文件。");
  };
  const keyDown = (
    event: KeyboardEvent<HTMLLIElement>,
    file: RemoteFile,
    path: string,
  ) => {
    if (event.target !== event.currentTarget) return;
    const tree = event.currentTarget.closest('[role="tree"]')!;
    const rows = Array.from(
      tree.querySelectorAll<HTMLLIElement>('[role="treeitem"]'),
    );
    const index = rows.indexOf(event.currentTarget);
    const focus = (row?: HTMLLIElement) => row?.focus();
    switch (event.key) {
      case "ArrowDown":
        focus(rows[index + 1]);
        break;
      case "ArrowUp":
        focus(rows[index - 1]);
        break;
      case "Home":
        focus(rows[0]);
        break;
      case "End":
        focus(rows.at(-1));
        break;
      case "ArrowRight":
        if (file.directory && !file.symlink) {
          if (!expanded.has(path)) toggle(path);
          else focus(rows[index + 1]);
        }
        break;
      case "ArrowLeft":
        if (file.directory && expanded.has(path)) toggle(path);
        else focus(rows.find((row) => row.dataset.path === remoteParent(path)));
        break;
      case "Enter":
      case " ":
        select(file, path);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  const renderFile = (file: RemoteFile, path: string, level: number) => {
    const state = directories[path];
    const open = file.directory && expanded.has(path) && !file.symlink;
    return (
      <li
        key={path}
        role="treeitem"
        data-path={path}
        aria-label={`${file.symlink ? "符号链接" : file.directory ? "目录" : "文件"} ${path}`}
        aria-level={level}
        aria-expanded={file.directory && !file.symlink ? open : undefined}
        aria-selected={selected === path}
        aria-busy={!!state?.loading}
        tabIndex={focused === path ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocused(path);
        }}
        onKeyDown={(event) => keyDown(event, file, path)}
      >
        <div
          className={`file-tree-row ${selected === path ? "selected" : ""}`}
          style={{ paddingInlineStart: 10 + (level - 1) * 16 }}
          title={
            file.symlink
              ? `${path}（符号链接，文件接口不允许穿越）`
              : `${path}${file.modifiedAt ? `\n${file.mode} · ${file.size} 字节 · ${date(file.modifiedAt)}` : ""}`
          }
          onClick={(event) => {
            event.currentTarget.parentElement?.focus();
            select(file, path);
          }}
        >
          <span className="file-tree-chevron">
            {file.directory &&
              !file.symlink &&
              (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
          </span>
          {file.symlink ? (
            <Link2 size={15} />
          ) : file.directory ? (
            <Folder size={15} />
          ) : (
            <File size={15} />
          )}
          <span className="file-tree-name">{file.name}</span>
          {state?.loading && <span className="muted">读取中</span>}
        </div>
        {open && (
          <>
            {state?.error && (
              <div className="file-tree-feedback" role="alert">
                <p>{state.error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!online || state.loading}
                  onClick={() => void load(path)}
                >
                  重试目录
                </Button>
              </div>
            )}
            {state?.data && (
              <>
                {state.data.entries.length ? (
                  <ul role="group">
                    {[...state.data.entries]
                      .sort(
                        (a, b) =>
                          Number(b.directory) - Number(a.directory) ||
                          a.name.localeCompare(b.name, "zh-CN"),
                      )
                      .map((entry) =>
                        renderFile(
                          entry,
                          remoteChild(path, entry.name),
                          level + 1,
                        ),
                      )}
                  </ul>
                ) : (
                  <p className="file-tree-feedback muted">目录为空</p>
                )}
                {state.data.limited && (
                  <p className="file-tree-feedback" role="status">
                    仅显示前 1000 项，可输入完整目录路径继续访问。
                  </p>
                )}
              </>
            )}
          </>
        )}
      </li>
    );
  };
  return (
    <aside className="remote-files" hidden={!visible} aria-label="文件管理">
      <div className="remote-files-heading">
        <strong>文件目录</strong>
        <span title={target.containerId || "宿主机"}>
          {target.containerId ? "容器" : "宿主机"}
        </span>
      </div>
      <p
        className="remote-files-target"
        title={`${nodeName} / ${target.containerId || "宿主机"}`}
      >
        {nodeName} / {target.containerId || "宿主机"}
      </p>
      <form
        className="remote-path-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!online) return;
          navigate(pathInput);
        }}
      >
        <Input
          aria-label="绝对目录路径"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          required
          maxLength={4096}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!online}>
          转到
        </Button>
      </form>
      <div className="remote-file-actions">
        <Button
          variant="ghost"
          size="icon"
          aria-label="返回上级目录"
          disabled={!online || directory === "/"}
          onClick={() => navigate(remoteParent(directory))}
        >
          <ArrowUp size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新当前目录"
          disabled={!online || directories[directory]?.loading}
          onClick={() => void load(directory)}
        >
          <RotateCw size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="新建文本文件"
          disabled={!online || !canWrite}
          onClick={() =>
            setDialog({ action: "write", path: remoteChild(directory, "") })
          }
        >
          <FilePlus2 size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="新建目录"
          disabled={!online || !canWrite}
          onClick={() =>
            setDialog({ action: "mkdir", path: remoteChild(directory, "") })
          }
        >
          <FolderPlus size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="删除选中文件或目录"
          disabled={!online || !canWrite || selected === "/"}
          onClick={() => setDialog({ action: "remove", path: selected })}
        >
          <Trash2 size={15} />
        </Button>
      </div>
      {!online && (
        <p className="file-tree-feedback" role="status">
          节点离线或不可访问，恢复连接后可读取文件。
        </p>
      )}
      {message && (
        <p className="file-tree-feedback error-text" role="alert">
          {message}
        </p>
      )}
      <ul role="tree" aria-label="远程文件目录" className="remote-file-tree">
        {renderFile(
          {
            name: root === "/" ? "/" : root.slice(root.lastIndexOf("/") + 1),
            directory: true,
            symlink: false,
            size: 0,
            mode: "",
            modifiedAt: "",
          },
          root,
          1,
        )}
      </ul>
      <div className="remote-files-footer">
        <Button
          variant="outline"
          size="sm"
          disabled={!canEnter || !online}
          onClick={() => onEnter(directory)}
        >
          <SquareTerminal size={14} />
          在终端进入
        </Button>
        <small>
          {canEnter
            ? "填入 cd 命令后，回车执行。"
            : "连接当前目标的终端后可填入目录命令。"}
        </small>
        {lastTask && <Link href={`/tasks/${lastTask}`}>最近文件任务</Link>}
      </div>
      {dialog && (
        <RemoteFileDialog
          key={`${dialog.action}:${dialog.path}`}
          {...dialog}
          target={target}
          nodeName={nodeName}
          canWrite={canWrite && online}
          run={run}
          onClose={() => setDialog(null)}
          onDone={(path) => {
            setDialog(null);
            const parent = remoteParent(path);
            const nextDirectory =
              dialog.action === "remove" && path === directory
                ? parent
                : directory;
            setDirectory(nextDirectory);
            setPathInput(nextDirectory);
            setSelected(nextDirectory);
            setFocused(nextDirectory);
            if (dialog.action === "remove") {
              if (root === path) setRoot(parent);
              setDirectories((previous) =>
                Object.fromEntries(
                  Object.entries(previous).filter(
                    ([key]) => key !== path && !key.startsWith(`${path}/`),
                  ),
                ),
              );
            }
            void load(remoteParent(path));
          }}
        />
      )}
    </aside>
  );
}

function RemoteFileDialog({
  action,
  path: initialPath,
  target,
  nodeName,
  canWrite,
  run,
  onClose,
  onDone,
}: FileDialog & {
  target: RemoteTarget;
  nodeName: string;
  canWrite: boolean;
  run: FileTaskRunner;
  onClose: () => void;
  onDone: (path: string) => void;
}) {
  const formId = useId();
  const [path, setPath] = useState(initialPath);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(action === "write");
  const [loading, setLoading] = useState(action === "read");
  const [error, setError] = useState("");
  const [readResult, setReadResult] = useState<{
    truncated?: boolean;
    binary?: boolean;
  }>({});
  const [task, setTask] = useState<TaskData>();
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const op = useOperation(undefined, true);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if (action === "read") {
      void run(
        target,
        "read",
        { path: initialPath },
        { signal: controller.signal, onTask: setTask },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setContent(result.output ?? "");
          setReadResult(result.result);
          setLoading(false);
          setError("");
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setError(error.message);
            setLoading(false);
          }
        });
    }
    return () => controller.abort();
  }, [action, attempt, initialPath, run, target]);
  const readOnly = action === "read" && !editing;
  const blocked =
    loading ||
    !canWrite ||
    task?.status === "UNKNOWN" ||
    !!readResult.truncated ||
    !!readResult.binary ||
    (action === "read" && !!error);
  const title =
    action === "read"
      ? editing
        ? "编辑文件"
        : "文件内容"
      : action === "write"
        ? "新建文本文件"
        : action === "mkdir"
          ? "新建目录"
          : "删除文件或目录";
  return (
    <BusinessDialog
      title={title}
      description={`${nodeName} / ${target.containerId || "宿主机"}`}
      size={action === "read" || action === "write" ? "detail" : "form"}
      onClose={onClose}
      operation={op}
      formId={readOnly ? undefined : formId}
      disabled={blocked}
      submit={action === "remove" ? "确认删除" : "确认并保存"}
      footer={
        readOnly ? (
          <>
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
            <Button
              type="button"
              disabled={blocked}
              onClick={(event) => {
                event.preventDefault();
                setEditing(true);
              }}
            >
              编辑文件
            </Button>
          </>
        ) : undefined
      }
    >
      <form
        id={formId}
        className="form-panel remote-file-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (readOnly || blocked || op.busy) return;
          try {
            const normalized = remotePath(path);
            if (
              (action === "write" || action === "mkdir") &&
              path.endsWith("/")
            )
              throw new Error("请在目录路径后填写名称。");
            if (new TextEncoder().encode(content).length > 262144)
              throw new Error("文件内容不能超过 256 KiB。");
            setError("");
            const operation = action === "read" ? "write" : action;
            op.ask(
              `${action === "remove" ? "删除" : "保存"} ${normalized}？`,
              `节点：${nodeName}；目标：${target.containerId ? `容器 ${target.containerId}` : "宿主机"}；完整路径：${normalized}。${action === "remove" ? "删除不递归，非空目录将拒绝删除。" : "写入将更新目标文件或创建目录。"}`,
              async () => {
                await run(
                  target,
                  operation,
                  {
                    path: normalized,
                    ...(operation === "write" ? { content } : {}),
                  },
                  {
                    confirmed: true,
                    signal: lifetime.current?.signal,
                    onTask: setTask,
                  },
                );
                onDone(normalized);
              },
            );
          } catch (error) {
            setError((error as Error).message);
          }
        }}
      >
        <label>
          完整路径
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            readOnly={action === "read" || action === "remove"}
            required
            maxLength={4096}
          />
        </label>
        {loading && (
          <p aria-busy="true" role="status">
            正在读取文件…
          </p>
        )}
        {error && (
          <div role="alert">
            <p className="error-text">{error}</p>
            {action === "read" && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setLoading(true);
                  setError("");
                  setAttempt((value) => value + 1);
                }}
              >
                重试读取
              </Button>
            )}
          </div>
        )}
        {readResult.truncated && (
          <p role="status" className="inline-error">
            内容超过 256 KiB，仅展示部分内容，禁止编辑覆盖。
          </p>
        )}
        {readResult.binary && (
          <p role="status" className="inline-error">
            此文件不是完整 UTF-8 文本，不支持文本编辑。
          </p>
        )}
        {(action === "write" || action === "read") && !readResult.binary && (
          <label>
            文件内容
            <Textarea
              className="remote-file-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              readOnly={readOnly || blocked}
              spellCheck={false}
            />
          </label>
        )}
        {task && (
          <p className="muted">
            任务状态：
            <Status value={task.status} /> ·{" "}
            <Link href={`/tasks/${task.id}`}>查看任务详情</Link>
          </p>
        )}
      </form>
    </BusinessDialog>
  );
}
