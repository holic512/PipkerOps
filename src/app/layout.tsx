/**
 * @file layout.tsx
 * @project PipkerOps
 * @module manage-entry
 * @description 全局主题文档与持久管理工作台入口。
 * @logic 首屏脚本在绘制前恢复主题；统一主题上下文，保持导航标签和终端会话跨页面状态。
 * @dependencies Next.js, React, console, theme
 * @index_tags api, identity, entry, theme
 * @author holic512
 */
import type { Metadata } from "next";
import "./globals.css";
import { Console } from "@/components/console";
import { ThemeProvider } from "@/components/theme-provider";
import { themeBootstrapScript } from "@/lib/theme";
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
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <ThemeProvider>
          <Console />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
