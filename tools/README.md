# tools

ローカル専用のPython分析ツール群。[uv](https://docs.astral.sh/uv/) の workspace として、
共通ライブラリ1つと形式ごとのラボ3つを持つ。

| パッケージ                         | import名          | 役割                                                                                                                 |
| ---------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`common/`](common/)               | `mlgg_lab_common` | 陣営に依らない編成・育成モデル、手持ちデータ・ドラフト・編成ライブラリ・Catalog、記述統計、評価APIの実行・保存・再開 |
| [`exercise-lab/`](exercise-lab/)   | `exercise_lab`    | 戦術演習の入力・演習固有統計・入力補助CLI（`exercise-lab`）                                                          |
| [`battle-lab/`](battle-lab/)       | `battle_lab`      | 通常戦闘の対戦入力（両陣営の編成・規定ターン数）と形式固有の検証                                                     |
| [`total-war-lab/`](total-war-lab/) | `total_war_lab`   | 総力戦の対戦入力（両陣営の編成列・出撃順）と形式固有の検証                                                           |

戦闘処理・ステータス計算・育成計算・最終的な編成合法性の判定はAPI（`apps/api/`）の責務であり、
ここでは再実装しない。ラボが持つのは入力の読み込み・育成情報の適用・事前検証と、APIの
リクエストへの変換だけである。事前検証を通っても、最終的に受理するかはAPIが決める。

このディレクトリは pnpm workspace にも CI 品質ゲートにも属さない（後述）。

## セットアップ

uv と Python 3.12 以上が要る。venv と lockfile は workspace に1つずつ（`tools/.venv`・
`tools/uv.lock`）。

```bash
cd tools
uv sync --locked --all-packages
```

ラボのディレクトリ（`tools/exercise-lab/` など）の中から `uv run ...` しても、同じ
workspace の venv を使う。以前の `tools/exercise-lab/.venv` は使われなくなる（不要なら手で消してよい）。

## 依存の向き

```text
exercise-lab ──┐
battle-lab ────┼──▶ mlgg-lab-common
total-war-lab ─┘
```

- 各ラボは `mlgg-lab-common` へ明示的に依存する。common からラボへ、ラボ同士の依存は持たない。
- 各パッケージは自分がimportするライブラリをすべて実行時依存に書く。workspace の venv には
  全パッケージの依存が入っているので、宣言漏れはテストが通っても気づけない。
- 統計用の `numpy` は common の追加依存 `statistics`（`mlgg-lab-common[statistics]`）に分けてある。
  入力だけを使うラボ（通常戦闘・総力戦）へは持ち込まない。学習・探索の重いライブラリは置かない。
- CLIのコマンド名はラボ名を接頭辞にする（`exercise-lab`）。workspace は1つの venv へ全ラボの
  コマンドを入れるため、共通名だと後から入ったラボのコマンドが黙って上書きする。

境界は2段で確かめる。

- `tests/test_package_boundaries.py` — ソースのimportと `pyproject.toml` の宣言を突き合わせる
  （宣言漏れ・common→ラボ・ラボ同士の依存・コマンド名の衝突）
- `scripts/check-isolated-installs.sh` — パッケージごとに使い捨ての venv を作り、宣言した依存
  だけで実際にインストール・importできるかを見る（`uv.lock` の版に固定する）

## 入力の流れ

```text
対戦入力ファイル（YAML） / UIドラフト / 編成ライブラリ
  + 手持ちデータ（mlgg:player-data）
  + Catalog
    → 読み込み → 手持ちデータの適用 → 共通・形式別の検証 → 解決済みの対戦入力
```

解決済みの対戦入力（`Resolved*Input`）は、実際に評価する編成・育成条件を自己完結で持つ。
`to_request()` でAPIの対戦条件部分（`options` を除く）を作り、`dump_*` / `load_*` でJSONへ
往復できる。元ファイルを読み直さずに確認・再読み込みでき、再読み込み後も送信内容は変わらない。
元ファイルのパス・警告・検証に使ったCatalogの版は `provenance` に対戦条件とは別に残す。

意味の保持:

- ユニット・メモリー・総力戦の編成は書いた順のまま送り、並べ替えない。
- 強化指定の省略（`academyLevels` なし、`gears` 未記入）と空の指定（`academyLevels: {}`、`gears: []`）を区別する。
- 参加枠は定義IDではなく `(side, formationNumber, unitIndex)` で区別する（同じユニットを複数枠へ
  置ける・総力戦の再登場があるため）。評価APIの試行結果と同じ組である。
- 値はAPIの単位で持つ。手持ちデータのモジュール補正（パーセント表記）は取り込み時に1回だけ小数へ
  変換し、適用済みの編成へもう一度適用しても変わらない。

| 形式     | ラボ            | 対戦条件                          | 形式固有の検証                                                       |
| -------- | --------------- | --------------------------------- | -------------------------------------------------------------------- |
| 戦術演習 | `exercise-lab`  | 味方編成・演習対象（敵1体と配置） | 敵ちょうど1体・敵メモリーなし・敵は `EXERCISE_ENEMY`（R-TEX-01／11） |
| 通常戦闘 | `battle-lab`    | 両陣営の編成・規定ターン数        | ターン数1～99（R-FRM-05）・両陣営 `PLAYABLE`（R-TEX-11 #3）          |
| 総力戦   | `total-war-lab` | 両陣営の編成列（出撃順）          | 各1～3編成・1編成内の重複禁止（別編成への再登場は可）（R-TWR-01）    |

## データの置き場所

```text
tools/
  data/                                  # 個人データ・生成物（gitignore 済み）
    inputs/
      drafts/                            # UIから取り出した編成JSON
      formations/                        # import-draft で変換した編成YAML（編成ライブラリ）
      player-data/                       # UIから取り出した育成JSON
    evaluations/
      <evaluation-id>/
        manifest.json                    # 実行概要（確認用の写し）
        evaluation.sqlite3               # 計画・入力・要求履歴・結果の正本
  exercise-lab/configs/                  # 演習の設定・共有サンプル
  battle-lab/configs/                    # 通常戦闘の設定・共有サンプル
  total-war-lab/configs/                 # 総力戦の設定・共有サンプル
```

- `configs/` は `*.example.yaml`（共有サンプル）だけを追跡し、個人の設定は gitignore してある。
  テストの fixture は各パッケージの `tests/` にある。どちらも個人ファイルなしで動く。
- `data/inputs/` は**推奨の置き場所であって必須ではない**。従来の置き場所
  （`exercise-lab/local_storage/`・`exercise-lab/configs/formations/`）もそのまま入力パスに使える。
- `data/inputs/`（入力の整理）と `data/evaluations/`（実行ごとの保存）は別の責務である。評価実行は
  計画を作った時点の入力をDBへ写すので、`data/inputs/` を後から書き換えても実行中の評価は変わらない。

### 入力の運用

1. 編成: UIで配置 → DevTools で `copy(localStorage.getItem("mlgg:last-draft:exercise"))`
   （通常戦闘は `mlgg:last-draft`、総力戦は `mlgg:last-draft:total-war`）→ `data/inputs/drafts/<名前>.json`
   として保存 → `exercise-lab import-draft data/inputs/drafts/<名前>.json --library -o data/inputs/formations/<id>.yaml`
   で編成YAMLにする（通常戦闘・総力戦のドラフトは評価設定の `draft:` からそのまま読める）
2. 育成: `copy(localStorage.getItem("mlgg:player-data"))` の中身を
   `data/inputs/player-data/player-data.json` へ**そのまま**保存する（YAML変換・手での書き換えは不要）
3. 評価設定（後述）から、編成YAML・育成JSON・対戦条件・試行条件を参照する

### 既存データの移行

従来の置き場所にある入力を `data/inputs/` へ写す。元ファイルは消さず、同名のファイルは上書きしない
（同じ内容なら何もせず、違う内容なら衝突として報告する）。JSONは中身で育成JSONかドラフトかを見分ける。

```bash
cd tools
uv run python -m mlgg_lab_common.inputs.migration            # 計画だけを表示する
uv run python -m mlgg_lab_common.inputs.migration --apply    # 写して、移行前後の解決結果の一致を検証する
```

| 移行元                                   | 写し先                     |
| ---------------------------------------- | -------------------------- |
| `<lab>/local_storage/**/*.json`（育成）  | `data/inputs/player-data/` |
| `<lab>/local_storage/**/*.json`（編成）  | `data/inputs/drafts/`      |
| `exercise-lab/configs/formations/*.yaml` | `data/inputs/formations/`  |

従来の設定ファイル（`exercise-lab/configs/*.yaml`）は編成ライブラリをIDで参照し、ファイルパスを
持たないので書き換えは要らない。写した後で `--formations-dir` / `formationsDir` を新しい置き場所へ
向ければよい。

## 評価の実行（共通基盤）

評価API（`POST /api/v1/battle-evaluations`・`/total-war-evaluations`）の分割実行・保存・再開は
`mlgg_lab_common` の共通基盤が持ち、各ラボは「評価設定のケース1件 → 解決済み入力」だけを持つ。

```text
評価設定（YAML）
  → 各ラボで入力を解決（編成YAML・ドラフト + 育成JSON）
  → 試行計画（解決済み入力・送信する対戦条件・参加枠・seed・試行番号）を確定
  → data/evaluations/<id>/evaluation.sqlite3 へ保存
  → 結果の無い試行を上限に合わせて分割して送信 → 応答を検証・保存 → 繰り返す
```

| モジュール            | 役割                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `api.contracts`       | 要求・応答の型、形式ごとの契約（試行の型・既定の上限）、応答の検証 |
| `api.client`          | HTTP通信（`Authorization: Bearer`）と失敗の分類                    |
| `evaluation.config`   | 評価設定の読み込み（パスは設定ファイル基準）と計画の作成           |
| `evaluation.plan`     | 試行計画の作成・検証                                               |
| `evaluation.identity` | 対戦条件・試行・観測値の識別（ハッシュ）                           |
| `evaluation.batching` | 要求の分割                                                         |
| `evaluation.budget`   | 計画・送信・完了の件数と送信予算                                   |
| `evaluation.runner`   | 実行・部分応答・再送・停止・再開                                   |
| `storage.repository`  | 保存・検索のインターフェース                                       |
| `storage.sqlite`      | SQLite実装                                                         |
| `storage.migrations`  | DB保存形式のバージョンと移行                                       |
| `storage.layout`      | 評価実行のディレクトリと `manifest.json`                           |

利用者向けのコマンド（`evaluate` / `resume` / `summarize` / `export`）は後続の段階で各ラボへ足す。
今は次のように呼ぶ（devサーバーは `EVALUATION_ENDPOINT_ENABLED=true` で起動する）。

```python
from pathlib import Path

from battle_lab.evaluation import plan_battle_evaluation
from mlgg_lab_common.api.client import EvaluationHttpClient
from mlgg_lab_common.evaluation.runner import run_evaluation
from mlgg_lab_common.storage.layout import create_evaluation, open_evaluation, write_manifest

plan = plan_battle_evaluation(Path("battle-lab/configs/evaluation.example.yaml"))
directory, repo = create_evaluation(Path("data/evaluations"), plan)
with repo, EvaluationHttpClient(plan.settings.base_url, access_key=None) as client:
    report = run_evaluation(repo, client)  # 途中で止まっても状態はDBに残る
    write_manifest(directory, repo)
print(report.stop_reason, report.counters)

# 再開: 同じDBを開いてもう一度呼ぶだけ。元のYAML・JSONは読み直さない。
with open_evaluation(directory) as repo, EvaluationHttpClient(plan.settings.base_url) as client:
    run_evaluation(repo, client)
```

### 評価設定

[`battle-lab/configs/evaluation.example.yaml`](battle-lab/configs/evaluation.example.yaml)・
[`total-war-lab/configs/evaluation.example.yaml`](total-war-lab/configs/evaluation.example.yaml) を写して使う。
キーの一覧は `mlgg_lab_common/evaluation/config.py` の先頭にある。

- パスは**設定ファイルの位置を基準**に解決する（絶対パスも可）。実行ディレクトリに依らない。
- ケースは `match:`（対戦入力YAML）か `draft:`（UIドラフト）のどちらか、試行は `runs:`（件数、`runStart` で開始番号）
  か `runIndices:`（番号の列、不連続でよい）のどちらかを書く。
- `api.maxCasesPerRequest` / `maxRunsPerRequest` は配備の上限以下にする。省略時は形式ごとのAPI既定値
  （通常戦闘 64 / 300、総力戦 32 / 120）。全形式に同じ値を仮定しない。
- `budget.maxSubmittedRuns` は再送込みの送信試行数の上限で、必須。

### 不変条件

- **試行の同一性**は「形式・送信する対戦条件・seed・試行番号」と実行環境で決まる。ケースID・要求番号・
  分割位置は混ぜない（分け方やケース順を変えても同じ試行は同じ結果になる）。同じ対戦条件を別のケースIDで
  並べても、別のケースとして両方残す。
- 計画は解決済み入力と送信内容を自己完結で持つ。**再開時は元ファイルを読み直さない。**
- 応答は配列の位置でなく `caseId` と `runIndex` で対応づける。要求していない番号・重複・完了と未完了の
  矛盾・参加枠の欠落や取り違えは「応答不整合」として記録して止まる。
- 観測値はAPIが返した試行オブジェクトそのもの（総力戦は勝ち抜き戦全体を1試行とし、引き分け・
  `stages`・`defeatedFormationCounts`・全参加枠の `deployed` / `reappearance` を含む）。勝率・平均などの
  集計は保存しない。
- 通信失敗・未完了・実行エラーは結果として保存しない（敗北・引き分け・スコア0へ変換しない）。

### 再開・予算・停止

| 停止理由                                | 起こる場面                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `COMPLETED`                             | すべての試行に結果がある                                                            |
| `BUDGET_EXHAUSTED`                      | 送信予算を使い切った（保存済みの状態はそのまま）                                    |
| `REQUEST_LIMIT_REACHED`                 | `run_evaluation(max_requests=...)` の上限に達した                                   |
| `RETRY_LIMIT_REACHED`                   | 再送できる失敗（通信断・429・503混雑・502/504）が `maxRetries` 回を超えて続いた     |
| `NO_PROGRESS_LIMIT_REACHED`             | 1件も完了しない応答が `maxConsecutiveNoProgress` 回続いた                           |
| `INVALID_INPUT`                         | 400/413/415/422（入力不正。再送しない）                                             |
| `EXECUTION_ERROR`                       | 500、503 `EXECUTION_LIMIT_EXCEEDED`（実行ガード）                                   |
| `RESPONSE_INVALID`                      | 応答が契約・要求と対応しない                                                        |
| `ENVIRONMENT_MISMATCH`                  | 保存済みの結果と catalogRevision・engineRevision・seedDerivationVersion・契約が違う |
| `RESULT_CONFLICT`                       | 同じ試行から保存済みと違う観測値が返った                                            |
| `UNAUTHORIZED` / `ENDPOINT_UNAVAILABLE` | 401 / 404（アクセスキー・`EVALUATION_ENDPOINT_ENABLED`）                            |

- **再開**: 結果の無い試行だけを同じseed・試行番号で送り直す。部分応答の完了分は保持し、未完了の番号だけを
  再送する。前回の実行が送信中のまま終わった要求は `ABANDONED` として履歴に残す。
- **応答喪失**: サーバーで実行済みの可能性があるので同条件で再送する。同じ観測値が返れば重複として数えるだけで、
  結果は1試行1件のまま（サーバーでの実行が1回になる保証はしない）。
- **予算**: 計画試行数・送信試行数（再送・未完了分を含む）・完了した固有試行数を分けて数える。送信前に要求を
  DBへ保存して予算を確保するので、送信直後に中断しても上限を超えない。
- **実行環境**: `api.expectedCatalogRevision` / `expectedEngineRevision` を書けば初回から固定する。書かなければ
  最初の成功応答で確定し、以降の要求へ期待revisionとして付ける（違う配備なら実行前に422で止まる）。
  `seedDerivationVersion`・契約は応答で照合する。devサーバーを再起動して `engineRevision` が変われば
  （未コミットの変更や `unresolved+boot.*`）止まるので、新しい評価実行を作り直す。

### DB保存形式

| テーブル         | 内容                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `evaluations`    | 形式・契約・seed・実行設定・予算・確定した実行環境（1行）          |
| `cases`          | ケースID・順序・対戦条件のハッシュ・解決済み入力・送信内容・参加枠 |
| `trials`         | ケース×試行番号（試行の識別ハッシュつき）                          |
| `attempts`       | 要求ごとの本文・原応答・通信エラー・時刻・失敗の分類・件数         |
| `attempt_trials` | 各要求に含めた試行と、その要求での結末（完了／未完了）             |
| `results`        | 完了した試行の観測値（1試行1件。UPDATE/DELETE はトリガーで拒否）   |
| `sessions`       | 実行1回ごとの開始・終了・停止理由                                  |

保存形式のバージョンは `PRAGMA user_version`、このツールのDBかどうかは `PRAGMA application_id` で見分ける。
古い形式は開くときに順に移行し、知らない新しい形式・別のSQLiteファイルは読まずに止める
（`storage/migrations/__init__.py`）。計画（`PLAN_FORMAT_VERSION`）・解決済み入力（`schemaVersion`）・
観測値（`contractId`）もそれぞれ版を持つ。`manifest.json` は確認用の写しで、消えても再開できる。

1つのDBへ複数の実行を同時に走らせない（1プロセスから1つずつ書く前提）。

### 戦術演習

戦術演習の評価API（`/api/v1/tactical-exercise-evaluations`）は、試行番号・`caseId`・`engineRevision` を
持つ形への再設計が済んでいない。旧API向けの互換アダプターは作らない方針なので、評価設定に
`format: TACTICAL_EXERCISE` を書くと `UnsupportedFormatError` で止まる。APIの再設計が済んだら、
`api/contracts.py` に演習の契約（試行の型）を足し、`exercise-lab` に解決手順を足す。

## 開発

```bash
cd tools
uv sync --locked --all-packages
uv run pytest                                  # workspace全体（4パッケージ + 境界・サンプル）
uv run pytest battle-lab                       # 1パッケージだけ
MLGG_LAB_LIVE_API_URL=http://localhost:3917 uv run pytest tests/test_live_evaluation_api.py   # 実API
uv run ruff check .
uv run ruff format --check .
bash scripts/check-isolated-installs.sh        # パッケージ単独のインストール確認
```

実APIのテスト（`tests/test_live_evaluation_api.py`）は `MLGG_LAB_LIVE_API_URL` が無ければskipする。
`apps/api/` で `EVALUATION_ENDPOINT_ENABLED=true PORT=3917 mise exec -- pnpm exec tsx src/main.ts` として
起動したサーバーを相手に、通常戦闘・総力戦の複数ケース・複数試行を「要求を大きく」「細かく分けてケース順を逆に」
「同条件で再実行」の3通りで実行し、意味上の観測値が一致することを確かめる。

テストは各パッケージの `tests/` と、workspace横断の `tests/`（境界・公開サンプル）にある。
ラボのテストは別のラボをimportしない。テスト用のドラフト生成は `mlgg_lab_common.testing` にある。

### 品質ゲートとの関係

`scripts/run-quality-gates.sh`（PR CI）は `tools/` のテストを実行しない。ただし UI の統計表示が
参照実装（`mlgg_lab_common.statistics.descriptive` / `exercise_lab.statistics.daily_best`）から
書き出した fixture を読むため、統計の定義を変えたときは fixture を再生成して `mise run ui:test`
まで通す（手順は [`exercise-lab/README.md`](exercise-lab/README.md)）。fixture と参照実装の一致は
`exercise-lab/tests/test_ui_parity_fixture.py` が検査する。
