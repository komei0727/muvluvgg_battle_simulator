# tools

ローカル専用のPython分析ツール群。[uv](https://docs.astral.sh/uv/) の workspace として、
共通ライブラリ1つと形式ごとのラボ3つを持つ。

| パッケージ                         | import名          | 役割                                                                                      |
| ---------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| [`common/`](common/)               | `mlgg_lab_common` | 陣営に依らない編成・育成モデル、手持ちデータ・ドラフト・編成ライブラリ・Catalog、記述統計 |
| [`exercise-lab/`](exercise-lab/)   | `exercise_lab`    | 戦術演習の入力・演習固有統計・入力補助CLI（`exercise-lab`）                               |
| [`battle-lab/`](battle-lab/)       | `battle_lab`      | 通常戦闘の対戦入力（両陣営の編成・規定ターン数）と形式固有の検証                          |
| [`total-war-lab/`](total-war-lab/) | `total_war_lab`   | 総力戦の対戦入力（両陣営の編成列・出撃順）と形式固有の検証                                |

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

## 開発

```bash
cd tools
uv sync --locked --all-packages
uv run pytest                                  # workspace全体（4パッケージ + 境界・サンプル）
uv run pytest battle-lab                       # 1パッケージだけ
uv run ruff check .
uv run ruff format --check .
bash scripts/check-isolated-installs.sh        # パッケージ単独のインストール確認
```

テストは各パッケージの `tests/` と、workspace横断の `tests/`（境界・公開サンプル）にある。
ラボのテストは別のラボをimportしない。テスト用のドラフト生成は `mlgg_lab_common.testing` にある。

### 品質ゲートとの関係

`scripts/run-quality-gates.sh`（PR CI）は `tools/` のテストを実行しない。ただし UI の統計表示が
参照実装（`mlgg_lab_common.statistics.descriptive` / `exercise_lab.statistics.daily_best`）から
書き出した fixture を読むため、統計の定義を変えたときは fixture を再生成して `mise run ui:test`
まで通す（手順は [`exercise-lab/README.md`](exercise-lab/README.md)）。fixture と参照実装の一致は
`exercise-lab/tests/test_ui_parity_fixture.py` が検査する。
