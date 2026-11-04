import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import ts from "eslint-config-next/typescript";
import ui from "./scripts/eslint-ui-rules.mjs";
export default defineConfig([
  ...next,
  ...ts,
  {
    files: [
      "src/app/**/*.tsx",
      "src/components/**/*.tsx",
      "docs/examples/**/*.tsx",
    ],
    plugins: { ui },
    rules: {
      "ui/no-secondary-library": "error",
      "ui/no-raw-colors": "error",
    },
  },
  {
    files: [
      "src/app/**/*.tsx",
      "src/components/**/*.tsx",
      "docs/examples/**/*.tsx",
    ],
    ignores: ["src/components/ui/**"],
    rules: {
      "ui/no-native-controls": "error",
      "ui/no-direct-primitives": "error",
    },
  },
  globalIgnores([
    ".next/**",
    "src/generated/**",
    "agent/**",
    ".data/**",
    "next-env.d.ts",
  ]),
]);
