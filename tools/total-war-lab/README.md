# total-war-lab

総力戦（`TOTAL_WAR`）のラボ。`tools/` の uv workspace の1パッケージで、全体の構成・依存の向き・
開発コマンドは [`../README.md`](../README.md) にある。

今は対戦入力の基盤だけを持つ。評価APIの大量試行・保存・探索は後続の段階で足す。

## 対戦入力

対戦条件は「両陣営の編成列（出撃順）」で、`TotalWarRequest`（`options` を除く）と同じ形である。
規定ターン数は15で固定（R-TWR-01 #5）なので持たない。

| 検証                                                         | 根拠            |
| ------------------------------------------------------------ | --------------- |
| 各陣営1～3編成（両陣営の数は違ってよい）                     | R-TWR-01 #1     |
| 各編成1～5体・メモリー0～6件・配置重複なし（編成ごとに判定） | R-TWR-01 #2     |
| 1編成内で同じユニット・同じメモリーを置かない                | R-TWR-01 #3／#4 |
| 両陣営とも `PLAYABLE`（Catalogを渡したとき）                 | R-TWR-01 #6     |

**別の編成への同じユニット・同じメモリーは再登場として許可する。** 再登場の基礎値補正
（R-TWR-02）はAPIが掛けるので、入力では表さない。編成は出撃順のまま送り、並べ替えない。
参加枠は `(side, formationNumber, unitIndex)` で区別する（`formationNumber` は1始まり）。
ここの検証は事前検証で、最終的な受理判定はAPIが行う。

入力は次のどちらからでも作れる。

- **対戦入力ファイル（YAML）** — [`configs/match.example.yaml`](configs/match.example.yaml)。
  キーはAPIと同じ（`allyFormations` / `enemyFormations`）。各要素はインラインか
  編成ライブラリの参照 `{ library: <id> }`。
- **UIの総力戦ドラフト** — localStorage `mlgg:last-draft:total-war` の中身。3組のうち、各陣営の
  編成数（`formationCounts`）ぶんを先頭から使う。強化入力は読まない。

```python
from pathlib import Path

from total_war_lab.inputs import (
    dump_resolved_total_war_input,
    load_total_war_draft,
    load_total_war_match_file,
    resolve_total_war_input,
)

loaded = load_total_war_match_file(
    Path("configs/match.example.yaml"),
    formations_dir=Path("../exercise-lab/configs/formations"),
)
# または: loaded = load_total_war_draft(Path("local_storage/last-draft-total-war.json"))
resolved = resolve_total_war_input(
    loaded, player_data_path=Path("../exercise-lab/local_storage/player-data.json")
)
request = resolved.to_request()  # {"allyFormations": [...], "enemyFormations": [...]}
Path("resolved.json").write_text(dump_resolved_total_war_input(resolved), encoding="utf-8")
```

手持ちデータは陣営の全編成へ編成ごとに当てる（既定は味方だけ。`player_data_sides` で変えられる）。
`configs/*.yaml`（サンプル以外）と `local_storage/` は gitignore してある。
