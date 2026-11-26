# battle-lab

通常戦闘（`NORMAL`）のラボ。`tools/` の uv workspace の1パッケージで、全体の構成・依存の向き・
開発コマンドは [`../README.md`](../README.md) にある。

対戦入力の基盤と、評価設定から試行計画を作る口（`evaluation`）を持つ。評価APIの分割実行・保存・再開は
共通基盤（`mlgg_lab_common`）が持つ。通常戦闘の集計（`analysis`）と評価コマンド（`battle-lab`）、固定相手の探索の形式別アダプター（`search_space`。
相手編成・規定ターン数を固定する）を持つ。探索の使い方は [`../README.md`](../README.md)「探索の共通基盤（固定相手）」にある。

## 対戦入力

対戦条件は「両陣営の編成 + 規定ターン数」で、`BattleSimulationRequest`（`options` を除く）と
同じ形である。演習の制約（敵1体・敵メモリーなし・敵は `EXERCISE_ENEMY`）は持ち込まない。

| 検証                                         | 根拠             |
| -------------------------------------------- | ---------------- |
| 各陣営1～5体・メモリー0～6件・配置重複なし   | R-FRM-01／02／04 |
| 規定ターン数は1～99の整数                    | R-FRM-05         |
| 両陣営とも `PLAYABLE`（Catalogを渡したとき） | R-TEX-11 #3      |

同じユニットを同一陣営へ複数置ける（R-FRM-03）。ここの検証は事前検証で、最終的な受理判定はAPIが行う。

入力は次のどちらからでも作れる。

- **対戦入力ファイル（YAML）** — [`configs/match.example.yaml`](configs/match.example.yaml)。
  キーはAPIと同じ（`allyFormation` / `enemyFormation` / `turnLimit`）。編成はインラインか、
  編成ライブラリの参照 `{ library: <id> }`。
- **UIの通常戦闘ドラフト** — localStorage `mlgg:last-draft` の中身。配置・ユニット・メモリー順と
  規定ターン数を読み、強化入力は読まない（育成状態の正本は手持ちデータ）。

```python
from pathlib import Path

from battle_lab.inputs import (
    dump_resolved_battle_input,
    load_battle_draft,
    load_battle_match_file,
    resolve_battle_input,
)

loaded = load_battle_match_file(
    Path("configs/match.example.yaml"),
    # 編成ライブラリは既存の置き場所をそのまま参照する。
    formations_dir=Path("../exercise-lab/configs/formations"),
)
# または: loaded = load_battle_draft(Path("local_storage/last-draft.json"))
resolved = resolve_battle_input(
    loaded,
    player_data_path=Path("../exercise-lab/local_storage/player-data.json"),
    player_data_sides=("ALLY",),  # 両陣営を手持ちで比べるなら ("ALLY", "ENEMY")
)
request = resolved.to_request()  # {"allyFormation", "enemyFormation", "turnLimit"}
slots = resolved.participant_slots()  # (side, unitIndex) で枠を区別する
Path("resolved.json").write_text(dump_resolved_battle_input(resolved), encoding="utf-8")
```

手持ちデータは既定で味方にだけ当てる。どちらの陣営でも、編成に明示した値が優先する。
`catalog=` を渡すと未知IDと編成プール違反をまとめて検出する（`InputValidationError`）。
`configs/*.yaml`（サンプル以外）と `local_storage/` は gitignore してある。

## 評価設定から試行計画を作る

[`configs/evaluation.example.yaml`](configs/evaluation.example.yaml) を写して使う。ケースごとに対戦入力ファイル
（`match:`）かUIドラフト（`draft:`）と試行番号を書き、`plan_battle_evaluation(path)` で解決済み入力・送信内容・参加枠を
確定した計画にする。実行・保存・再開の手順と不変条件は [`../README.md`](../README.md)「評価の実行（共通基盤）」にある。

## 評価コマンド

```bash
cd tools
uv run battle-lab evaluate battle-lab/configs/evaluation.example.yaml --evaluation-id example
uv run battle-lab status data/evaluations/example
uv run battle-lab resume data/evaluations/example      # 止まった評価の続き
uv run battle-lab summarize data/evaluations/example   # ケース別の記述統計（APIへ接続しない）
uv run battle-lab export data/evaluations/example      # trials.jsonl / trials.csv / summary.json / cases.json
```

集計の定義は [`src/battle_lab/analysis.py`](src/battle_lab/analysis.py)、オプション・終了コード・出力形式は
[`../README.md`](../README.md)「評価コマンド」にある。
