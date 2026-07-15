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

| タスク                      | 説明                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `mise run install`          | `pnpm install --frozen-lockfile`                                           |
| `mise run typecheck`        | TypeScript 型検査 (`tsc --noEmit`)                                         |
| `mise run lint`             | ESLint (`eslint . --max-warnings=0`)                                       |
| `mise run format-check`     | Prettier フォーマット確認                                                  |
| `mise run test`             | Unit / Scenario / Contract テスト実行（integration・e2e・load を除く）     |
| `mise run test:coverage`    | 同上 + カバレッジ計測・80% 下限検証（PR CI と同等）                        |
| `mise run test:integration` | Worker・HTTP 統合テスト実行（`*.integration.test.ts`）                     |
| `mise run test:e2e`         | End-to-End テスト実行（`*.e2e.test.ts`）                                   |
| `mise run test:load`        | 負荷・耐久テスト実行（`*.load.test.ts`、タイムアウト 5 分）                |
| `mise run test:container`   | production containerをbuildし、local Docker smoke testを実行（Docker必須） |
| `mise run build`            | TypeScript ビルド (`tsc -p tsconfig.json`)                                 |
| `mise run check-circular`   | 循環依存検査 (`madge --circular ...`)                                      |
| `mise run check`            | typecheck・lint・format-check・test・build・check-circular をまとめて実行  |
| `mise run dev`              | 開発サーバー起動 (install → `tsx watch src/main.ts`、`apps/api/`で実行)    |

### PR 相当のローカル検証

```bash
bash scripts/run-quality-gates.sh
# 実行順: format-check → typecheck → lint → test:coverage → check-circular
#         → ui:typecheck → ui:lint → ui:test → ui:build
```

### テスト区分

| ファイルパターン          | 対応タスク               | CI 実行タイミング       |
| ------------------------- | ------------------------ | ----------------------- |
| `*.test.ts` / `*.spec.ts` | `test` / `test:coverage` | 全 PR・main ブランチ    |
| `*.integration.test.ts`   | `test:integration`       | main ブランチ（実装後） |
| `*.e2e.test.ts`           | `test:e2e`               | main ブランチ（実装後） |
| `*.load.test.ts`          | `test:load`              | nightly / リリース前    |

## ツールバージョン

`mise.toml` で固定されているバージョン:

- **Node.js**: 24.18.0
- **pnpm**: 11.8.0

## プロジェクト概要

- **言語**: TypeScript 6.x (ESM, NodeNext モジュール解決)
- **テスト**: Vitest 4.x
- **Lint**: ESLint 10.x + typescript-eslint 8.x
- **フォーマット**: Prettier 3.x

## リポジトリ構成

pnpm workspaceで `apps/api`（backend）・`apps/ui`（frontend）を独立したpackageとして持つ。ルート `package.json` はworkspace orchestrationと共通development tooling（Prettier）だけを持ち、各scriptは対応するpackageへ委譲する（`pnpm --filter api run ...` / `pnpm --filter ui run ...`）。

## レイヤー構成（`apps/api/src/`）

```
apps/api/src/
  domain/          # ドメインロジック (Node.js 組み込みモジュール禁止)
  application/     # アプリケーションユースケース
  infrastructure/  # 外部依存の実装
  presentation/    # HTTP ハンドラなど
  bootstrap/       # Composition Root
  __tests__/       # レイヤー横断テスト
```

レイヤー間の禁止依存は ESLint (`no-restricted-imports`) で強制されている。
