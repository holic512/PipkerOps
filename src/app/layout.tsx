/**
 * @file layout.tsx
 * @project PipkerOps
 * @module manage-entry
 * @description 全局文档与持久管理工作台入口。
 * @logic 共享布局保持导航标签和终端会话跨页面状态。
 * @dependencies Next.js, React, console
 * @index_tags api, identity, entry
 * @author holic512
 */
import type { Metadata } from "next";
import "./globals.css";
import { Console } from "@/components/console";
export const metadata: Metadata = {
  title: "PipkerOps · 集群运维",
  description: "轻量级分布式集群运维平台",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <Console />
        {children}
      </body>
    </html>
  );
}
