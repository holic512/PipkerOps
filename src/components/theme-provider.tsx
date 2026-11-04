"use client";
/**
 * @file theme-provider.tsx
 * @project PipkerOps
 * @module theme-ui
 * @description 全局主题订阅、系统偏好同步与公共主题选择入口。
 * @logic 复用首屏根节点主题，统一发布切换；持久偏好，跟随系统时响应系统变化。
 * @dependencies React, Lucide, lib/theme
 * @index_tags theme, context, preference, ui
 * @author holic512
 */
import { NativeSelect } from "@/components/ui/native-select";
import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  applyTheme,
  themeStorageKey,
  type Theme,
  type ThemePreference,
} from "@/lib/theme";

const listeners = new Set<() => void>();
const ThemeContext = createContext<{
  preference: ThemePreference;
  resolvedTheme: Theme;
  setPreference: (preference: ThemePreference) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => "system:light",
  );
  const [preference, resolvedTheme] = snapshot.split(":") as [
    ThemePreference,
    Theme,
  ];
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => {
      if (document.documentElement.dataset.themePreference === "system") {
        applyTheme("system", themeStorageKey);
        notify();
      }
    };
    media.addEventListener("change", updateSystemTheme);
    return () => media.removeEventListener("change", updateSystemTheme);
  }, []);
  return (
    <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("主题组件必须位于 ThemeProvider 内。");
  return context;
}

export function ThemeSwitcher() {
  const { preference, setPreference } = useTheme();
  const Icon =
    preference === "system" ? Monitor : preference === "dark" ? Moon : Sun;
  return (
    <div className="theme-switcher">
      <Icon size={15} aria-hidden="true" />
      <NativeSelect
        aria-label="界面主题"
        value={preference}
        onChange={(event) =>
          setPreference(event.target.value as ThemePreference)
        }
      >
        <option value="system">跟随系统</option>
        <option value="light">亮色</option>
        <option value="dark">暗色</option>
      </NativeSelect>
    </div>
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getSnapshot() {
  const { themePreference, theme } = document.documentElement.dataset;
  return `${themePreference}:${theme}`;
}
function setPreference(preference: ThemePreference) {
  applyTheme(preference, themeStorageKey);
  persistPreference(preference);
  notify();
}
function persistPreference(preference: ThemePreference) {
  try {
    localStorage.setItem(themeStorageKey, preference);
  } catch {
    // 禁用持久存储不影响本次页面会话的主题。
  }
}
function notify() {
  listeners.forEach((listener) => listener());
}
