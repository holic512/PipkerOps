"use client";
import { useState } from "react";
import { Network, ArrowRight, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
export default function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <div className="login-brand">
        <Network size={32} />
        <span>PipkerOps</span>
      </div>
      <section className="login-panel">
        <LockKeyhole size={26} className="accent" />
        <h1>登录运维工作台</h1>
        <p className="muted">
          连接节点、了解应用状态、管理集群中的每一次操作。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email: form.get("email"),
                  password: form.get("password"),
                }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error);
              // 新身份使用全新查询缓存，避免旧401再次触发登录跳转。
              window.location.replace("/");
            } catch (e) {
              setError(e instanceof Error ? e.message : "登录失败，请重试");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            邮箱
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              placeholder="管理员邮箱"
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="输入登录密码"
            />
          </label>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? "正在登录…" : "进入工作台"}
            <ArrowRight size={16} />
          </Button>
        </form>
        <p className="login-help">首次使用？请先在服务端完成管理员初始化。</p>
      </section>
      <footer>基础设施与应用，一处掌握。</footer>
    </main>
  );
}
