"""育成情報・編成情報・Catalogの取り込み。

- `models`: 味方編成の値型と `FormationRequest`（味方）へのAPI変換
- `player_data`: 手持ちデータ（`mlgg:player-data`）の検証と育成値の解決
- `draft`: UIの編成ドラフト（`BattleDraft`）の読み取り
- `library`: 編成ライブラリ（`configs/formations/<id>.yaml`）
- `catalog`: Catalogの取得と検索
- `exercise`: 戦術演習の既存入力形式（編成YAML・演習ドラフト）のアダプター
- `schema`: 編成YAML・編成ライブラリ用のJSON Schema生成
"""
