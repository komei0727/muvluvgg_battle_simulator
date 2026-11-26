# common（`mlgg-lab-common`）

分析ラボが共有する、戦闘形式に依らない入力基盤。`tools/` の uv workspace の1パッケージで、
全体の構成・依存の向き・開発コマンドは [`../README.md`](../README.md) にある。

| モジュール               | 役割                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `models.formation`       | 編成の値型（`FormationSpec` / `FormationUnitSpec`）と `FormationRequest` への変換    |
| `models.participants`    | 参加枠の識別（`SlotKey` = 陣営・編成番号・枠の添字）                                 |
| `models.resolved`        | 解決済み入力の基底・由来情報（`InputProvenance`）・JSON往復                          |
| `inputs.player_data`     | 手持ちデータ `mlgg:player-data` の検証と育成値の解決（レベルリンク・除外・単位変換） |
| `inputs.draft`           | UIの編成ドラフト（`BattleDraft`）の読み取り                                          |
| `inputs.library`         | 編成ライブラリ（`configs/formations/<id>.yaml`）の一覧・読み書き                     |
| `inputs.sources`         | 対戦入力ファイル内の編成1件（インライン／`{ library: <id> }`）                       |
| `inputs.catalog`         | Catalog の取得・DTO・検索・参照の事前検証                                            |
| `inputs.schema`          | 編成ライブラリ用 JSON Schema と、Schemaへ実IDを差し込む部品                          |
| `inputs.resolution`      | 入力解決の共通手順（手持ちデータの適用・検証エラーの集約）                           |
| `statistics.descriptive` | 記述統計（UI統計の参照実装。追加依存 `statistics` が要る）                           |
| `testing`                | テスト用のドラフト生成（UIの保存形式を写す）                                         |

手持ちデータの適用規則（明示値の優先・レベルリンク・単位変換など）は
[`../exercise-lab/README.md`](../exercise-lab/README.md)「手持ちデータ」にまとめてある。
