/**
 * @file console.tsx
 * @project PipkerOps
 * @module manage-shell
 * @description 分组侧栏、访问标签、登录状态与模块页面的管理端入口。
 * @logic 路由选择真实业务页面，认证失败转登录；访问标签保留当前会话导航。
 * @dependencies React, Next.js, SWR, Lucide
 * @index_tags ui, navigation, console
 * @author holic512
 */
"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Network,
  LayoutDashboard,
  Server,
  Boxes,
  Waypoints,
  Activity,
  Container,
  Globe,
  Terminal,
  Folder,
  Command,
  CalendarClock,
  ListChecks,
  Bell,
  KeyRound,
  ScrollText,
  Menu,
  X,
  LogOut,
  ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { useQuery } from "./shared";
import { Overview, Nodes, NodeDetail } from "./nodes";
import { Applications, Probes } from "./applications";
import {
  Tasks,
  TaskDetail,
  Operations,
  Resources,
  TerminalPage,
} from "./operations";
import { Topology } from "./topology";
const nav = [
  {
    group: "集群",
    items: [
      { path: "/", name: "集群总览", icon: LayoutDashboard },
      { path: "/nodes", name: "节点管理", icon: Server },
      { path: "/applications", name: "应用中心", icon: Boxes },
      { path: "/topology", name: "应用拓扑", icon: Waypoints },
      { path: "/probes", name: "多源探针", icon: Activity },
    ],
  },
  {
    group: "运维",
    items: [
      { path: "/docker", name: "Docker / Compose", icon: Container },
      { path: "/sites", name: "站点管理", icon: Globe },
      { path: "/terminal", name: "远程终端", icon: Terminal },
      { path: "/files", name: "文件管理", icon: Folder },
      { path: "/system", name: "系统运维", icon: Command },
    ],
  },
  {
    group: "自动化",
    items: [
      { path: "/actions", name: "自定义操作", icon: Command },
      { path: "/schedules", name: "定时调度", icon: CalendarClock },
      { path: "/tasks", name: "执行任务", icon: ListChecks },
      { path: "/alerts", name: "告警与通知", icon: Bell },
    ],
  },
  {
    group: "平台",
    items: [
      { path: "/mcp", name: "MCP 与密钥", icon: KeyRound },
      { path: "/audit", name: "操作审计", icon: ScrollText },
    ],
  },
];
const items = nav.flatMap((g) => g.items);
export function Console() {
  const path = usePathname();
  const router = useRouter();
  const [mobile, setMobile] = useState(false);
  const [tabs, setTabs] = useState(path === "/" ? ["/"] : ["/", path]);
  const [previousPath, setPreviousPath] = useState(path);
  const user = useQuery<{ displayName: string; role: string }>(
    path === "/login" ? null : "users.me",
    {},
    0,
  );
  const current = items.find((i) =>
    i.path === "/" ? path === "/" : path.startsWith(i.path),
  );
  useEffect(() => {
    if (path !== "/login" && user.error?.status === 401)
      router.replace("/login");
  }, [user.error, router, path]);
  if (previousPath !== path) {
    setPreviousPath(path);
    setTabs((previous) =>
      previous.includes(path)
        ? previous
        : ["/", ...previous.filter((p) => p !== "/"), path].slice(-12),
    );
  }
  if (path === "/login") return null;
  const render = () => {
    if (path === "/") return <Overview />;
    if (path.startsWith("/nodes/"))
      return <NodeDetail id={path.split("/")[2]} />;
    if (path === "/nodes") return <Nodes />;
    if (path === "/applications") return <Applications />;
    if (path === "/probes") return <Probes />;
    if (path === "/topology") return <Topology />;
    if (path.startsWith("/tasks/"))
      return <TaskDetail id={path.split("/")[2]} />;
    if (path === "/tasks") return <Tasks />;
    if (path === "/terminal") return null;
    if (["/docker", "/files", "/system"].includes(path))
      return <Operations key={path} mode={path.slice(1)} />;
    if (
      [
        "/sites",
        "/actions",
        "/schedules",
        "/alerts",
        "/mcp",
        "/audit",
      ].includes(path)
    )
      return <Resources key={path} mode={path.slice(1)} />;
    return (
      <div className="empty-state">
        <h1>页面不存在</h1>
        <Link href="/">返回总览</Link>
      </div>
    );
  };
  return (
    <div className="console">
      <a href="#main-content" className="skip-link">
        跳转到主内容
      </a>
      {mobile && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭菜单"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? "sidebar-open" : ""}`}>
        <Link className="brand" href="/">
          <span>
            <Network size={23} />
          </span>
          PipkerOps
        </Link>
        <div className="workspace-label">
          <span className="online-dot" />
          集群工作空间
        </div>
        <nav aria-label="主导航">
          {nav.map((group) => (
            <div key={group.group} className="nav-group">
              <div className="nav-label">{group.group}</div>
              {group.items.map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  aria-current={
                    current?.path === item.path ? "page" : undefined
                  }
                  className={
                    current?.path === item.path ? "nav-link active" : "nav-link"
                  }
                  onClick={() => setMobile(false)}
                >
                  <item.icon size={18} />
                  <span>{item.name}</span>
                  {current?.path === item.path && <ChevronRight size={14} />}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="version">PipkerOps 0.1.0</span>
          <span>轻量集群运维</span>
        </div>
      </aside>
      <div className="console-body">
        <header className="topbar">
          <div className="topbar-left">
            <Button
              size="icon"
              variant="ghost"
              className="mobile-toggle"
              aria-label="打开菜单"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </Button>
            <span className="breadcrumb">
              工作空间 <ChevronRight size={14} />{" "}
              <strong>{current?.name ?? "详情"}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <Link href="/alerts" aria-label="告警与通知" className="icon-link">
              <Bell size={19} />
            </Link>
            <span className="user-avatar">
              {user.data?.displayName?.slice(0, 1) ?? "P"}
            </span>
            <span className="user-name">
              {user.data?.displayName ?? "正在连接…"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                router.replace("/login");
              }}
            >
              <LogOut size={16} />
            </Button>
          </div>
        </header>
        <nav className="tabbar" aria-label="已访问页面">
          {tabs.map((tab) => {
            const label =
              items.find((i) => i.path === tab)?.name ??
              (tab.startsWith("/nodes/") ? "节点详情" : "任务详情");
            return (
              <div
                className={tab === path ? "page-tab selected" : "page-tab"}
                key={tab}
              >
                <Link href={tab}>{label}</Link>
                {tab !== "/" && (
                  <button
                    aria-label={`关闭${label}标签`}
                    onClick={() => {
                      setTabs((t) => t.filter((v) => v !== tab));
                      if (path === tab) router.push("/");
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </nav>
        <main id="main-content" className="main-content">
          {render()}
          {tabs.includes("/terminal") && (
            <div hidden={path !== "/terminal"}>
              <TerminalPage />
            </div>
          )}
        </main>
        <footer className="console-footer">
          PipkerOps<span>Agent 主动连接 · 操作全程留痕</span>
        </footer>
      </div>
    </div>
  );
}
