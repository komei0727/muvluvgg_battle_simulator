"""分析ラボ（`exercise-lab` / `battle-lab` / `total-war-lab`）が共有する入力基盤。

戦闘処理・ステータス計算・育成計算・最終的な編成合法性の判定はAPI（`apps/api/`）の
責務であり、ここでは再実装しない。ここが持つのは入力の読み込み・育成情報の適用・
参照の事前検証と、`FormationRequest` への変換だけである。

- `models`: 陣営に依存しない編成・育成モデル、参加枠、解決済み入力
- `inputs`: 手持ちデータ・UIドラフト・編成ライブラリ・Catalog
- `statistics`: 汎用的な記述統計（追加依存 `statistics` が要る）
"""
