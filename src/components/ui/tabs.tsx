"use client";
/**
 * @file tabs.tsx
 * @project PipkerOps
 * @module shared-tabs-ui
 * @description 基于 Radix 的标签页原语和受控业务视图切换。
 * @logic Radix 关联标签与面板并提供键盘导航；业务组合仅挂载当前视图内容。
 * @dependencies React, Radix Tabs, cn, global inner-tabs styles
 * @index_tags tabs, navigation, keyboard, accessibility
 * @author holic512
 */
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("view-tabs", className)}
      {...props}
    />
  );
}

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("inner-tabs", className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" {...props} />;
}

export function TabsContent({
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" {...props} />;
}

export function ViewTabs({
  value,
  onValueChange,
  label,
  items,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  items: { value: string; label: React.ReactNode }[];
  children: React.ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={onValueChange}>
      <TabsList aria-label={label}>
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            className={value === item.value ? "active" : undefined}
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.value} value={item.value}>
          {value === item.value ? children : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
