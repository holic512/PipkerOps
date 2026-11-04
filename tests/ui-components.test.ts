import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { Textarea } from "../src/components/ui/textarea";
import { NativeSelect } from "../src/components/ui/native-select";
import { Checkbox } from "../src/components/ui/checkbox";
import { DataTable } from "../src/components/ui/table";
import { ViewTabs } from "../src/components/ui/tabs";

test("Button 默认不提交表单，支持显式提交，链接组合不携带按钮 type", () => {
  assert.match(
    renderToStaticMarkup(createElement(Button, null, "打开详情")),
    /<button\b[^>]*type="button"/,
  );
  assert.match(
    renderToStaticMarkup(createElement(Button, { type: "submit" }, "保存")),
    /<button\b[^>]*type="submit"/,
  );
  const link = renderToStaticMarkup(
    createElement(
      Button,
      { asChild: true, type: "submit" },
      createElement("a", { href: "/nodes" }, "节点管理"),
    ),
  );
  assert.match(link, /<a\b[^>]*href="\/nodes"/);
  assert.doesNotMatch(link, /\btype=/);
  assert.doesNotMatch(link, /<button\b/);
});

test("表单原语保留原生名称、值、选中、禁用及类型化 ref 契约", () => {
  const inputRef = createRef<HTMLInputElement>();
  const textareaRef = createRef<HTMLTextAreaElement>();
  const selectRef = createRef<HTMLSelectElement>();
  const checkboxRef = createRef<HTMLInputElement>();
  const html = renderToStaticMarkup(
    createElement(
      "form",
      null,
      createElement(Input, {
        name: "node",
        value: "node-a",
        readOnly: true,
        required: true,
        ref: inputRef,
      }),
      createElement(Textarea, {
        name: "description",
        defaultValue: "运维节点说明",
        disabled: true,
        ref: textareaRef,
      }),
      createElement(
        NativeSelect,
        { name: "folder", defaultValue: "production", ref: selectRef },
        createElement("option", { value: "test" }, "测试"),
        createElement("option", { value: "production" }, "生产"),
      ),
      createElement(Checkbox, {
        name: "approved",
        value: "yes",
        defaultChecked: true,
        ref: checkboxRef,
      }),
    ),
  );
  const input = html.match(/<input\b[^>]*name="node"[^>]*>/)![0];
  assert.match(input, /value="node-a"/);
  assert.match(input, /readOnly=""/);
  assert.match(input, /required=""/);
  const textarea = html.match(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/)![0];
  assert.match(textarea, /name="description"/);
  assert.match(textarea, /disabled=""/);
  assert.match(textarea, />运维节点说明<\/textarea>/);
  assert.match(html, /<select\b[^>]*name="folder"/);
  assert.match(html, /<option value="production" selected="">生产<\/option>/);
  const checkbox = html.match(/<input\b[^>]*name="approved"[^>]*>/)![0];
  assert.match(checkbox, /type="checkbox"/);
  assert.match(checkbox, /checked=""/);
  assert.match(checkbox, /value="yes"/);
  assert.doesNotMatch(html, /\bref=/);
});

test("DataTable 接受复选框表头，统一滚动区域与列标题且保留行标题", () => {
  const props = {
    label: "节点列表",
    headers: [
      createElement(Checkbox, { "aria-label": "全选节点" }),
      "节点名称",
    ],
    children: createElement(
      "tr",
      null,
      createElement("td", null, createElement(Checkbox, { name: "node-a" })),
      createElement("th", { scope: "row" }, "生产节点"),
    ),
  };
  const html = renderToStaticMarkup(createElement(DataTable, props));
  assert.equal((html.match(/<table\b/g) ?? []).length, 1);
  assert.equal((html.match(/<th scope="col"/g) ?? []).length, 2);
  assert.match(html, /role="region"[^>]*aria-label="节点列表，可横向滚动"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /<thead>[\s\S]*aria-label="全选节点"[\s\S]*<\/thead>/);
  assert.match(html, /<th scope="row">生产节点<\/th>/);
});

test("ViewTabs 关联每个标签与面板，仅渲染当前视图的一份内容", () => {
  for (const value of ["nodes", "metrics"]) {
    const props = {
      label: "节点详情视图",
      value,
      onValueChange: () => {},
      items: [
        { value: "nodes", label: "节点" },
        { value: "metrics", label: "监控" },
      ],
      children: createElement("p", null, `当前视图：${value}`),
    };
    const html = renderToStaticMarkup(createElement(ViewTabs, props));
    const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map(
      (match) => match[0],
    );
    const panels = [...html.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map(
      (match) => match[0],
    );
    assert.equal(tabs.length, 2);
    assert.equal(panels.length, 2);
    assert.equal(
      tabs.filter((tag) => tag.includes('aria-selected="true"')).length,
      1,
    );
    assert.equal(panels.filter((tag) => tag.includes('hidden=""')).length, 1);
    assert.equal((html.match(/当前视图：/g) ?? []).length, 1);
    assert.match(html, /role="tablist"[^>]*aria-label="节点详情视图"/);
    for (const tab of tabs) {
      const target = tab.match(/aria-controls="([^"]+)"/)![1];
      const id = tab.match(/\bid="([^"]+)"/)![1];
      const panel = panels.find((tag) => tag.includes(`id="${target}"`));
      assert.ok(panel?.includes(`aria-labelledby="${id}"`));
    }
  }
});
