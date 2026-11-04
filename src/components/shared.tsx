"use client";
/**
 * @file shared.tsx
 * @project PipkerOps
 * @module shared-ui
 * @description 业务查询、标题、公共表单组合、状态与操作确认；兼容导出统一表格。
 * @logic 查询呈现加载与失败状态；表单组合 UI 控件并支持底部提交；表格由 UI 层实现；操作确认按工作区使用内嵌或独立弹窗。
 * @dependencies React, SWR, RPC, UI components
 * @index_tags forms, queries, confirmation, feedback
 * @author holic512
 */

import { useState } from "react";
import useSWR from "swr";
import { Inbox, RotateCw, AlertCircle, Check, X } from "lucide-react";
import { rpc, RequestError } from "@/lib/client";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { NativeSelect } from "./ui/native-select";
import { Checkbox } from "./ui/checkbox";
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
  PENDING: ["待重新接入", "warn"],
  REJECTED: ["已拒绝", "bad"],
  REVOKED: ["已吊销", "bad"],
  HEALTHY: ["正常", "good"],
  UNHEALTHY: ["故障", "bad"],
  DEGRADED: ["异常", "warn"],
  UNKNOWN: ["待确认", "neutral"],
  PAUSED: ["已停用", "neutral"],
  QUEUED: ["排队中", "neutral"],
  REQUESTED: ["请求中", "info"],
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
  created: ["已创建", "neutral"],
  paused: ["已暂停", "warn"],
  restarting: ["重启中", "info"],
  dead: ["异常退出", "bad"],
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
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export { DataTable } from "./ui/table";
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
      <Button
        variant="ghost"
        size="icon"
        aria-label="关闭提示"
        onClick={onClose}
      >
        <X size={16} />
      </Button>
    </div>
  );
}
export function useOperation(onSuccess?: () => void, inline = false) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
    success?: string;
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
  const clear = () => {
    setConfirmation(null);
    setFeedback(null);
  };
  return {
    busy,
    run,
    confirmation,
    confirm: () => {
      if (confirmation && !busy)
        void run(confirmation.action, confirmation.success);
    },
    back: clear,
    ask: (
      title: string,
      description: string,
      action: () => Promise<unknown>,
      success?: string,
    ) => {
      setFeedback(null);
      setConfirmation({ title, description, action, success });
    },
    feedback,
    clear,
    ui: inline ? null : (
      <>
        <Feedback value={feedback} onClose={() => setFeedback(null)} />
        <ConfirmDialog
          title={confirmation?.title ?? ""}
          description={confirmation?.description ?? ""}
          open={!!confirmation}
          busy={busy}
          error={feedback?.error ? feedback.message : undefined}
          onClose={clear}
          onConfirm={() => {
            if (confirmation)
              void run(confirmation.action, confirmation.success);
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
  disabled = false,
  submit = "保存",
  children,
  id,
  hideSubmit = false,
}: {
  id?: string;
  hideSubmit?: boolean;
  fields: Field[];
  onSubmit: (data: Record<string, unknown>) => Promise<unknown>;
  busy: boolean;
  disabled?: boolean;
  submit?: string;
  children?: React.ReactNode;
}) {
  const [error, setError] = useState("");
  return (
    <form
      id={id}
      className="resource-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled) return;
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
      <fieldset className="form-grid" disabled={busy || disabled}>
        {fields.map((f) => (
          <label
            key={f.name}
            className={
              f.type === "textarea" || f.type === "json" ? "field-wide" : ""
            }
          >
            {f.label}
            {f.type === "select" ? (
              <NativeSelect
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
              </NativeSelect>
            ) : f.type === "textarea" || f.type === "json" ? (
              <Textarea
                name={f.name}
                defaultValue={String(
                  f.defaultValue ?? (f.type === "json" ? "{}" : ""),
                )}
                placeholder={f.placeholder}
                rows={f.type === "json" ? 5 : 4}
                required={f.required}
              />
            ) : f.type === "checkbox" ? (
              <Checkbox
                name={f.name}
                defaultChecked={Boolean(f.defaultValue)}
                required={f.required}
              />
            ) : (
              <Input
                name={f.name}
                type={
                  f.type === "number"
                    ? "number"
                    : ["password", "email"].includes(f.type ?? "")
                      ? f.type
                      : "text"
                }
                defaultValue={String(f.defaultValue ?? "")}
                placeholder={f.placeholder}
                required={f.required}
                min={f.min}
                max={f.max}
              />
            )}
          </label>
        ))}
      </fieldset>
      {children}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {!hideSubmit && (
        <div className="form-footer">
          <Button type="submit" disabled={busy || disabled}>
            {busy ? "正在处理…" : submit}
          </Button>
        </div>
      )}
    </form>
  );
}
