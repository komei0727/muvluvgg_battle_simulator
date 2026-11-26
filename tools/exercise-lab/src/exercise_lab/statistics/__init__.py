"""戦術演習に固有の統計（挑戦回数別の最高値＝日次ベスト指標）。

UIの統計表示（`apps/ui/src/features/exercise-stats/`）が数値一致を検証する参照実装でもある。
`scripts/export_ui_parity_fixture.py` がここと `mlgg_lab_common.statistics.descriptive` から
fixtureを書き出す。統計の定義・数値計算法を変えるときは、UI側の移植とfixtureを同時に更新する。
"""
