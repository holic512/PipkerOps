"use client";
/**
 * @file popover.tsx
 * @project PipkerOps
 * @module shared-ui
 * @description 基于 Radix 的表单筛选浮层。
 * @logic Portal 继承主题，公共层统一浮层外观与关闭焦点行为。
 * @dependencies React, Radix Popover, cn
 * @index_tags popover, filters, focus
 * @author holic512
 */
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({
  className,
  align = "start",
  sideOffset = 5,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn("popover-content", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
