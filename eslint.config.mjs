import { builtinModules } from "node:module";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Generate regex from the runtime's built-in module list to catch bare imports like `import fs from "fs"`.
// This covers all Node.js built-ins (including `constants`, internal `_*` modules, and subpath exports)
// without maintaining a static list.
const _bareBuiltins = builtinModules.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const bareBuiltinPattern = `^(${_bareBuiltins})(/|$)`;

/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigArray} */
export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "coverage/**"] },
  js.configs.recommended,
  tseslint.configs.eslintRecommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Layer boundary: domain must not import from other layers or Node.js built-ins
  {
    files: ["src/domain/**/*.ts"],
    ignores: ["src/domain/**/*.test.ts", "src/domain/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(application|infrastructure|presentation|bootstrap)(\\/|$)",
              message:
                "Domain layer must not import from application, infrastructure, presentation, or bootstrap.",
            },
            {
              regex: "^node:",
              message: "Domain layer must not import Node.js built-in modules.",
            },
            {
              regex: bareBuiltinPattern,
              message: "Domain layer must not import Node.js built-in modules (bare name).",
            },
          ],
        },
      ],
    },
  },

  // Layer boundary: application must not import from infrastructure, presentation, or bootstrap
  {
    files: ["src/application/**/*.ts"],
    ignores: ["src/application/**/*.test.ts", "src/application/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(infrastructure|presentation|bootstrap)(\\/|$)",
              message:
                "Application layer must not import from infrastructure, presentation, or bootstrap.",
            },
          ],
        },
      ],
    },
  },

  // Layer boundary: presentation must not import from domain, infrastructure, or bootstrap
  {
    files: ["src/presentation/**/*.ts"],
    ignores: ["src/presentation/**/*.test.ts", "src/presentation/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(domain|infrastructure|bootstrap)(\\/|$)",
              message:
                "Presentation layer must not import from domain, infrastructure, or bootstrap.",
            },
          ],
        },
      ],
    },
  },

  // Layer boundary: infrastructure must not import from presentation or bootstrap
  {
    files: ["src/infrastructure/**/*.ts"],
    ignores: ["src/infrastructure/**/*.test.ts", "src/infrastructure/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(presentation|bootstrap)(\\/|$)",
              message: "Infrastructure layer must not import from presentation or bootstrap.",
            },
          ],
        },
      ],
    },
  },
);
