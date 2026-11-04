/**
 * @file eslint-ui-rules.mjs
 * @project PipkerOps
 * @module tooling/ui-policy
 * @description 约束业务控件复用、基础原语依赖方向及主题色使用。
 * @logic ESLint 检查 JSX 与模块导入；仅特殊业务按钮可用具体字面理由声明原生例外。
 * @dependencies ESLint AST and flat configuration
 * @index_tags eslint, ui, shadcn, design-tokens
 * @author holic512
 */
const controls = new Map([
  ["button", "Button / TabsTrigger"],
  ["input", "Input / Checkbox"],
  ["select", "NativeSelect"],
  ["textarea", "Textarea"],
  ["table", "DataTable"],
  ["details", "Popover / DropdownMenu"],
  ["summary", "PopoverTrigger / DropdownMenuTrigger"],
]);

/** @type {import("eslint").Rule.RuleModule} */
const noNativeControls = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      control:
        "业务层请复用 {{replacement}}，不要直接实现 <{{tag}}>。组件索引见 docs/UI_COMPONENTS.md。",
      reason:
        "data-ui-native 只允许用于特殊业务 <button>，理由必须是超过 8 个字符的非空字面字符串。",
      role: '不要用 <{{tag}} role="{{role}}"> 模拟基础交互，请使用公共 UI 组件。',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;
        const exception = attribute(node, "data-ui-native");
        const validException =
          tag === "button" &&
          exception?.value?.type === "Literal" &&
          typeof exception.value.value === "string" &&
          exception.value.value.trim().length > 8;
        if (exception && !validException)
          context.report({ node: exception, messageId: "reason" });
        if (controls.has(tag) && !validException)
          context.report({
            node,
            messageId: "control",
            data: { tag, replacement: controls.get(tag) },
          });
        const role = attribute(node, "role");
        const value = literalAttributeValue(role);
        if (
          ["div", "span"].includes(tag) &&
          ["button", "dialog", "menu"].includes(value)
        )
          context.report({
            node,
            messageId: "role",
            data: { tag, role: value },
          });
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noDirectPrimitives = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      import:
        "业务层不得直接引入 {{source}}；请从 @/components/ui 使用本地封装。",
    },
  },
  create(context) {
    return moduleSources((source, node) => {
      if (/^@radix-ui\//.test(source))
        context.report({ node, messageId: "import", data: { source } });
    });
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noSecondaryLibrary = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      import: "{{source}} 会引入第二套 UI 体系；请扩展现有 shadcn/ui 组件。",
    },
  },
  create(context) {
    return moduleSources((source, node) => {
      if (
        /^(?:antd|react-bootstrap|bootstrap|semantic-ui-react|primereact|daisyui|flowbite(?:-react)?|styled-components)(?:\/|$)|^@(?:ant-design|mui|material-ui|chakra-ui|mantine|nextui-org|heroui|headlessui|fluentui|blueprintjs|arco-design|emotion)\//.test(
          source,
        )
      )
        context.report({ node, messageId: "import", data: { source } });
    });
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noRawColors = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      color:
        "{{utility}} 绕过主题 Token；请使用 bg-card、text-foreground 等语义颜色。",
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (
          node.name.type !== "JSXIdentifier" ||
          node.name.name !== "className"
        )
          return;
        for (const value of classFragments(
          node.value,
          context.sourceCode.visitorKeys,
        )) {
          for (const utility of colorUtilities(value))
            context.report({ node, messageId: "color", data: { utility } });
        }
      },
    };
  },
};

function attribute(node, name) {
  return node.attributes.find(
    (item) => item.type === "JSXAttribute" && item.name.name === name,
  );
}

function literalAttributeValue(node) {
  const value =
    node?.value?.type === "JSXExpressionContainer"
      ? node.value.expression
      : node?.value;
  return value?.type === "Literal" ? value.value : undefined;
}

function moduleSources(check) {
  const source = (node) => {
    if (typeof node.source?.value === "string") check(node.source.value, node);
  };
  return {
    ImportDeclaration: source,
    ExportNamedDeclaration: source,
    ExportAllDeclaration: source,
    ImportExpression: source,
    CallExpression(node) {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        typeof node.arguments[0]?.value === "string"
      )
        check(node.arguments[0].value, node);
    },
  };
}

function* classFragments(node, keys) {
  if (!node) return;
  if (node.type === "Literal" && typeof node.value === "string")
    yield node.value;
  if (node.type === "TemplateElement")
    yield node.value.cooked ?? node.value.raw;
  for (const key of keys[node.type] ?? []) {
    const child = node[key];
    for (const item of Array.isArray(child) ? child : [child])
      if (item) yield* classFragments(item, keys);
  }
}

function* colorUtilities(value) {
  const utilities =
    "(?:bg|text|border(?:-[trblxyse])?|divide(?:-[xy])?|ring(?:-offset)?|outline|shadow|accent|caret|fill|stroke|from|via|to|decoration|placeholder)";
  const palette =
    "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)";
  const rawPalette = new RegExp(
    `(?:^|[\\s:!])(${utilities}-${palette}(?:-\\d{2,3}|-(?=$))?(?:/[^\\s:!]+)?)(?=$|[\\s!])`,
    "g",
  );
  for (const match of value.matchAll(rawPalette)) yield match[1];
  const arbitrary = new RegExp(
    `(?:^|[\\s:!])(${utilities}-\\[([^\\]]+)\\])`,
    "g",
  );
  for (const match of value.matchAll(arbitrary))
    if (
      /#[\da-f]|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/i.test(
        match[2],
      ) ||
      /^(?:color:)?(?:red|blue|green|black|white|orange|yellow|purple|pink|gray|grey|navy|teal|lime|maroon|aqua|fuchsia|olive|silver)$/i.test(
        match[2],
      )
    )
      yield match[1];
}

const uiRules = {
  rules: {
    "no-native-controls": noNativeControls,
    "no-direct-primitives": noDirectPrimitives,
    "no-secondary-library": noSecondaryLibrary,
    "no-raw-colors": noRawColors,
  },
};

export default uiRules;
