import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import ui from "../scripts/eslint-ui-rules.mjs";

const linter = new Linter();
function check(code: string, rule: keyof typeof ui.rules) {
  return linter.verify(code, {
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { ui },
    rules: { [`ui/${rule}`]: "error" },
  });
}

test("拒绝原生基础控件和假交互，公共组件及语义布局允许使用", () => {
  for (const tag of [
    "button",
    "input",
    "select",
    "textarea",
    "table",
    "details",
    "summary",
  ]) {
    const messages = check(`const view = <${tag} />`, "no-native-controls");
    assert.equal(messages.length, 1, tag);
    assert.equal(messages[0].messageId, "control");
  }
  for (const tag of ["div", "span"])
    for (const role of ["button", "dialog", "menu"])
      assert.equal(
        check(
          `const view = <${tag} role={"${role}"} />`,
          "no-native-controls",
        )[0].messageId,
        "role",
      );
  assert.deepEqual(
    check(
      `const view = <section><form><fieldset><label><Input /></label><NativeSelect /><Textarea /><Checkbox /><Button /></fieldset></form><DataTable><tr><th scope="row">节点</th><td>在线</td></tr></DataTable><div role="treeitem" /></section>`,
      "no-native-controls",
    ),
    [],
  );
});

test("特殊原生按钮必须用足够具体的字面理由声明，其他控件不允许豁免", () => {
  assert.deepEqual(
    check(
      `const view = <button data-ui-native="节点树拖拽柄需要保留指针拖动布局" />`,
      "no-native-controls",
    ),
    [],
  );
  for (const attribute of [
    'data-ui-native=""',
    'data-ui-native="        "',
    'data-ui-native="12345678"',
    "data-ui-native",
    'data-ui-native={"节点树拖拽柄需要保留指针拖动布局"}',
    "data-ui-native={reason}",
  ]) {
    const messages = check(
      `const view = <button ${attribute} />`,
      "no-native-controls",
    );
    assert.ok(
      messages.some((item) => item.messageId === "reason"),
      attribute,
    );
    assert.ok(
      messages.some((item) => item.messageId === "control"),
      attribute,
    );
  }
  const messages = check(
    `const view = <input data-ui-native="需要直接使用原生输入框作为例外" />`,
    "no-native-controls",
  );
  assert.deepEqual(messages.map((item) => item.messageId).sort(), [
    "control",
    "reason",
  ]);
});

test("业务只能导入本地UI封装，拒绝直接原语与常见第二套UI", () => {
  for (const code of [
    'import { Root } from "@radix-ui/react-dialog";',
    'export { Root } from "@radix-ui/react-dialog";',
    'export * from "@radix-ui/react-dialog";',
    'const module = import("@radix-ui/react-dialog");',
    'const module = require("@radix-ui/react-dialog");',
  ])
    assert.equal(check(code, "no-direct-primitives")[0].messageId, "import");
  assert.deepEqual(
    check(
      'import { Button } from "@/components/ui/button";',
      "no-direct-primitives",
    ),
    [],
  );
  for (const source of [
    "antd",
    "antd/es/button",
    "@mui/material",
    "@chakra-ui/react",
    "@mantine/core",
    "@headlessui/react",
    "@heroui/react",
    "react-bootstrap/Button",
    "flowbite-react",
    "daisyui",
    "primereact/button",
    "styled-components",
    "@emotion/styled",
  ])
    assert.equal(
      check(`import UI from "${source}";`, "no-secondary-library")[0].messageId,
      "import",
      source,
    );
  for (const source of [
    "@radix-ui/react-tabs",
    "lucide-react",
    "@xyflow/react",
  ])
    assert.deepEqual(
      check(`import UI from "${source}";`, "no-secondary-library"),
      [],
    );
});

test("静态、模板与组合类名拒绝原生色板和直接色值，允许语义Token和尺寸", () => {
  for (const code of [
    'const view = <div className="bg-red-500" />;',
    'const view = <div className="dark:hover:text-blue-700/80" />;',
    'const view = <div className="border-white ring-offset-slate-300" />;',
    'const view = <div className={`px-4 ${ready ? "bg-green-500" : "bg-red-500"}`} />;',
    "const view = <div className={`bg-blue-${shade}`} />;",
    'const view = <div className={cn("text-rose-700", active && "bg-gray-100")} />;',
    'const view = <div className="bg-[#123456]" />;',
    'const view = <div className="text-[oklch(0.5_0.1_120)]" />;',
    'const view = <div className="border-[rgb(0_0_0)]" />;',
    'const view = <div className="bg-[red]" />;',
  ]) {
    const messages = check(code, "no-raw-colors");
    assert.ok(messages.length > 0, code);
    assert.ok(
      messages.every((item) => item.messageId === "color"),
      code,
    );
  }
  assert.deepEqual(
    check(
      'const view = <div className={cn("bg-card text-foreground hover:bg-primary/10 border-border ring-ring", `p-4 text-[14px] border-[1px] w-[240px] ${active ? "text-primary" : "text-muted-foreground"}`, "bg-[var(--card)]")} />;',
      "no-raw-colors",
    ),
    [],
  );
});

test("真实ESLint配置对业务fixture报错，基础UI层保留原生及Radix能力", async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const eslint = new ESLint({ cwd });
  const [business] = await eslint.lintText(
    'import { Root } from "@radix-ui/react-dialog"; export default function Example() { return <button className="bg-red-500" />; }',
    { filePath: "src/components/__ui-policy-fixture.tsx" },
  );
  for (const rule of [
    "ui/no-native-controls",
    "ui/no-direct-primitives",
    "ui/no-raw-colors",
  ])
    assert.ok(
      business.messages.some((item) => item.ruleId === rule),
      rule,
    );
  const [example] = await eslint.lintText(
    "export default function Example() { return <input />; }",
    { filePath: "docs/examples/__ui-policy-fixture.tsx" },
  );
  assert.ok(
    example.messages.some((item) => item.ruleId === "ui/no-native-controls"),
  );
  const [primitive] = await eslint.lintText(
    'import * as Dialog from "@radix-ui/react-dialog"; export const DialogRoot = Dialog.Root; export function Input() { return <input />; }',
    { filePath: "src/components/ui/__ui-policy-fixture.tsx" },
  );
  assert.deepEqual(
    primitive.messages.filter((item) => item.ruleId?.startsWith("ui/")),
    [],
  );
  const [alternate] = await eslint.lintText(
    'import Button from "@mui/material/Button"; export { Button };',
    { filePath: "src/components/ui/__ui-policy-fixture.tsx" },
  );
  assert.ok(
    alternate.messages.some(
      (item) => item.ruleId === "ui/no-secondary-library",
    ),
  );
});
