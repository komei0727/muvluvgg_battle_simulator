# CLAUDE.md

## コマンド実行ルール

このプロジェクトは [mise](https://mise.jdx.dev/) でランタイムバージョンを管理している。
`node` と `pnpm` はシステムの PATH に存在しないため、**必ず `mise exec --` を前置して実行すること。**

```bash
# 正しい実行方法
mise exec -- node --version
mise exec -- pnpm install
mise exec -- pnpm run test

# 誤り（mise なしでは command not found になる）
node --version
pnpm install
```

## mise タスク

`mise.toml` に以下のタスクが定義されている。品質チェックはこれらを使うこと。

| タスク                    | 説明                                                 |
| ------------------------- | ---------------------------------------------------- |
| `mise run install`        | `pnpm install --frozen-lockfile`                     |
| `mise run typecheck`      | TypeScript 型検査 (`tsc --noEmit`)                   |
| `mise run lint`           | ESLint (`eslint . --max-warnings=0`)                 |
| `mise run format-check`   | Prettier フォーマット確認                            |
| `mise run test`           | Vitest 全テスト実行                                  |
| `mise run build`          | TypeScript ビルド (`tsc -p tsconfig.json`)           |
| `mise run check-circular` | 循環依存検査 (`madge --circular ...`)                |
| `mise run check`          | 上記すべての品質チェックをまとめて実行               |
| `mise run dev`            | 開発サーバー起動 (install → `tsx watch src/main.ts`) |

## ツールバージョン

`mise.toml` で固定されているバージョン:

- **Node.js**: 24.18.0
- **pnpm**: 11.8.0

## プロジェクト概要

- **言語**: TypeScript 6.x (ESM, NodeNext モジュール解決)
- **テスト**: Vitest 4.x
- **Lint**: ESLint 10.x + typescript-eslint 8.x
- **フォーマット**: Prettier 3.x

## レイヤー構成

```
src/
  domain/          # ドメインロジック (Node.js 組み込みモジュール禁止)
  application/     # アプリケーションユースケース
  infrastructure/  # 外部依存の実装
  presentation/    # HTTP ハンドラなど
  bootstrap/       # Composition Root
  __tests__/       # レイヤー横断テスト
```

レイヤー間の禁止依存は ESLint (`no-restricted-imports`) で強制されている。
