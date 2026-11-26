# tools

ローカル専用のPython分析ツール群。[uv](https://docs.astral.sh/uv/) の workspace として、
共通ライブラリ1つと形式ごとのラボ3つを持つ。

| パッケージ                         | import名          | 役割                                                                                                                 |
| ---------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`common/`](common/)               | `mlgg_lab_common` | 陣営に依らない編成・育成モデル、手持ちデータ・ドラフト・編成ライブラリ・Catalog、記述統計、評価APIの実行・保存・再開 |
| [`exercise-lab/`](exercise-lab/)   | `exercise_lab`    | 戦術演習の入力・演習固有統計・入力補助と評価のCLI（`exercise-lab`）                                                  |
| [`battle-lab/`](battle-lab/)       | `battle_lab`      | 通常戦闘の対戦入力（両陣営の編成・規定ターン数）・形式固有の検証・集計と評価のCLI（`battle-lab`）                    |
| [`total-war-lab/`](total-war-lab/) | `total_war_lab`   | 総力戦の対戦入力（両陣営の編成列・出撃順）・形式固有の検証・集計と評価のCLI（`total-war-lab`）                       |

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
  UI統計の参照実装を使わないラボ（通常戦闘・総力戦）へは持ち込まない。学習・探索の重いライブラリは置かない。
- コマンド用の `typer` / `rich` は common の追加依存 `cli`（`mlgg-lab-common[cli]`）に分けてある。
  `mlgg_lab_common.cli` だけが使い、集計・出力（`reporting`）はこれらに依存しない。
- CLIのコマンド名はラボ名を接頭辞にする（`exercise-lab` / `battle-lab` / `total-war-lab`）。workspace は1つの venv へ全ラボの
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
        evaluation.sqlite3.lock          # 実行中だけ保持する排他ロック（ファイルは残ってよい）
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

評価API（`POST /api/v1/tactical-exercise-evaluations`・`/battle-evaluations`・`/total-war-evaluations`）の
分割実行・保存・再開は
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

| `reporting.snapshot` | 評価実行のDBの読み出し（APIへ接続しない） |
| `reporting.status` | 計画・送信・完了・未完了・予算・停止理由 |
| `reporting.summary` | ケース別の記述統計（形式固有の集計は各ラボの `analysis.py`） |
| `reporting.export` | JSONL / CSV / JSON の出力 |
| `statistics.summary` | 要約統計・件数と比率・分布（標準ライブラリだけ） |
| `cli` | 各ラボの評価コマンドの共通部（追加依存 `cli`: typer・rich） |

## 評価コマンド

各ラボの入口（`exercise-lab` / `battle-lab` / `total-war-lab`）に同じコマンドがある。devサーバーは
`apps/api/` で `EVALUATION_ENDPOINT_ENABLED=true mise run dev` のように評価APIを有効にして起動する。

| コマンド                                     | 役割                                                          | APIへの接続 |
| -------------------------------------------- | ------------------------------------------------------------- | ----------- |
| `evaluate <評価設定>`                        | 入力を解決し、計画をDBへ保存して実行する                      | する        |
| `resume <評価実行>`                          | 保存済み計画の結果の無い試行を実行する                        | する        |
| `status <評価実行> [--json]`                 | 計画・送信・完了・未完了の件数、予算、失敗の内訳、停止理由    | しない      |
| `summarize <評価実行> [--case ID]… [--json]` | ケース別の記述統計                                            | しない      |
| `export <評価実行> [--out DIR]`              | `trials.jsonl` / `trials.csv` / `summary.json` / `cases.json` | しない      |

`<評価実行>` は `data/evaluations/<evaluation-id>`（DBファイルそのものを渡してもよい）。他の形式の評価実行は
開かない（`battle-lab` で総力戦のDBを開くと入力エラー）。

| オプション              | コマンド              | 内容                                                                         |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `--evaluations-dir DIR` | `evaluate`            | 保存先。省略時は評価設定の `output.evaluationsDir`（どちらも無ければエラー） |
| `--evaluation-id ID`    | `evaluate`            | 評価実行のID。省略時は日時から作る。既にあるIDはエラー（上書きしない）       |
| `--plan-only`           | `evaluate`            | 計画を保存するだけで送らない（後で `resume`）                                |
| `--max-requests N`      | `evaluate` / `resume` | この実行で送る要求の数の上限（送信予算とは別）                               |
| `--access-key KEY`      | `evaluate` / `resume` | アクセスキー。環境変数 `MLGG_LAB_ACCESS_KEY` でも渡せる。保存しない          |

実行中は要求ごとに「新規完了」「完了した固有試行数/計画試行数」「送信試行数（再送・未完了分を含む）」を
1行ずつ出し、終わると停止理由を出す。`resume` は保存済みの計画（対戦条件・seed・試行番号・接続先・
要求上限・予算）をそのまま使い、評価設定・編成YAML・育成JSONを読み直さない。接続先や予算を変えたい
ときは評価設定を直して新しい評価実行を作る（段階2の契約で、再開時に変えられるのは要求数の上限と
アクセスキーだけ）。

### 終了コード

| コード | 意味                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 成功。`evaluate` / `resume` はすべての試行が完了した                                                                             |
| 1      | 入力・設定・保存先の問題（評価設定の誤り、入力ファイルが無い、評価実行が無い、形式が違う、同じ評価実行を別のプロセスが実行中等） |
| 2      | コマンドの使い方の誤り                                                                                                           |
| 3      | 送信予算（`BUDGET_EXHAUSTED`）・要求数の上限（`REQUEST_LIMIT_REACHED`）で止まった。`resume` で続く                               |
| 4      | 通信・実行・応答・実行環境の問題で止まった（その他の停止理由。`status` で内容を確かめる）                                        |
| 130    | Ctrl-C で中断した。保存済みの結果は残り、`resume` で続く                                                                         |

戦闘結果としての敗北・引き分け・低スコアはエラーではなく、終了コードに影響しない。逆に通信失敗・
実行エラー・未完了は観測結果にならず、`status` の「失敗の内訳」と未完了件数にだけ現れる。

### 操作の流れ（入力準備 → 実行 → 中断/再開 → 集計 → 出力）

```bash
cd tools
# 1. 入力を用意する（「入力の運用」）。演習ドラフトの味方を編成ライブラリにして match YAML から
#    { library: my-team } で参照する。通常戦闘・総力戦のドラフトは評価設定の draft: でそのまま読める。
exercise-lab import-draft data/inputs/drafts/my-team.json --library -o data/inputs/formations/my-team.yaml
cp ~/Downloads/player-data.json data/inputs/player-data/player-data.json   # UIの育成JSONをそのまま

# 2. 評価設定を書く（サンプルを写す。configs/*.yaml はサンプル以外 gitignore 済み）。
cp battle-lab/configs/evaluation.example.yaml battle-lab/configs/my-study.yaml

# 3. 実行する。止まったら（予算・Ctrl-C・通信断）status で理由を見て resume する。
uv run battle-lab evaluate battle-lab/configs/my-study.yaml --evaluation-id my-study
uv run battle-lab status data/evaluations/my-study
uv run battle-lab resume data/evaluations/my-study

# 4. 集計・出力する（APIへ接続しない。何度でも作り直せる）。
uv run battle-lab summarize data/evaluations/my-study
uv run battle-lab export data/evaluations/my-study       # → data/evaluations/my-study/exports/
```

総力戦は `total-war-lab`、戦術演習は `exercise-lab` で同じ手順になる。

### 記述統計（`summarize`）

保存済みの完了結果だけから計算する。新しい試行・API呼び出しは発生しない。

- **ケース別**に出す。異なる相手・条件のケースを合算しない。各ケースに対戦条件（送信順のユニットID・
  メモリー数）・標本数（完了した固有試行数）・計画数・未完了数を添え、全体に実行環境
  （catalog / engine / seedDerivation）と最後の停止理由を添える。
- 未完了・通信失敗・実行エラーは標本に入れない（敗北・スコア0にしない）。完了0件のケースは「集計対象なし」
  （JSONでは `statistics: null`）と表示し、平均・比率を0で埋めない。
- 比率の分母はそのケースの完了した固有試行数。

| 形式     | 表示                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 共通     | 終了理由（`completionReason`）ごとの件数・比率                                                                                                                                        |
| 戦術演習 | スコアの要約、ブレイク回数の要約と回数ごとの分布                                                                                                                                      |
| 通常戦闘 | 勝敗（`ALLY_WIN` / `ALLY_LOSE`）の件数・比率、完了ターンの要約と分布                                                                                                                  |
| 総力戦   | 勝敗・引き分け（`DRAW` は独立した結果）の件数・比率、撃破した/された編成数の分布、編成対戦の数の分布、編成対戦（味方×敵の編成番号）が現れた試行数、参加枠ごとの出撃試行数、完了ターン |

要約は「平均・中央値・標準偏差・最小・最大・p05・p25・p75・p95・件数」。分位点は線形補間
（`numpy.percentile` の既定と同じ。UIの統計表示と同じ定義）、標準偏差は不偏（n−1）で標本1件なら無し。
総力戦は勝ち抜き戦全体を1試行とし、編成対戦（`stages`）を独立した試行として数えない（編成対戦の比率も
分母は試行数）。定義は `mlgg_lab_common/statistics/summary.py` と各ラボの `analysis.py` にあり、
`summary.json` の `definitions` にも載る。集計の定義を変えたら `FormatAnalyzer.statistics_version` を上げる。

勝率・平均スコアは観測結果の要約であり、ここから順位づけ・候補の採否・追加試行は導かない（目的関数・
探索は後続の段階で設計する）。

### エクスポート（`export`）

SQLiteが正本で、出力は同じDBから何度でも同じバイト列で作り直せる派生物（生成時刻を持たない）。
既定の出力先は `<評価実行>/exports/`。出力形式の版は `EXPORT_FORMAT_VERSION`（現在1）。

| ファイル       | 内容                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trials.jsonl` | 完了した試行1件につき1行。`observation` はAPIの試行オブジェクトそのもの（ユニット集計・総力戦の `stages`・`defeatedFormationCounts`・`deployed` / `reappearance`、演習の `allyUnitBreaks` 等を含む） |
| `trials.csv`   | 同じ試行の主要項目の表                                                                                                                                                                               |
| `summary.json` | `summarize --json` と同じ記述統計、出所（評価実行ID・保存形式・実行環境）、各ファイルの説明と列定義                                                                                                  |
| `cases.json`   | ケースごとの送信した対戦条件（`matchRequest`）・解決済み入力（`input`）・試行番号・完了/未完了の番号                                                                                                 |

`trials.jsonl` の各行のキー: `exportFormatVersion`・`evaluationId`・`format`・`contractId`・`caseId`・
`runIndex`・`matchFingerprint`・`trialKey`・`seed`・`catalogRevision`・`engineRevision`・
`seedDerivationVersion`・`observation`。

`trials.csv` の列（左から）:

| 列                                                                                | 形式     | 内容                                                |
| --------------------------------------------------------------------------------- | -------- | --------------------------------------------------- |
| `evaluation_id`・`case_id`・`run_index`                                           | 共通     | 元の評価実行・ケース・試行番号                      |
| `match_fingerprint`・`trial_key`・`seed`                                          | 共通     | 対戦条件（`cases.json` と対応）・試行の識別         |
| `catalog_revision`・`engine_revision`・`seed_derivation_version`                  | 共通     | 実行環境                                            |
| `completion_reason`・`completed_turn`                                             | 共通     | 終了理由・完了ターン                                |
| `total_score`・`break_count`                                                      | 戦術演習 | スコア・ブレイク回数                                |
| `outcome`                                                                         | 通常戦闘 | 勝敗                                                |
| `outcome`・`enemy_defeated_formations`・`ally_defeated_formations`・`stage_count` | 総力戦   | 勝敗・引き分け、撃破した/された編成数、編成対戦の数 |

形式・試行に存在しない値は空欄にし、0や敗北へ変換しない。ユニット単位の集計・編成対戦の履歴など
1行に収まらない詳細は `trials.jsonl` だけが持つ。完了0件・部分完了のときも `trials.*` は完了分だけを
持ち（0件ならCSVは見出し行だけ）、対象件数と未完了の番号は `summary.json` / `cases.json` で分かる。

### Pythonから使う

集計・出力はCLIを経由せずに使える（`mlgg_lab_common.reporting` は typer・rich に依存しない）。

```python
from pathlib import Path

from battle_lab.analysis import ANALYZER
from mlgg_lab_common.reporting import (
    evaluation_status,
    export_evaluation,
    read_evaluation,
    summarize_evaluation,
)

snapshot = read_evaluation(Path("data/evaluations/my-study"))  # DBを読むだけ
status = evaluation_status(snapshot)
summary = summarize_evaluation(snapshot, ANALYZER, case_ids=["mirror"])
export_evaluation(snapshot, ANALYZER, Path("data/evaluations/my-study/exports"))
```

実行・再開もPythonから呼べる（CLIはこれを包んでいる）。

```python
from battle_lab.evaluation import plan_battle_evaluation
from mlgg_lab_common.evaluation.runner import run_evaluation
from mlgg_lab_common.storage.layout import create_evaluation, open_evaluation, write_manifest

plan = plan_battle_evaluation(Path("battle-lab/configs/evaluation.example.yaml"))
directory, repo = create_evaluation(Path("data/evaluations"), plan)
# 接続先・タイムアウトは計画の設定（api.baseUrl / timeoutSeconds）から作る。
# アクセスキーは保存しないので、要る配備では毎回 access_key= で渡す。
with repo, plan.settings.http_client(access_key=None) as client:
    report = run_evaluation(repo, client, on_progress=print)  # 途中で止まっても状態はDBに残る
    write_manifest(directory, repo)

# 再開: 同じDBを開いてもう一度呼ぶだけ。元のYAML・JSONは読み直さない。
with open_evaluation(directory) as repo, repo.load_plan().settings.http_client() as client:
    run_evaluation(repo, client)
```

### 評価設定

[`exercise-lab/configs/evaluation.example.yaml`](exercise-lab/configs/evaluation.example.yaml)・
[`battle-lab/configs/evaluation.example.yaml`](battle-lab/configs/evaluation.example.yaml)・
[`total-war-lab/configs/evaluation.example.yaml`](total-war-lab/configs/evaluation.example.yaml) を写して使う。
`evaluate` が読む（Pythonからは各ラボの `plan_exercise_evaluation` / `plan_battle_evaluation` /
`plan_total_war_evaluation`）。キーの一覧は `mlgg_lab_common/evaluation/config.py` の先頭にある。
サンプルは保存先を `output.evaluationsDir: ../../data/evaluations`（= `tools/data/evaluations/`）にしてある。

- パスは**設定ファイルの位置を基準**に解決する（絶対パスも可）。実行ディレクトリに依らない。
- ケースは `match:`（対戦入力YAML）か `draft:`（UIドラフト）のどちらか、試行は `runs:`（件数、`runStart` で開始番号）
  か `runIndices:`（番号の列、不連続でよい）のどちらかを書く。
- `api.maxCasesPerRequest` / `maxRunsPerRequest` は配備の上限以下にする。省略時は形式ごとのAPI既定値
  （戦術演習 32 / 300、通常戦闘 64 / 300、総力戦 32 / 120）。全形式に同じ値を仮定しない。
- `budget.maxSubmittedRuns` は再送込みの送信試行数の上限で、必須。
- `api.baseUrl` は `http(s)://<ホスト>[:<ポート>]` であることを読み込み時に検証する（計画に保存され、再開時に
  直せないため）。
- `api.baseUrl` / `timeoutSeconds` はクライアントへ渡して初めて効く。`plan.settings.http_client()` で作る
  （`EvaluationHttpClient` を直接作ると既定の120秒になり、長い要求が応答喪失・再送として予算を消費する）。

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
- **実行環境**: `api.expectedCatalogRevision` / `expectedEngineRevision` を書けば初回から固定する（要求に
  付けるだけでなく、初回の応答もこの値と照合し、違えば結果を保存せず止まる）。書かなければ最初の成功応答で確定し、以降の要求へ期待revisionとして付ける（違う配備なら実行前に422で止まる）。
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

1つのDBを実行できるのは同時に1つだけ。`run_evaluation` は実行の間 `evaluation.sqlite3.lock` を排他ロック
（`flock`、POSIXのみ）で保持し、既に別の実行が保持していれば `EvaluationBusyError` で何も送らずに止まる
（CLIは終了コード1）。ロックはプロセスが落ちればOSが外す。

読み出し（`status` / `summarize` / `export`・`read_evaluation`）は実行中でもよい。読み出し全体を1つの
読み取りトランザクションで行うので、件数・結果・実行環境は1時点の値で揃う（その間、実行側のコミットは
待たされる）。最後の実行に停止理由が無いとき、`status` はロックを見て次のどれかを表示する。

| 状態          | 意味                                                                  |
| ------------- | --------------------------------------------------------------------- |
| `RUNNING`     | 別のプロセスがいま実行している。`resume` は拒否される                 |
| `INTERRUPTED` | 実行していたプロセスが居ない（落ちた・強制終了した）。`resume` で続く |
| `UNKNOWN`     | ロックを確かめられなかった                                            |

### 戦術演習

戦術演習の評価API（`/api/v1/tactical-exercise-evaluations`、`docs/ddd/10_API設計.md`「戦術演習を
大量試行する」）も同じ基盤で評価する。形式固有の点は次のとおり。

- 対戦入力（`match:`）は演習の編成定義YAML（`ally` + `enemy`）。`ally` は編成ライブラリの参照
  `{ library: <id> }`（`inputs.formationsDir` から展開）でもよく、import-draft で作った味方編成へ
  演習の敵1体を組み合わせられる。`draft:` はUIの演習ドラフト（`mlgg:last-draft:exercise`）。
  規定ターン数は5固定（R-TEX-01 #4）なので `turnLimit` は書けない。

  ```yaml
  # 例: configs/vs-nanae.yaml
  ally: { library: kotoha-anis }
  enemy:
    unitDefinitionId: UNIT_NANAE_SOVEREIGN_TEX
    position: { column: 1, row: FRONT }
  ```

- 手持ちデータは味方にだけ当てる（`inputs.playerDataSides` は既定の `[ALLY]` のまま）。演習の敵は
  強化を持たない。
- 試行の観測値はスコア（`totalScore`）・ブレイク回数・演習の終了理由（`TURN_LIMIT_REACHED`／
  `ALLY_DEFEATED`）・参加枠ごとの集計・味方枠ごとのブレイク（`allyUnitBreaks`）。勝敗には読み替えない。
  味方枠のブレイクの和と `breakCount` の差は、メモリー由来と敵の自傷の両方を含む。
- 旧契約（`runsPerCandidate`・`<seed>#<runOffset>`）向けの互換アダプターは持たない。旧UI・旧CLIの
  seed・CSVは新契約の試行番号と同じ試行ではない。

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
起動したサーバーを相手に、戦術演習・通常戦闘・総力戦の複数ケース・複数試行を「要求を大きく」「細かく分けてケース順を逆に」
「同条件で再実行」の3通りで実行し、意味上の観測値が一致することを確かめる。

テストは各パッケージの `tests/` と、workspace横断の `tests/`（境界・公開サンプル）にある。
ラボのテストは別のラボをimportしない。テスト用のドラフト生成は `mlgg_lab_common.testing` にある。

### 品質ゲートとの関係

`scripts/run-quality-gates.sh`（PR CI）は `tools/` のテストを実行しない。ただし UI の統計表示が
参照実装（`mlgg_lab_common.statistics.descriptive` / `exercise_lab.statistics.daily_best`）から
書き出した fixture を読むため、統計の定義を変えたときは fixture を再生成して `mise run ui:test`
まで通す（手順は [`exercise-lab/README.md`](exercise-lab/README.md)）。fixture と参照実装の一致は
`exercise-lab/tests/test_ui_parity_fixture.py` が検査する。
