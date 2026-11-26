"""育成情報・編成・Catalogの取り込み。戦闘形式には依らない。

- `player_data`: 手持ちデータ（`mlgg:player-data`）の検証と育成値の解決
- `draft`: UIの編成ドラフト（`BattleDraft`）の読み取り
- `library`: 編成ライブラリ（`configs/formations/<id>.yaml`）
- `sources`: 対戦入力ファイル内の編成1件（インライン／ライブラリ参照）
- `catalog`: Catalogの取得・検索・参照の事前検証
- `schema`: 編成ライブラリ用のJSON Schema生成と、Schemaへ実IDを差し込む部品
- `resolution`: 入力解決の共通手順（手持ちデータの適用・検証エラーの集約）
- `yaml_io`: 入力YAMLの読み書き
- `migration`: 従来の置き場所から `tools/data/inputs/` への入力データの移行
"""
