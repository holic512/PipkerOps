"use client";
/**
 * @file terminal-session.tsx
 * @project PipkerOps
 * @module remote-terminal-session
 * @description 独立PTY连接、输出保留及受控的命令粘贴入口。
 * @logic xterm按容器尺寸适配；会话关闭后禁用输入；粘贴不添加回车，卸载释放连接。
 * @dependencies React, xterm, WebSocket
 * @index_tags terminal, pty, workspace
 * @author holic512
 */
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
export type TerminalHandle = { paste: (text: string) => void };
export type TerminalState = "connecting" | "connected" | "closed";
export function TerminalSession({
  url,
  sessionId,
  onStateChange,
  ref: handleRef,
}: {
  url: string;
  sessionId: string;
  onStateChange: (id: string, state: TerminalState) => void;
  ref?: Ref<TerminalHandle>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const paste = useRef<((text: string) => void) | null>(null);
  useImperativeHandle(
    handleRef,
    () => ({ paste: (text) => paste.current?.(text) }),
    [],
  );
  const [error, setError] = useState("");
  const [state, setState] = useState<"connecting" | "connected" | "closed">(
    "connecting",
  );
  useEffect(() => {
    onStateChange(sessionId, state);
  }, [onStateChange, sessionId, state]);
  useEffect(() => {
    let dispose: () => void = () => {};
    let cancelled = false;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !ref.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        theme: { background: "#142033", foreground: "#e6edf5" },
        scrollback: 3000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      if (ref.current.clientWidth) fit.fit();
      const ws = new WebSocket(url);
      paste.current = (text) => {
        if (ws.readyState === WebSocket.OPEN && !term.options.disableStdin) {
          term.paste(text);
          if (ref.current?.clientWidth) term.focus();
        }
      };
      ws.onopen = () => {
        setState("connected");
        if (ref.current?.clientWidth) term.focus();
        ws.send(
          JSON.stringify({
            type: "terminal.resize",
            cols: Math.max(20, Math.min(400, term.cols)),
            rows: Math.max(5, Math.min(200, term.rows)),
          }),
        );
      };
      ws.onmessage = (e) => {
        try {
          const p = JSON.parse(e.data);
          if (p.type === "terminal.output") term.write(p.data);
          if (p.type === "terminal.error") {
            setError(p.error ?? "终端启动失败");
            term.options.disableStdin = true;
            setState("closed");
          }
          if (p.type === "terminal.exit") {
            term.options.disableStdin = true;
            if (term.textarea) term.textarea.disabled = true;
            setState("closed");
            term.writeln(`\r\n[会话已退出：${p.exitCode ?? 0}]`);
          }
        } catch {
          setError("收到无效的终端数据");
        }
      };
      ws.onerror = () =>
        setError(
          "终端连接失败。请检查节点在线状态，以及 HTTPS 反向代理是否支持 WebSocket。",
        );
      ws.onclose = () => {
        term.options.disableStdin = true;
        if (term.textarea) term.textarea.disabled = true;
        setState("closed");
        term.writeln("\r\n[连接已关闭]");
      };
      const onData = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "terminal.input", data }));
      });
      const observer = new ResizeObserver(() => {
        if (ref.current?.clientWidth) {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: "terminal.resize",
                cols: Math.max(20, Math.min(400, term.cols)),
                rows: Math.max(5, Math.min(200, term.rows)),
              }),
            );
        }
      });
      observer.observe(ref.current);
      dispose = () => {
        paste.current = null;
        observer.disconnect();
        onData.dispose();
        ws.close();
        term.dispose();
      };
    })();
    return () => {
      cancelled = true;
      dispose();
    };
  }, [url]);
  return (
    <>
      <p role="status" className="terminal-connection-state">
        {state === "connecting"
          ? "正在连接终端…"
          : state === "connected"
            ? "终端已连接"
            : "连接已关闭。如需继续，请关闭此标签并新建会话；旧输入不会自动重放。"}
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <div ref={ref} className="xterm-container" />
    </>
  );
}
