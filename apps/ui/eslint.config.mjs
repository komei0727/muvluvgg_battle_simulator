import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Layer boundary (Feature-Sliced Design-based 5-layer model, 02_フロントエンドアーキテクチャ
// 設計.md §5): shared → entities → features → views → modes → app. Nothing may import `app`,
// the composition root. `views`/`modes` do not exist yet (introduced by REF-059); blocks below
// cover only the layers that exist today.
//
// Every `src/<layer>/**` block below must include this pattern, because Flat config replaces
// (rather than merges) `rules` for configs whose `files` glob matches the same file: a
// layer-specific block that omits it would silently reopen the composition-root boundary for
// every file it covers, even though an earlier, more generic block already forbids it.
const compositionRootPattern = {
  regex: "(^|.+\\/)app(\\/|$)",
  message: "must not import from app — app composes the layers below it, not vice versa.",
};

// Builds a `no-restricted-imports` rule entry that always includes `compositionRootPattern` in
// addition to any layer-specific patterns, so every `src/<layer>/**` block stays self-contained
// regardless of `files` glob overlap with other blocks. Mirrors `domainRestrictedImports()` in
// apps/api/eslint.config.mjs.
function layerRestrictedImports(...layerPatterns) {
  return ["error", { patterns: [compositionRootPattern, ...layerPatterns] }];
}

const layerTestIgnores = ["**/*.test.ts", "**/*.test.tsx"];

/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigArray} */
export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "coverage/**", "playwright-report/**"] },
  js.configs.recommended,
  tseslint.configs.eslintRecommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommendedTypeChecked, jsxA11y.flatConfigs.recommended],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
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
  {
    // Local dev tooling (see scripts/sync-character-images.mjs) — runs under
    // Node directly, not bundled by Vite, so it needs Node globals.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },

  // `lib` holds framework-agnostic primitives (formatting, guards, browser utilities) and must
  // not know about any higher layer.
  {
    files: ["src/lib/**/*.ts", "src/lib/**/*.tsx"],
    ignores: layerTestIgnores,
    rules: {
      "no-restricted-imports": layerRestrictedImports({
        regex: "(^|.+\\/)(components|shared|entities|features)(\\/|$)",
        message: "lib must not import from components, shared, entities, or features.",
      }),
    },
  },

  // `components` holds generic, feature-agnostic display primitives (02_フロントエンド
  // アーキテクチャ設計.md §5「componentsはfeature固有型へ依存しない汎用表示部品とする」).
  // May depend on `lib`.
  {
    files: ["src/components/**/*.ts", "src/components/**/*.tsx"],
    ignores: layerTestIgnores,
    rules: {
      "no-restricted-imports": layerRestrictedImports({
        regex: "(^|.+\\/)(shared|entities|features)(\\/|$)",
        message: "components must not import from shared, entities, or features.",
      }),
    },
  },

  // `shared` (including `shared/api`) may depend on `entities` — a documented exception: wire
  // contracts embed entities vocabulary (e.g. `LogLevel`) into HTTP DTOs (§5, §8). `entities`
  // must not depend back on `shared` (enforced by the entities block below).
  {
    files: ["src/shared/**/*.ts", "src/shared/**/*.tsx"],
    ignores: layerTestIgnores,
    rules: {
      "no-restricted-imports": layerRestrictedImports({
        regex: "(^|.+\\/)(components|features)(\\/|$)",
        message: "shared must not import from components or features.",
      }),
    },
  },

  // `entities` holds cross-feature vocabulary only (types and type-tied derivations, no
  // business rules or UI logic; REF-055) and depends on nothing else.
  {
    files: ["src/entities/**/*.ts", "src/entities/**/*.tsx"],
    ignores: layerTestIgnores,
    rules: {
      "no-restricted-imports": layerRestrictedImports({
        regex: "(^|.+\\/)(lib|components|shared|features)(\\/|$)",
        message: "entities must not import from lib, components, shared, or features.",
      }),
    },
  },

  // `features` may depend on entities/shared/lib/components freely. Direct feature-to-feature
  // imports are not yet forbidden here — several intentionally remain (details↔effect-trace,
  // exercise↔exercise-stats, etc.) until REF-059 introduces a views/modes composition layer
  // for them to go through instead.
  {
    files: ["src/features/**/*.ts", "src/features/**/*.tsx"],
    ignores: layerTestIgnores,
    rules: {
      "no-restricted-imports": layerRestrictedImports(),
    },
  },
);
