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

| タスク                      | 説明                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `mise run install`          | `pnpm install --frozen-lockfile`                                                     |
| `mise run typecheck`        | TypeScript 型検査 (`tsc --noEmit`)                                                   |
| `mise run lint`             | ESLint (`eslint . --max-warnings=0`)                                                 |
| `mise run format-check`     | Prettier フォーマット確認                                                            |
| `mise run test`             | Unit / Scenario / Contract テスト実行（integration・e2e・load を除く）               |
| `mise run test:coverage`    | 同上 + カバレッジ計測・80% 下限検証（PR CI と同等）                                  |
| `mise run test:integration` | Worker・HTTP 統合テスト実行（`*.integration.test.ts`）                               |
| `mise run test:e2e`         | End-to-End テスト実行（`*.e2e.test.ts`）                                             |
| `mise run test:load`        | 負荷・耐久テスト実行（`*.load.test.ts`、タイムアウト 5 分）                          |
| `mise run test:container`   | production containerをbuildし、local Docker smoke testを実行（Docker必須）           |
| `mise run build`            | TypeScript ビルド (`tsc -p tsconfig.json`)                                           |
| `mise run check-circular`   | 循環依存検査 (`madge --circular ...`)                                                |
| `mise run ci:test`          | CI変更判定ロジックのテスト (`scripts/ci/*.test.mjs`)                                 |
| `mise run ui:typecheck`     | apps/ui の TypeScript 型検査                                                         |
| `mise run ui:lint`          | apps/ui の ESLint                                                                    |
| `mise run ui:test`          | apps/ui の unit / component テスト (Vitest)                                          |
| `mise run ui:build`         | apps/ui の production ビルド (Vite)                                                  |
| `mise run ui:e2e`           | apps/ui の Playwright E2E スモーク（`@visual` 除外。どのOSでも実行可）               |
| `mise run ui:e2e:visual`    | apps/ui の visual regression（`@visual` のみ。baseline は Linux 専用 → CI 実行前提） |
| `mise run ui:e2e:live`      | デプロイ済み Pages / Cloud Run への live smoke（`LIVE_PAGES_URL` 等が必須）          |
| `mise run ui:dev`           | apps/ui の Vite 開発サーバー起動（port 5173、API は `mise run dev` と併用）          |
| `mise run check`            | api + ui の typecheck・lint・test・build 等をまとめる**軽量チェック**（下記参照）    |
| `mise run dev`              | 開発サーバー起動 (install → `tsx watch src/main.ts`、`apps/api/`で実行)              |

### 品質ゲートの正本: `scripts/run-quality-gates.sh`

PR 相当のローカル検証の**正本は `scripts/run-quality-gates.sh` の1つだけ**。PR CI
（`.github/workflows/pr.yml`）と同じチェックを同じ job 順で実行する。

```bash
bash scripts/run-quality-gates.sh
# changes:   format-check → ci:test
# quality:   typecheck → lint → test:coverage → check-circular
# container: test:container（Docker 必須 — daemon 未起動なら冒頭で fail する）
# ui:        ui:typecheck → ui:lint → ui:test → ui:build
#            → playwright install chromium → ui:e2e
#            → ui:e2e:visual（Linux のみ。baseline が Linux 専用のため他OSではskip）
```

前提: Docker daemon が起動していること。Playwright Chromium はスクリプトが自動インストールする
（Linux では PR CI と同じ `--with-deps` で OS 依存ライブラリも導入する。CI 外では sudo を求められることがある）。

`mise run check` は coverage・container・e2e を含まない**開発中の軽量チェック**であり、
PR CI の再現ではない。`.claude/skills/muvluvgg-implement-issue/scripts/run-quality-gates.sh`
は正本スクリプトへの委譲ラッパーで、ゲート定義は持たない。

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

workspace以外の主なディレクトリ:

- `deploy/` — GCP デプロイ定義（`artifact-registry/` `cloud-build/` `cloud-run/`）
- `raw/` — wiki 由来のユニット・メモリー原文マークダウン（`units/` `memories/`。Catalog 生成の入力）
- `docs/` — DDD 設計書（`docs/ddd/`）・UI 設計書ほか
- `scripts/` — 品質ゲート正本 (`run-quality-gates.sh`)・CI 変更判定 (`ci/`)・コンテナ smoke test

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

## 構成（`apps/ui/src/`）

React + Vite。機能単位の features スライスで構成する。

```
apps/ui/src/
  app/         # アプリのルート (BattleSimulatorApp / BattleSimulatorPage)
  features/    # 機能スライス (catalog-selection / formation / simulation / details / summary)
  components/  # 汎用UIコンポーネント (AppShell, Button, Dialog, Panel, Tabs など)
  lib/         # 共有ユーティリティ (env, aptitude, build-info)
  assets/      # ユニット・メモリー画像
  styles/      # global.css / tokens.css (デザイントークン)
  test/        # Vitest セットアップ
```

テストは対象と同じディレクトリに `*.test.ts(x)` を同居させる。E2E は `apps/ui/e2e/` に置く。

## コメント規約

コード・設計書のコメントには**制約・理由のみ**を書く。レビュー出典・PR番号・指摘レベルは書かない。

```ts
// 誤: PR #123再レビュー[P1]: null チェックを追加
// 誤: レビュー指摘: 早期returnへ変更
// 正: Catalog 未ロード時に呼ばれ得るため null を許容する
```

「どのレビューで指摘されたか」は git blame / PR 履歴が持つ情報であり、コメントに残さない。

## CI変更判定 (`.github/workflows/`)

`pr.yml`・`main.yml` は常時起動する `changes` job で変更pathを判定し (`scripts/ci/classify-changed-paths.mjs`)、API/UI各jobは `needs.changes.outputs.run_api` / `run_ui` を見て job単位で `if:` skipする。workflow-level の `on.*.paths` filterは使わない — workflow自体が起動しないとrequired checkが `Pending` のまま残るため、job-level skip (`Success/Skipped` 扱い) にしている。判定ロジックは `mise run ci:test` でテストできる。
