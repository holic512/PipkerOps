/**
 * @file node-manager.tsx
 * @project PipkerOps
 * @module node-management-ui
 * @description 节点文件夹树表格、组合筛选、批量分类及原生拖拽工作区。
 * @logic 筛选保留祖先并临时展开；折叠不丢失选择，移动成功才刷新，结构与节点编辑复用业务弹窗。
 * @dependencies React, SWR, node-tree, node editor, shared RPC/UI
 * @index_tags nodes, folders, tree, drag, filters, ui
 * @author holic512
 */
"use client";
import { Fragment, useState, type DragEvent } from "react";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  MoveRight,
  Plus,
  RotateCw,
  Tag,
} from "lucide-react";
import { rpc, type NodeData, type NodeFolderData } from "@/lib/client";
import {
  buildNodeTree,
  folderAncestors,
  folderPath,
  type FolderBranch,
} from "@/lib/node-tree";
import { NodeCells, NodeIdentity } from "./nodes";
import { FolderSelect, NodeEditor, NodeImportDialog } from "./node-editor";
import { PageTitle, QueryState, useOperation, useQuery } from "./shared";
import { BusinessDialog } from "./ui/dialog";
import { Button } from "./ui/button";

type Editor =
  | { kind: "node"; node: NodeData }
  | { kind: "folder"; folder?: NodeFolderData; parentId: string | null }
  | { kind: "move"; nodeIds: string[] }
  | { kind: "import" };
type DragItem =
  | { kind: "nodes"; nodeIds: string[] }
  | { kind: "folder"; folder: NodeFolderData };

export function Nodes() {
  const nodes = useQuery<NodeData[]>("nodes.list");
  const folders = useQuery<NodeFolderData[]>("nodeFolders.list");
  const user = useQuery<{ role: string }>("users.me", {}, 0);
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selected, setSelected] = useState(new Set<string>());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const op = useOperation();
  const canWrite = !!user.data && user.data.role !== "VIEWER";
  const allNodes = nodes.data ?? [];
  const allFolders = folders.data ?? [];
  const tree = buildNodeTree(allNodes, allFolders, query, labels);
  const selectedNodes = tree.matched.filter((node) => selected.has(node.id));
  const suggestions = [
    ...new Set(allNodes.flatMap((node) => node.labels)),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const refresh = () => Promise.all([nodes.mutate(), folders.mutate()]);
  const openEditor = (value: Editor) => {
    op.clear();
    setEditor(value);
  };
  const saved = () => {
    setEditor(null);
    setSelected(new Set());
    void refresh();
  };
  const expandTarget = (folderId: string | null) =>
    setCollapsed(
      (previous) =>
        new Set(
          [...previous].filter(
            (id) => !folderAncestors(folderId, allFolders).has(id),
          ),
        ),
    );
  const startDrag = (event: DragEvent, item: DragItem) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-pipkerops-classification",
      item.kind,
    );
    setDrag(item);
    op.clear();
  };
  const acceptsDrop = (folderId: string | null) =>
    !!drag &&
    !op.busy &&
    (drag.kind === "nodes" ||
      !folderAncestors(folderId, allFolders).has(drag.folder.id));
  const dragOver = (event: DragEvent, folderId: string | null) => {
    if (!acceptsDrop(folderId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(folderId ?? "root");
  };
  const drop = async (event: DragEvent, folderId: string | null) => {
    event.preventDefault();
    if (!acceptsDrop(folderId) || !drag) return;
    const item = drag;
    setDrag(null);
    setDropTarget(null);
    const targetName = folderPath(folderId, allFolders) || "根目录";
    const result = await op.run(
      () =>
        item.kind === "nodes"
          ? rpc("nodes.move", { nodeIds: item.nodeIds, folderId })
          : rpc("nodeFolders.save", {
              id: item.folder.id,
              name: item.folder.name,
              parentId: folderId,
            }),
      `已移动到${targetName}`,
    );
    if (result) {
      expandTarget(folderId);
      setSelected(new Set());
      void refresh();
    }
  };
  const endDrag = () => {
    setDrag(null);
    setDropTarget(null);
  };
  const renderNode = (node: NodeData, depth: number) => (
    <tr
      key={node.id}
      data-node-id={node.id}
      className={selected.has(node.id) ? "node-selected" : undefined}
    >
      {canWrite && (
        <td className="node-check">
          <input
            type="checkbox"
            aria-label={`选择节点 ${node.name}`}
            checked={selected.has(node.id)}
            disabled={op.busy}
            onChange={(event) => {
              const checked = event.target.checked;
              setSelected((previous) => {
                const next = new Set(previous);
                if (checked) next.add(node.id);
                else next.delete(node.id);
                return next;
              });
            }}
          />
        </td>
      )}
      <td>
        <div
          className="node-tree-name"
          style={{ paddingInlineStart: depth * 22 }}
        >
          {canWrite && (
            <button
              type="button"
              className="node-drag-handle"
              draggable={!op.busy}
              disabled={op.busy}
              aria-label={`拖动节点 ${node.name}`}
              onDragStart={(event) =>
                startDrag(event, {
                  kind: "nodes",
                  nodeIds: selected.has(node.id)
                    ? selectedNodes.map((item) => item.id)
                    : [node.id],
                })
              }
              onDragEnd={endDrag}
            >
              <GripVertical size={15} />
            </button>
          )}
          <NodeIdentity node={node} />
        </div>
      </td>
      <NodeCells node={node}>
        {canWrite && (
          <Button
            variant="ghost"
            size="sm"
            disabled={op.busy}
            onClick={() => openEditor({ kind: "node", node })}
          >
            编辑
          </Button>
        )}
      </NodeCells>
    </tr>
  );
  const renderFolder = (
    branch: FolderBranch<NodeData>,
    depth: number,
  ): React.ReactNode => {
    const folder = allFolders.find((item) => item.id === branch.folder.id)!;
    const expanded = tree.searching || !collapsed.has(folder.id);
    return (
      <Fragment key={folder.id}>
        <tr
          data-folder-id={folder.id}
          className={`node-folder-row${dropTarget === folder.id ? " node-drop-active" : ""}`}
          onDragOver={(event) => dragOver(event, folder.id)}
          onDrop={(event) => void drop(event, folder.id)}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDropTarget(null);
          }}
        >
          {canWrite && <td className="node-check" />}
          <td colSpan={6}>
            <div
              className="node-tree-name"
              style={{ paddingInlineStart: depth * 22 }}
            >
              {canWrite && (
                <button
                  type="button"
                  className="node-drag-handle"
                  draggable={!op.busy}
                  disabled={op.busy}
                  aria-label={`拖动文件夹 ${branch.path}`}
                  onDragStart={(event) =>
                    startDrag(event, { kind: "folder", folder })
                  }
                  onDragEnd={endDrag}
                >
                  <GripVertical size={15} />
                </button>
              )}
              <button
                type="button"
                className="node-folder-toggle"
                aria-label={`${expanded ? "折叠" : "展开"}文件夹 ${branch.path}`}
                aria-expanded={expanded}
                disabled={tree.searching}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(folder.id)) next.delete(folder.id);
                    else next.add(folder.id);
                    return next;
                  })
                }
              >
                <ChevronRight
                  size={15}
                  className={expanded ? "node-chevron-open" : ""}
                />
                {expanded ? <FolderOpen size={18} /> : <Folder size={18} />}
                <span>{folder.name}</span>
              </button>
              <span className="node-folder-count">
                {branch.total} 个节点<span>在线 {branch.online}</span>
              </span>
            </div>
          </td>
          <td className="node-row-actions">
            {canWrite && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={op.busy}
                  onClick={() =>
                    openEditor({ kind: "folder", parentId: folder.id })
                  }
                >
                  新建子文件夹
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={op.busy}
                  onClick={() =>
                    openEditor({
                      kind: "folder",
                      folder,
                      parentId: folder.parentId,
                    })
                  }
                >
                  管理
                </Button>
              </>
            )}
          </td>
        </tr>
        {expanded && (
          <>
            {branch.children.map((child) => renderFolder(child, depth + 1))}
            {branch.nodes.map((node) => renderNode(node, depth + 1))}
            {!branch.total && !branch.children.length && (
              <tr className="node-folder-empty">
                <td
                  colSpan={canWrite ? 8 : 7}
                  style={{ paddingInlineStart: (depth + 1) * 22 + 40 }}
                >
                  空文件夹
                  {canWrite ? "，可拖入节点或通过节点编辑选择此分类。" : ""}
                </td>
              </tr>
            )}
          </>
        )}
      </Fragment>
    );
  };
  return (
    <>
      <PageTitle
        title="节点管理"
        description="按文件夹组织节点，通过标签快速定位，集中查看连接和资源状态。"
      >
        <Button variant="outline" onClick={() => void refresh()}>
          <RotateCw size={15} />
          刷新
        </Button>
        {canWrite && (
          <Button
            variant="outline"
            disabled={op.busy}
            onClick={() => openEditor({ kind: "folder", parentId: null })}
          >
            <FolderPlus size={16} />
            新建文件夹
          </Button>
        )}
        {user.data?.role === "ADMIN" && (
          <Button onClick={() => openEditor({ kind: "import" })}>
            <Plus size={16} />
            添加节点
          </Button>
        )}
      </PageTitle>
      {op.ui}
      <div className="node-toolbar">
        <input
          aria-label="搜索节点或文件夹"
          placeholder="搜索节点、主机名、标签或文件夹"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(new Set());
          }}
        />
        <details
          className="node-tag-filter"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary>
            <Tag size={15} />
            标签筛选{labels.length ? `（${labels.length}）` : ""}
          </summary>
          <div className="node-tag-menu">
            <p className="muted">同时包含所选标签</p>
            {suggestions.length ? (
              suggestions.map((label) => (
                <label key={label}>
                  <input
                    type="checkbox"
                    checked={labels.includes(label)}
                    onChange={(event) => {
                      setLabels(
                        event.target.checked
                          ? [...labels, label]
                          : labels.filter((item) => item !== label),
                      );
                      setSelected(new Set());
                    }}
                  />
                  {label}
                </label>
              ))
            ) : (
              <p className="muted">为节点添加标签后可在此筛选。</p>
            )}
          </div>
        </details>
        {tree.searching && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setLabels([]);
              setSelected(new Set());
            }}
          >
            清空筛选
          </Button>
        )}
        <span className="muted node-result-count">
          {tree.searching ? `${tree.matched.length} / ` : ""}
          {allNodes.length} 个节点
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={tree.searching || !allFolders.length}
          onClick={() => setCollapsed(new Set())}
        >
          全部展开
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={tree.searching || !allFolders.length}
          onClick={() =>
            setCollapsed(new Set(allFolders.map((folder) => folder.id)))
          }
        >
          全部折叠
        </Button>
      </div>
      {selectedNodes.length > 0 && canWrite && (
        <div
          className="node-selection-bar"
          role="region"
          aria-label="已选节点操作"
        >
          <strong>已选 {selectedNodes.length} 个节点</strong>
          <Button
            variant="outline"
            size="sm"
            disabled={op.busy}
            onClick={() =>
              openEditor({
                kind: "move",
                nodeIds: selectedNodes.map((node) => node.id),
              })
            }
          >
            <MoveRight size={15} />
            移动到文件夹
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
          >
            取消选择
          </Button>
        </div>
      )}
      <QueryState
        error={nodes.error ?? folders.error ?? user.error}
        loading={nodes.isLoading || folders.isLoading || user.isLoading}
        retry={() => {
          void refresh();
          void user.mutate();
        }}
      >
        <div
          className={`node-root-drop${dropTarget === "root" ? " node-drop-active" : ""}`}
          data-drop-root="true"
          onDragOver={(event) => dragOver(event, null)}
          onDrop={(event) => void drop(event, null)}
          onDragLeave={() => setDropTarget(null)}
        >
          <FolderOpen size={17} />
          <strong>根目录</strong>
          <span className="muted">{allFolders.length} 个文件夹</span>
          {canWrite && <small className="muted">拖到此处移出分类</small>}
        </div>
        <QueryState
          loading={false}
          retry={() => {}}
          empty={!tree.folders.length && !tree.nodes.length}
          emptyTitle={
            tree.searching ? "没有匹配的节点或文件夹" : "集群还没有节点或文件夹"
          }
          emptyText={
            tree.searching
              ? "调整搜索词或清空标签筛选。"
              : "导入 Agent 接入文件，或先创建文件夹组织节点。"
          }
        >
          <div
            className="table-wrap node-tree-table"
            role="region"
            aria-label="节点文件夹表格，可横向滚动"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  {canWrite && (
                    <th className="node-check">
                      <input
                        type="checkbox"
                        aria-label="全选筛选结果中的节点"
                        disabled={!tree.matched.length || op.busy}
                        checked={
                          !!tree.matched.length &&
                          selectedNodes.length === tree.matched.length
                        }
                        ref={(element) => {
                          if (element)
                            element.indeterminate =
                              selectedNodes.length > 0 &&
                              selectedNodes.length < tree.matched.length;
                        }}
                        onChange={(event) =>
                          setSelected(
                            new Set(
                              event.target.checked
                                ? tree.matched.map((node) => node.id)
                                : [],
                            ),
                          )
                        }
                      />
                    </th>
                  )}
                  {[
                    "节点 / 主机",
                    "连接状态",
                    "CPU",
                    "内存",
                    "系统",
                    "最近心跳",
                    "操作",
                  ].map((header) => (
                    <th scope="col" key={header}>
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tree.folders.map((folder) => renderFolder(folder, 0))}
                {tree.nodes.map((node) => renderNode(node, 0))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </QueryState>
      {editor?.kind === "node" && (
        <NodeEditor
          node={editor.node}
          nodes={allNodes}
          folders={allFolders}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}
      {editor?.kind === "import" && (
        <NodeImportDialog
          nodes={allNodes}
          folders={allFolders}
          onClose={() => setEditor(null)}
          onImported={saved}
        />
      )}
      {editor?.kind === "folder" && (
        <FolderDialog
          key={editor.folder?.id ?? editor.parentId ?? "new"}
          folder={editor.folder}
          parentId={editor.parentId}
          nodes={allNodes}
          folders={allFolders}
          onClose={() => setEditor(null)}
          onSaved={(parentId) => {
            expandTarget(parentId);
            saved();
          }}
        />
      )}
      {editor?.kind === "move" && (
        <MoveDialog
          nodeIds={editor.nodeIds}
          nodes={allNodes}
          folders={allFolders}
          onClose={() => setEditor(null)}
          onSaved={(folderId) => {
            expandTarget(folderId);
            saved();
          }}
        />
      )}
    </>
  );
}

function FolderDialog({
  folder,
  parentId: initialParent,
  folders,
  nodes,
  onClose,
  onSaved,
}: {
  folder?: NodeFolderData;
  parentId: string | null;
  folders: NodeFolderData[];
  nodes: NodeData[];
  onClose: () => void;
  onSaved: (parentId: string | null) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [parentId, setParentId] = useState(initialParent);
  const op = useOperation(undefined, true);
  const available = folder
    ? folders.filter(
        (item) => !folderAncestors(item.id, folders).has(folder.id),
      )
    : folders;
  return (
    <BusinessDialog
      title={folder ? "管理文件夹" : "新建文件夹"}
      description={
        folder
          ? `当前位置：${folderPath(folder.id, folders)}`
          : "使用文件夹按环境、地域或用途组织节点。"
      }
      onClose={onClose}
      operation={op}
      footer={
        <>
          {folder && (
            <Button
              variant="destructive"
              disabled={op.busy}
              onClick={() =>
                op.ask(
                  `删除文件夹“${folder.name}”？`,
                  `${nodes.filter((node) => node.folderId === folder.id).length} 个直属节点和 ${folders.filter((item) => item.parentId === folder.id).length} 个子文件夹将移到“${folderPath(folder.parentId, folders) || "根目录"}”。节点与历史数据保留。`,
                  async () => {
                    const result = await rpc("nodeFolders.delete", {
                      id: folder.id,
                      confirmed: true,
                    });
                    onSaved(folder.parentId);
                    return result;
                  },
                )
              }
            >
              删除文件夹
            </Button>
          )}
          <Button variant="outline" disabled={op.busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="folder-edit" disabled={op.busy}>
            保存
          </Button>
        </>
      }
    >
      <form
        id="folder-edit"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await op.run(() =>
            rpc("nodeFolders.save", { id: folder?.id, name, parentId }),
          );
          if (result) onSaved(parentId);
        }}
      >
        <fieldset className="dialog-fields" disabled={op.busy}>
          <label>
            文件夹名称
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <FolderSelect
            folders={available}
            value={parentId}
            onChange={setParentId}
            label="上级文件夹"
          />
        </fieldset>
      </form>
    </BusinessDialog>
  );
}

function MoveDialog({
  nodeIds,
  nodes,
  folders,
  onClose,
  onSaved,
}: {
  nodeIds: string[];
  nodes: NodeData[];
  folders: NodeFolderData[];
  onClose: () => void;
  onSaved: (folderId: string | null) => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const op = useOperation(undefined, true);
  return (
    <BusinessDialog
      title="移动节点"
      description={`已选择 ${nodeIds.length} 个节点，选择目标文件夹后统一移动。`}
      onClose={onClose}
      operation={op}
      formId="nodes-move"
      submit="移动"
    >
      <form
        id="nodes-move"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await op.run(() =>
            rpc("nodes.move", { nodeIds, folderId }),
          );
          if (result) onSaved(folderId);
        }}
      >
        <fieldset className="dialog-fields" disabled={op.busy}>
          <p className="node-move-names">
            {nodes
              .filter((node) => nodeIds.includes(node.id))
              .map((node) => node.name)
              .join("、")}
          </p>
          <FolderSelect
            folders={folders}
            value={folderId}
            onChange={setFolderId}
            label="目标文件夹"
          />
        </fieldset>
      </form>
    </BusinessDialog>
  );
}
