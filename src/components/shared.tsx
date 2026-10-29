"use client";
import { useState } from "react";
import useSWR from "swr";
import { Inbox, RotateCw, AlertCircle, Check, X } from "lucide-react";
import { rpc, RequestError } from "@/lib/client";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
export function useQuery<T>(
  method: string | null,
  params: Record<string, unknown> = {},
  refreshInterval = 15000,
) {
  return useSWR<T>(
    method ? [method, JSON.stringify(params)] : null,
    () => rpc<T>(method!, params),
    { refreshInterval, revalidateOnFocus: false },
  );
}
export function QueryState({
  error,
  loading,
  empty,
  retry,
  children,
  emptyTitle = "暂无记录",
  emptyText = "创建第一条记录后，即可在这里查看。",
}: {
  error?: Error;
  loading: boolean;
  empty?: boolean;
  retry: () => void;
  children: React.ReactNode;
  emptyTitle?: string;
  emptyText?: string;
}) {
  if (error)
    return (
      <div className="empty-state" role="alert">
        <AlertCircle size={28} />
        <h2>{error.message}</h2>
        <p>
          {error instanceof RequestError && error.status === 401
            ? "请重新登录后继续。"
            : "检查连接或权限后重试。"}
        </p>
        <Button variant="outline" onClick={retry}>
          <RotateCw size={14} />
          重试
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="loading-state" aria-busy="true" aria-label="正在加载">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  if (empty)
    return (
      <div className="empty-state">
        <Inbox size={30} />
        <h2>{emptyTitle}</h2>
        <p>{emptyText}</p>
      </div>
    );
  return children;
}
const states: Record<string, [string, string]> = {
  APPROVED: ["已批准", "good"],
  PENDING: ["待审批", "warn"],
  REJECTED: ["已拒绝", "bad"],
  REVOKED: ["已吊销", "bad"],
  HEALTHY: ["正常", "good"],
  UNHEALTHY: ["故障", "bad"],
  DEGRADED: ["异常", "warn"],
  UNKNOWN: ["待确认", "neutral"],
  QUEUED: ["排队中", "neutral"],
  DISPATCHED: ["已分发", "info"],
  RUNNING: ["执行中", "info"],
  SUCCEEDED: ["成功", "good"],
  FAILED: ["失败", "bad"],
  CANCELLED: ["已取消", "neutral"],
  ACTIVE: ["已生效", "good"],
  DRAFT: ["草稿", "neutral"],
  ERROR: ["错误", "bad"],
  running: ["运行中", "good"],
  exited: ["已停止", "neutral"],
  online: ["在线", "good"],
  offline: ["离线", "bad"],
};
export function Status({ value }: { value: string }) {
  const [text, color] = states[value] ?? [value, "neutral"];
  return (
    <span className={`status status-${color}`}>
      <i />
      {text}
    </span>
  );
}
export function PageTitle({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
export function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function JsonView({ data }: { data: unknown }) {
  return <pre className="code-block">{JSON.stringify(data, null, 2)}</pre>;
}
export function Feedback({
  value,
  onClose,
}: {
  value: { message: string; error?: boolean } | null;
  onClose: () => void;
}) {
  if (!value) return null;
  return (
    <div
      className={`feedback ${value.error ? "feedback-error" : ""}`}
      role={value.error ? "alert" : "status"}
    >
      {value.error ? <AlertCircle size={18} /> : <Check size={18} />}
      <span>{value.message}</span>
      <button aria-label="关闭提示" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
export function useOperation(onSuccess?: () => void) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const run = async <T,>(action: () => Promise<T>, success = "操作已完成") => {
    setBusy(true);
    try {
      const result = await action();
      setFeedback({ message: success });
      onSuccess?.();
      setConfirmation(null);
      return result;
    } catch (e) {
      setFeedback({
        message: e instanceof Error ? e.message : "操作失败",
        error: true,
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    run,
    ask: (title: string, description: string, action: () => Promise<unknown>) =>
      setConfirmation({ title, description, action }),
    feedback,
    clear: () => setFeedback(null),
    ui: (
      <>
        <Feedback value={feedback} onClose={() => setFeedback(null)} />
        <ConfirmDialog
          title={confirmation?.title ?? ""}
          description={confirmation?.description ?? ""}
          open={!!confirmation}
          busy={busy}
          onClose={() => setConfirmation(null)}
          onConfirm={() => {
            if (confirmation) void run(confirmation.action);
          }}
        />
      </>
    ),
  };
}
export type Field = {
  name: string;
  label: string;
  type?:
    | "text"
    | "number"
    | "textarea"
    | "select"
    | "json"
    | "checkbox"
    | "password"
    | "email";
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
};
export function ResourceForm({
  fields,
  onSubmit,
  busy,
  submit = "保存",
  children,
}: {
  fields: Field[];
  onSubmit: (data: Record<string, unknown>) => Promise<unknown>;
  busy: boolean;
  submit?: string;
  children?: React.ReactNode;
}) {
  const [error, setError] = useState("");
  return (
    <form
      className="resource-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        const form = new FormData(e.currentTarget);
        const values: Record<string, unknown> = {};
        try {
          for (const f of fields) {
            const value = form.get(f.name);
            if (f.type === "checkbox") values[f.name] = value === "on";
            else if (f.type === "number") values[f.name] = Number(value);
            else if (f.type === "json")
              values[f.name] = JSON.parse(String(value || "{}"));
            else if (value !== null && value !== "") values[f.name] = value;
          }
          await onSubmit(values);
        } catch (e) {
          setError(e instanceof Error ? e.message : "表单格式无效");
        }
      }}
    >
      <div className="form-grid">
        {fields.map((f) => (
          <label
            key={f.name}
            className={
              f.type === "textarea" || f.type === "json" ? "field-wide" : ""
            }
          >
            {f.label}
            {f.type === "select" ? (
              <select
                name={f.name}
                defaultValue={String(f.defaultValue ?? "")}
                required={f.required}
              >
                <option value="">请选择</option>
                {f.options?.map((o) => (
                  <option value={o.value} key={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === "textarea" || f.type === "json" ? (
              <textarea
                name={f.name}
                defaultValue={String(
                  f.defaultValue ?? (f.type === "json" ? "{}" : ""),
                )}
                placeholder={f.placeholder}
                rows={f.type === "json" ? 5 : 4}
                required={f.required}
              />
            ) : (
              <input
                name={f.name}
                type={
                  f.type === "number"
                    ? "number"
                    : ["password", "email"].includes(f.type ?? "")
                      ? f.type
                      : f.type === "checkbox"
                        ? "checkbox"
                        : "text"
                }
                defaultValue={
                  f.type === "checkbox"
                    ? undefined
                    : String(f.defaultValue ?? "")
                }
                defaultChecked={
                  f.type === "checkbox" ? Boolean(f.defaultValue) : undefined
                }
                placeholder={f.placeholder}
                required={f.required}
                min={f.min}
                max={f.max}
              />
            )}
          </label>
        ))}
      </div>
      {children}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="form-footer">
        <Button type="submit" disabled={busy}>
          {busy ? "正在处理…" : submit}
        </Button>
      </div>
    </form>
  );
}
