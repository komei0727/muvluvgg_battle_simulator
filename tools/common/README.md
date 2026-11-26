# common（`mlgg-lab-common`）

分析ラボが共有する、戦闘形式に依らない入力・評価実行・集計の基盤。`tools/` の uv workspace の1パッケージで、
全体の構成・依存の向き・開発コマンドは [`../README.md`](../README.md) にある。

| モジュール               | 役割                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `models.formation`       | 編成の値型（`FormationSpec` / `FormationUnitSpec`）と `FormationRequest` への変換         |
| `models.participants`    | 参加枠の識別（`SlotKey` = 陣営・編成番号・枠の添字）                                      |
| `models.resolved`        | 解決済み入力の基底・由来情報（`InputProvenance`）・JSON往復                               |
| `inputs.player_data`     | 手持ちデータ `mlgg:player-data` の検証と育成値の解決（レベルリンク・除外・単位変換）      |
| `inputs.draft`           | UIの編成ドラフト（`BattleDraft`）の読み取り                                               |
| `inputs.library`         | 編成ライブラリ（`configs/formations/<id>.yaml`）の一覧・読み書き                          |
| `inputs.sources`         | 対戦入力ファイル内の編成1件（インライン／`{ library: <id> }`）                            |
| `inputs.catalog`         | Catalog の取得・DTO・検索・参照の事前検証                                                 |
| `inputs.schema`          | 編成ライブラリ用 JSON Schema と、Schemaへ実IDを差し込む部品                               |
| `inputs.resolution`      | 入力解決の共通手順（手持ちデータの適用・検証エラーの集約）                                |
| `statistics.descriptive` | 記述統計（UI統計の参照実装。追加依存 `statistics` が要る）                                |
| `statistics.summary`     | 保存結果を確かめる要約統計・件数と比率・分布（標準ライブラリだけ）                        |
| `inputs.migration`       | 従来の置き場所から `tools/data/inputs/` への入力データの移行                              |
| `api.contracts`          | 評価APIの要求・応答の型、形式ごとの契約、応答と要求の対応の検証                           |
| `api.client`             | 評価APIのHTTP通信と失敗の分類                                                             |
| `evaluation.*`           | 評価設定・試行計画・識別・要求分割・予算・実行と再開                                      |
| `storage.*`              | 評価実行ごとのSQLite（再開状態の正本）・保存形式の移行・保存先ディレクトリ                |
| `reporting.*`            | 保存結果の読み出し・進捗・ケース別の記述統計・JSONL/CSV/JSON出力（APIへ接続しない）       |
| `cli`                    | 各ラボの評価コマンドの共通部（追加依存 `cli` が要る）                                     |
| `search.*`               | 固定相手の探索の共通基盤（探索問題・候補・候補操作・制約・手法の接続契約・実行制御）      |
| `experiments.*`          | 探索の履歴・チェックポイントのSQLite・探索ディレクトリ                                    |
| `testing`                | テスト用のドラフト生成（UIの保存形式を写す）、評価APIの応答・偽物、探索のテスト用接続実装 |

探索の接続仕様・保存状態・使い方は [`../README.md`](../README.md)「探索の共通基盤（固定相手）」にある。

評価の実行・保存・再開の使い方と不変条件は [`../README.md`](../README.md)「評価の実行（共通基盤）」、コマンド・集計・出力形式は同「評価コマンド」にある。

手持ちデータの適用規則（明示値の優先・レベルリンク・単位変換など）は
[`../exercise-lab/README.md`](../exercise-lab/README.md)「手持ちデータ」にまとめてある。
