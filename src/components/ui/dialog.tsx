"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./button";
export function ConfirmDialog({
  title,
  description,
  open,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  open: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <div className="dialog-actions">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={busy}>
              {busy ? "正在处理…" : "确认操作"}
            </Button>
          </div>
          <Dialog.Close
            aria-label="关闭确认"
            className="dialog-close"
            disabled={busy}
          >
            <X size={18} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
