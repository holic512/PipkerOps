"use client";
/**
 * @file dropdown-menu.tsx
 * @project PipkerOps
 * @module shared-ui
 * @description 基于 Radix 的行操作与导航菜单。
 * @logic 默认非模态菜单保留工作区语义；统一键盘操作、危险状态与浮层外观。
 * @dependencies React, Radix DropdownMenu, cn
 * @index_tags menu, actions, keyboard
 * @author holic512
 */
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function DropdownMenu({
  modal = false,
  ...props
}: ComponentProps<typeof Menu.Root>) {
  return <Menu.Root modal={modal} {...props} />;
}
export const DropdownMenuTrigger = Menu.Trigger;
export function DropdownMenuContent({
  className,
  align = "end",
  sideOffset = 5,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        data-slot="dropdown-menu-content"
        className={cn("dropdown-menu-content", className)}
        align={align}
        sideOffset={sideOffset}
        {...props}
      />
    </Menu.Portal>
  );
}
export function DropdownMenuItem({
  className,
  destructive = false,
  ...props
}: ComponentProps<typeof Menu.Item> & { destructive?: boolean }) {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "dropdown-menu-item",
        destructive && "error-text",
        className,
      )}
      {...props}
    />
  );
}
