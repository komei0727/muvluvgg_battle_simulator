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

  // Module boundary (`#132`, 04_境界づけられたコンテキスト.md「モジュール依存規則」):
  // catalog must not depend on formation or battle.
  {
    files: ["src/domain/catalog/**/*.ts"],
    ignores: ["src/domain/catalog/**/*.test.ts", "src/domain/catalog/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(formation|battle)(\\/|$)",
              message: "domain/catalog must not depend on domain/formation or domain/battle.",
            },
          ],
        },
      ],
    },
  },

  // Module boundary: formation depends only on battle/model among battle/* submodules.
  {
    files: ["src/domain/formation/**/*.ts"],
    ignores: ["src/domain/formation/**/*.test.ts", "src/domain/formation/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)battle\\/(?!model(\\/|$))",
              message: "domain/formation must depend only on domain/battle/model.",
            },
          ],
        },
      ],
    },
  },

  // Module boundary: one self-contained block per battle/* submodule, each listing every
  // sibling it must not depend on. Flat config replaces (rather than merges) `rules` for
  // configs whose `files` glob matches the same file, so a submodule's forbidden-import
  // list must live entirely in the block scoped to that submodule — spreading a ban across
  // multiple overlapping "src/domain/battle/**" blocks lets a later, more specific block
  // silently discard an earlier one's patterns for the same rule.
  //
  // Forbidden lists follow the one-directional chain fixed by 04_境界づけられたコンテキスト.md
  // 「モジュールの依存順序」: model → outcome/targeting → action/skill → events → combat →
  // lifecycle, and model → formation (formation depends on model; nothing in battle/* may
  // depend back on formation).
  {
    files: ["src/domain/battle/model/**/*.ts"],
    ignores: ["src/domain/battle/model/**/*.test.ts", "src/domain/battle/model/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "(^|.+\\/)(outcome|targeting|action|skill|events|combat|lifecycle|triggering|effects|formation)(\\/|$)",
              message:
                "domain/battle/model must not depend on any other domain/battle/* submodule or on domain/formation.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/outcome/**/*.ts"],
    ignores: ["src/domain/battle/outcome/**/*.test.ts", "src/domain/battle/outcome/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "(^|.+\\/)(targeting|action|skill|events|combat|lifecycle|triggering|effects|formation)(\\/|$)",
              message: "domain/battle/outcome must depend only on domain/battle/model.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/targeting/**/*.ts"],
    ignores: [
      "src/domain/battle/targeting/**/*.test.ts",
      "src/domain/battle/targeting/**/*.spec.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "(^|.+\\/)(outcome|action|skill|events|combat|lifecycle|triggering|effects|formation)(\\/|$)",
              message: "domain/battle/targeting must depend only on domain/battle/model.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/action/**/*.ts"],
    ignores: ["src/domain/battle/action/**/*.test.ts", "src/domain/battle/action/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "(^|.+\\/)(outcome|skill|events|combat|lifecycle|triggering|effects|formation)(\\/|$)",
              message:
                "domain/battle/action must depend only on domain/battle/model and domain/battle/targeting.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/skill/**/*.ts"],
    ignores: ["src/domain/battle/skill/**/*.test.ts", "src/domain/battle/skill/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "(^|.+\\/)(outcome|action|events|combat|lifecycle|triggering|effects|formation)(\\/|$)",
              message:
                "domain/battle/skill must depend only on domain/battle/model and domain/battle/targeting.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/events/**/*.ts"],
    ignores: ["src/domain/battle/events/**/*.test.ts", "src/domain/battle/events/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(combat|lifecycle|triggering|effects|formation)(\\/|$)",
              message:
                "domain/battle/events must not depend on combat, lifecycle, triggering, effects, or formation.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/combat/**/*.ts"],
    ignores: ["src/domain/battle/combat/**/*.test.ts", "src/domain/battle/combat/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(outcome|action|lifecycle|triggering|effects|formation)(\\/|$)",
              message:
                "domain/battle/combat must depend only on domain/battle/model, domain/battle/skill, domain/battle/targeting, and domain/battle/events; it must not depend on domain/battle/effects.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/effects/**/*.ts"],
    ignores: ["src/domain/battle/effects/**/*.test.ts", "src/domain/battle/effects/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(combat|lifecycle|formation)(\\/|$)",
              message:
                "domain/battle/effects must not depend on domain/battle/combat (mutual ban), domain/battle/lifecycle, or domain/formation.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/triggering/**/*.ts"],
    ignores: [
      "src/domain/battle/triggering/**/*.test.ts",
      "src/domain/battle/triggering/**/*.spec.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)(lifecycle|formation)(\\/|$)",
              message:
                "domain/battle/triggering must not depend on domain/battle/lifecycle or domain/formation.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/battle/lifecycle/**/*.ts"],
    ignores: [
      "src/domain/battle/lifecycle/**/*.test.ts",
      "src/domain/battle/lifecycle/**/*.spec.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|.+\\/)formation(\\/|$)",
              message:
                "domain/battle/lifecycle must not depend on domain/formation (reverse dependency).",
            },
          ],
        },
      ],
    },
  },
);
