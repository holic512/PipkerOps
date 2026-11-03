import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import {
  applyTheme,
  themeBootstrapScript,
  themeStorageKey,
} from "../src/lib/theme";

test("首屏脚本在渲染前按持久偏好或系统偏好设置主题", () => {
  for (const [saved, dark, preference, expected] of [
    [null, false, "system", "light"],
    [null, true, "system", "dark"],
    ["light", true, "light", "light"],
    ["dark", false, "dark", "dark"],
    ["system", true, "system", "dark"],
    ["invalid", true, "system", "dark"],
  ] as const) {
    const dataset: Record<string, string> = {};
    runInNewContext(themeBootstrapScript, {
      document: { documentElement: { dataset } },
      localStorage: {
        getItem: (key: string) => {
          assert.equal(key, themeStorageKey);
          return saved;
        },
      },
      matchMedia: () => ({ matches: dark }),
    });
    assert.equal(dataset.themePreference, preference);
    assert.equal(dataset.theme, expected);
  }
});

test("存储被禁用时仍可初始化和切换；显式主题不受系统主题影响", () => {
  const dataset: Record<string, string> = {};
  const browser = {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem: () => {
        throw new Error("Storage disabled");
      },
    },
    matchMedia: () => ({ matches: true }),
  };
  runInNewContext(themeBootstrapScript, browser);
  assert.equal(dataset.theme, "dark");
  runInNewContext(
    `(${applyTheme.toString()})("light",${JSON.stringify(themeStorageKey)})`,
    browser,
  );
  assert.equal(dataset.themePreference, "light");
  assert.equal(dataset.theme, "light");
  runInNewContext(
    `(${applyTheme.toString()})("system",${JSON.stringify(themeStorageKey)})`,
    browser,
  );
  assert.equal(dataset.themePreference, "system");
  assert.equal(dataset.theme, "dark");
});

const tokens = readFileSync(
  new URL("../src/app/tokens.css", import.meta.url),
  "utf8",
);
const themes: Record<string, Record<string, string>> = {};
for (const [, selector, body] of tokens.matchAll(
  /(:root(?:\[data-theme="dark"\])?)\s*\{([^}]+)\}/g,
))
  themes[selector === ":root" ? "light" : "dark"] = Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [
      key,
      value,
    ]),
  );

test("暗色主题完整覆盖亮色主题的颜色 Token", () => {
  for (const [key, value] of Object.entries(themes.light))
    if (/#[\da-f]{3,8}\b/i.test(value))
      assert.ok(key in themes.dark, `暗色主题缺少 ${key}`);
});

test("两套主题的常用文字、状态和终端前景达到 AA 对比度", () => {
  const pairs = [
    ["foreground", "background"],
    ["foreground", "card"],
    ["text-secondary", "card"],
    ["muted-foreground", "card"],
    ["text-subtle", "card"],
    ["text-subtle", "background"],
    ["primary", "card"],
    ["primary-foreground", "primary"],
    ["primary-text", "primary-soft"],
    ["danger-foreground", "danger-solid"],
    ["danger-foreground", "danger-hover"],
    ["destructive", "danger-soft"],
    ["success", "success-soft"],
    ["warning", "warning-soft"],
    ["muted-foreground", "muted"],
    ["terminal-foreground", "terminal-background"],
    ["terminal-foreground", "terminal-title"],
    ["terminal-foreground", "terminal-active"],
    ["selection-foreground", "selection"],
  ];
  for (const [name, values] of Object.entries(themes)) {
    for (const [foreground, background] of pairs) {
      const ratio = contrast(
        values[`--${foreground}`],
        values[`--${background}`],
      );
      assert.ok(
        ratio >= 4.5,
        `${name} ${foreground}/${background}: ${ratio.toFixed(2)}`,
      );
    }
    for (const key of ["input-border", "chart-1", "chart-2"])
      assert.ok(
        contrast(values[`--${key}`], values["--card"]) >= 3,
        `${name} ${key}`,
      );
  }
});

test("页面、组件和公共样式不在主题 Token 外写死颜色", () => {
  const files = ["components", "app"].flatMap((name) => {
    const directory = new URL(`../src/${name}/`, import.meta.url);
    return readdirSync(directory, { recursive: true })
      .filter((path) => /\.(tsx|css)$/.test(String(path)))
      .filter((path) => name !== "app" || String(path) !== "tokens.css")
      .map((path) => new URL(String(path), directory));
  });
  for (const file of files)
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i,
      file.pathname,
    );
});

function contrast(first: string, second: string) {
  const luminance = (hex: string) => {
    const rgb = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((part) => {
        const value = Number.parseInt(part, 16) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
