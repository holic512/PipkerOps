/**
 * @file node-editor.tsx
 * @project PipkerOps
 * @module node-management-forms
 * @description 列表和详情共用的节点分类、标签编辑与 Agent 接入弹窗。
 * @logic 标签通过输入和建议添加；导入先验证连接，重新接入预填原分类，退出即清理临时凭证。
 * @dependencies React, shared queries/operations, BusinessDialog, node RPC
 * @index_tags nodes, folders, labels, enrollment, forms
 * @author holic512
 */
"use client";
import { useId, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { rpc, type NodeData, type NodeFolderData } from "@/lib/client";
import { folderPath } from "@/lib/node-tree";
import { useOperation } from "./shared";
import { Button } from "./ui/button";
import { BusinessDialog } from "./ui/dialog";

export function NodeLabels({ labels }: { labels: string[] }) {
  return (
    labels.length > 0 && (
      <div className="node-labels">
        {labels.map((label) => (
          <span className="node-label" key={label}>
            {label}
          </span>
        ))}
      </div>
    )
  );
}

export function FolderSelect({
  folders,
  value,
  onChange,
  label = "所属文件夹",
}: {
  folders: NodeFolderData[];
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
}) {
  const options = folders
    .map((folder) => ({ id: folder.id, path: folderPath(folder.id, folders) }))
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN", { numeric: true }));
  return (
    <label>
      {label}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">根目录（未分类）</option>
        {options.map((option) => (
          <option value={option.id} key={option.id}>
            {option.path}
          </option>
        ))}
      </select>
    </label>
  );
}

function LabelsField({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: string[];
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const add = () => {
    const label = draft.trim();
    if (label && label.length <= 120 && value.length < 50) {
      onChange([...new Set([...value, label])]);
      setDraft("");
    }
  };
  return (
    <div className="labels-field">
      <label htmlFor={id}>
        标签 <span className="muted">{value.length} / 50</span>
      </label>
      <div className="node-labels">
        {value.map((label) => (
          <span className="node-label" key={label}>
            {label}
            <button
              type="button"
              aria-label={`移除标签 ${label}`}
              onClick={() => onChange(value.filter((item) => item !== label))}
            >
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
      <div className="label-input-row">
        <input
          id={id}
          name="labelDraft"
          list={`${id}-suggestions`}
          maxLength={120}
          disabled={value.length >= 50}
          value={draft}
          placeholder="输入标签后按回车添加"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          variant="outline"
          type="button"
          onClick={add}
          disabled={!draft.trim() || value.length >= 50}
        >
          添加标签
        </Button>
      </div>
      <datalist id={`${id}-suggestions`}>
        {suggestions
          .filter((label) => !value.includes(label))
          .map((label) => (
            <option key={label} value={label} />
          ))}
      </datalist>
      <small className="muted">
        可选择已有标签；保存时也会添加尚未确认的输入。
      </small>
    </div>
  );
}

function submittedLabels(form: HTMLFormElement, labels: string[]) {
  const draft = String(new FormData(form).get("labelDraft") ?? "").trim();
  return [...new Set([...labels, ...(draft ? [draft] : [])])];
}

export function NodeEditor({
  node,
  nodes,
  folders,
  onClose,
  onSaved,
}: {
  node: NodeData;
  nodes: NodeData[];
  folders: NodeFolderData[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(node.name);
  const [folderId, setFolderId] = useState(node.folderId);
  const [labels, setLabels] = useState([...new Set(node.labels)]);
  const op = useOperation(undefined, true);
  const suggestions = [...new Set(nodes.flatMap((item) => item.labels))].sort();
  return (
    <BusinessDialog
      title="编辑节点"
      description="修改名称、文件夹和标签。"
      onClose={onClose}
      operation={op}
      formId="node-edit"
    >
      <form
        id="node-edit"
        onSubmit={async (event) => {
          event.preventDefault();
          const values = submittedLabels(event.currentTarget, labels);
          const result = await op.run(() =>
            rpc("nodes.update", {
              id: node.id,
              name,
              folderId,
              labels: values,
            }),
          );
          if (result) onSaved();
        }}
      >
        <fieldset className="dialog-fields" disabled={op.busy}>
          <label>
            节点名称
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <FolderSelect
            folders={folders}
            value={folderId}
            onChange={setFolderId}
          />
          <LabelsField
            value={labels}
            onChange={setLabels}
            suggestions={suggestions}
          />
        </fieldset>
      </form>
    </BusinessDialog>
  );
}

export function NodeImportDialog({
  nodes,
  folders,
  onClose,
  onImported,
}: {
  nodes: NodeData[];
  folders: NodeFolderData[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [existing, setExisting] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [fileError, setFileError] = useState("");
  const [checked, setChecked] = useState<{
    agentId: string;
    hostname: string;
    agentVersion: string;
  } | null>(null);
  const op = useOperation(undefined, true);
  const suggestions = [...new Set(nodes.flatMap((node) => node.labels))].sort();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!checked) return;
    const values = submittedLabels(event.currentTarget, labels);
    op.ask(
      existing ? "重新接入此节点？" : "添加此节点？",
      `节点：${name.trim() || checked.hostname}；文件夹：${folderPath(folderId, folders) || "根目录"}；标签：${values.join("、") || "无"}。Ops 将使用导入凭证连接 Agent。`,
      async () => {
        const result = await rpc("nodes.import", {
          connection: JSON.parse(raw),
          id: existing || undefined,
          name: name.trim() || undefined,
          folderId,
          labels: values,
          confirmed: true,
        });
        onImported();
        return result;
      },
    );
  };
  return (
    <BusinessDialog
      title="导入 Agent 接入文件"
      description="在 Agent 部署菜单中选择“导出接入文件”。文件包含访问 Key，请妥善保管。"
      onClose={onClose}
      operation={op}
      footer={
        <>
          <Button variant="outline" disabled={op.busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="outline"
            disabled={op.busy || !raw.trim()}
            onClick={async () => {
              setChecked(null);
              const result = await op.run(
                () =>
                  rpc<typeof checked>("nodes.test", {
                    connection: JSON.parse(raw),
                  }),
                "Agent 连接验证成功",
              );
              if (result) setChecked(result);
            }}
          >
            测试连接
          </Button>
          <Button
            type="submit"
            form="node-import"
            disabled={op.busy || !checked}
          >
            {existing ? "确认重新接入" : "确认添加"}
          </Button>
        </>
      }
    >
      <form id="node-import" onSubmit={submit}>
        <fieldset className="dialog-fields" disabled={op.busy}>
          <label>
            接入文件（JSON）
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setChecked(null);
                setFileError("");
                setRaw("");
                op.clear();
                if (!file) return;
                if (file.size > 65536) {
                  setFileError("接入文件不能超过 64 KiB");
                  return;
                }
                void file
                  .text()
                  .then(setRaw)
                  .catch(() => setFileError("读取文件失败，请重新选择"));
              }}
            />
          </label>
          <label>
            或粘贴接入内容
            <textarea
              rows={6}
              autoComplete="off"
              spellCheck={false}
              value={raw}
              onChange={(event) => {
                setRaw(event.target.value);
                setChecked(null);
                setFileError("");
                op.clear();
              }}
            />
          </label>
          <label>
            关联已有节点
            <select
              value={existing}
              onChange={(event) => {
                setExisting(event.target.value);
                const node = nodes.find(
                  (item) => item.id === event.target.value,
                );
                setName(node?.name ?? "");
                setFolderId(node?.folderId ?? null);
                setLabels([...new Set(node?.labels ?? [])]);
              }}
            >
              <option value="">创建新节点</option>
              {nodes.map((node) => (
                <option value={node.id} key={node.id}>
                  {node.name} — 重新接入并保留历史
                </option>
              ))}
            </select>
          </label>
          <label>
            节点名称（可选）
            <input
              value={name}
              maxLength={120}
              placeholder="留空使用 Agent 名称"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <FolderSelect
            folders={folders}
            value={folderId}
            onChange={setFolderId}
          />
          <LabelsField
            key={existing || "new"}
            value={labels}
            onChange={setLabels}
            suggestions={suggestions}
          />
          {fileError && (
            <p role="alert" className="error-text">
              {fileError}
            </p>
          )}
          {checked && (
            <p role="status">
              连接验证成功：{checked.hostname} · Agent {checked.agentVersion}
            </p>
          )}
        </fieldset>
      </form>
    </BusinessDialog>
  );
}
