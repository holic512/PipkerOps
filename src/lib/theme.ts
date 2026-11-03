/**
 * @file theme.ts
 * @project PipkerOps
 * @module theme
 * @description 全站主题偏好与首屏主题初始化契约。
 * @logic 校验持久偏好，解析系统主题，将实际主题及偏好写入文档根节点。
 * @dependencies Browser localStorage, matchMedia, document
 * @index_tags theme, preference, bootstrap
 * @author holic512
 */
export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export const themeStorageKey = "pipkerops.theme";

// 此函数会序列化为首屏脚本，函数体必须只依赖浏览器 API 和参数。
export function applyTheme(
  preference: ThemePreference | undefined,
  storageKey: string,
) {
  let selected: ThemePreference = preference ?? "system";
  if (preference === undefined) {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === "light" || stored === "dark" || stored === "system")
        selected = stored;
    } catch {
      // 浏览器禁止持久存储时仍可跟随系统或在当前页面切换。
    }
  }
  const root = document.documentElement;
  root.dataset.themePreference = selected;
  root.dataset.theme =
    selected === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : selected;
}

export const themeBootstrapScript = `(${applyTheme.toString()})(undefined,${JSON.stringify(themeStorageKey)});`;
