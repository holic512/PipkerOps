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
