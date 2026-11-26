"""戦闘形式に依らない記述統計。

- `descriptive`: UIの統計表示の参照実装。`numpy` を使うため、追加依存
  `mlgg-lab-common[statistics]` が要る。
- `summary`: 保存済みの観測値を確かめる記述統計（評価実行の `summarize` / `export`）。
  標準ライブラリだけで動く。
"""
