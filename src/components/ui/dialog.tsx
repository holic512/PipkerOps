"use client";
/**
 * @file dialog.tsx
 * @project PipkerOps
 * @module shared-dialog-ui
 * @description 基于 Radix 的业务弹窗与操作确认。
 * @logic 正文独立滚动，表单核对保留输入；关闭恢复焦点，提交中锁定退出。
 * @dependencies React, Radix Dialog, Button
 * @index_tags dialog, forms, confirmation, accessibility
 * @author holic512
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";

export type DialogOperation = {
  busy: boolean;
  feedback: { message: string; error?: boolean } | null;
  confirmation: { title: string; description: string } | null;
  confirm: () => void;
  back: () => void;
};

export function BusinessDialog({
  title,
  description,
  open = true,
  onClose,
  children,
  size = "form",
  operation,
  formId,
  submit = "保存",
  disabled,
  footer,
  readOnly = false,
}: {
  title: string;
  description?: string;
  open?: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: "confirm" | "form" | "detail";
  operation?: DialogOperation;
  formId?: string;
  submit?: string;
  disabled?: boolean;
  footer?: ReactNode;
  readOnly?: boolean;
}) {
  const trigger = useRef<HTMLElement | null>(null);
  const busy = operation?.busy ?? false;
  const confirmation = operation?.confirmation;
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const previousStep = useRef({ title, reviewing: !!confirmation });
  useEffect(() => {
    if (
      previousStep.current.title !== title ||
      previousStep.current.reviewing !== !!confirmation
    )
      heading.current?.focus();
    previousStep.current = { title, reviewing: !!confirmation };
  }, [title, confirmation]);
  const close = () => {
    if (busy) return;
    if (confirmation) operation?.back();
    else onClose();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          ref={content}
          className={`dialog-content dialog-${size}`}
          aria-busy={busy}
          {...(!description && !confirmation
            ? { "aria-describedby": undefined }
            : {})}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const active = document.activeElement;
            // 菜单项会随弹窗打开而卸载，返回焦点应指向该菜单的持久触发按钮。
            const menuTrigger = active
              ?.closest('[role="menu"]')
              ?.getAttribute("aria-labelledby");
            trigger.current = menuTrigger
              ? document.getElementById(menuTrigger)
              : active instanceof HTMLElement
                ? active
                : null;
            const input = content.current?.querySelector<HTMLElement>(
              "input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
            );
            (input ?? heading.current)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected)
              trigger.current.focus({ preventScroll: true });
          }}
          onPointerDownOutside={(event) => {
            if (!readOnly || busy || confirmation) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (busy || confirmation) {
              event.preventDefault();
              if (!busy) operation?.back();
            }
          }}
        >
          <header className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              {confirmation?.title ?? title}
            </Dialog.Title>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label={confirmation ? "返回修改" : "关闭弹窗"}
              className="dialog-close"
              disabled={busy}
              onClick={close}
            >
              <X size={18} />
            </Button>
          </header>
          <div className="dialog-body">
            {(confirmation || description) && (
              <Dialog.Description className="dialog-description">
                {confirmation?.description ?? description}
              </Dialog.Description>
            )}

            <div hidden={!!confirmation} inert={busy}>
              {children}
            </div>
            {confirmation && (
              <p className="muted">请核对以上内容，确认后执行操作。</p>
            )}
            {operation?.feedback && (
              <p
                role={operation.feedback.error ? "alert" : "status"}
                className={operation.feedback.error ? "error-text" : "muted"}
              >
                {operation.feedback.message}
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            {confirmation ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={operation.back}
                >
                  返回修改
                </Button>
                <Button disabled={busy} onClick={operation.confirm}>
                  {busy ? "正在处理…" : "确认操作"}
                </Button>
              </>
            ) : (
              (footer ?? (
                <>
                  <Button variant="outline" disabled={busy} onClick={onClose}>
                    {formId ? "取消" : "关闭"}
                  </Button>
                  {formId && (
                    <Button
                      type="submit"
                      form={formId}
                      disabled={busy || disabled}
                    >
                      {busy ? "正在处理…" : submit}
                    </Button>
                  )}
                </>
              ))
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  title,
  description,
  open,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  open: boolean;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <BusinessDialog
      title={title}
      description={description}
      open={open}
      size="confirm"
      onClose={() => {
        if (!busy) onClose();
      }}
      operation={{
        busy,
        feedback: error ? { message: error, error: true } : null,
        confirmation: null,
        confirm: onConfirm,
        back: onClose,
      }}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? "正在处理…" : "确认操作"}
          </Button>
        </>
      }
    >
      {null}
    </BusinessDialog>
  );
}
