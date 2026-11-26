# exercise-lab

戦術演習のラボ。`tools/` の uv workspace の1パッケージで、全体の構成・依存の向き・
開発コマンドは [`../README.md`](../README.md) にある。

- **演習の入力**（`exercise_lab.inputs`）— 演習の編成YAML・演習ドラフトを読み、演習固有の
  受理条件（敵ちょうど1体・敵メモリーなし・敵は `EXERCISE_ENEMY`）で検証し、解決済みの演習入力
  とAPIのリクエストを作る
- **演習固有の統計**（`exercise_lab.statistics`）— 挑戦回数別の最高値（日次ベスト指標）。UIの
  統計表示（`apps/ui/src/features/exercise-stats/`）が数値一致を検証する fixture の生成元でもある
- **入力補助CLI**（`exercise-lab`）— ドラフトの取り込み・IDの検索・編成ライブラリの一覧・Schema生成

戦闘形式に依らない部分（編成・育成モデル、手持ちデータ、UIドラフト、編成ライブラリ、Catalog、
記述統計）は `mlgg_lab_common`（[`../common/`](../common/)）にある。戦闘ルール・育成計算の正本は
TypeScript 側（`apps/api/`）にあり、ここでは再実装しない。

> 以前ここにあった統計・探索・ギア分析（`lab stats` / `optimize` / `compare` /
> `gear-sensitivity` / `gear-plan`）は Issue #881 で削除した。実装は Git 履歴
> （`59c78fe0` 以前）で参照できる。それらが書き出した `reports/` 等の既存成果物は
> そのまま残しており、読み込み互換は持たない。

## セットアップ

```bash
cd tools
uv sync --locked --all-packages
cd exercise-lab   # 以降の相対パス（configs/・local_storage/）はここが基準
```

個人の入力は `tools/data/inputs/`（ドラフト・編成YAML・育成JSON）にまとめて置ける（従来の
`local_storage/`・`configs/formations/` もそのまま使える）。配置・移行の手順は [`../README.md`](../README.md)
「データの置き場所」にある。戦術演習の評価APIは試行番号を指定できる形への再設計待ちのため、共通の評価実行
基盤（同「評価の実行」）からはまだ評価できない。

コマンド名は `lab` から `exercise-lab` に変わった（workspace の他のラボとの衝突を避けるため）。
サブコマンド・オプションは変わらない。個人ファイル（`configs/*.yaml`・`configs/formations/`・
`local_storage/`）の場所も変わらず、ツールはそれらを移動・削除・上書きしない。

Catalog を引くコマンドはローカルの dev サーバー（`apps/api/` で `mise run dev`、既定ポート 3000）を
相手にする。別の配備を指すときは `--base-url` を渡す。

## 構成

| モジュール                            | 役割                                                                 |
| ------------------------------------- | -------------------------------------------------------------------- |
| `inputs/exercise.py`                  | 演習の編成YAML・演習ドラフトの読み書き、演習固有の検証、解決済み入力 |
| `inputs/schema.py`                    | 演習の編成YAML用 JSON Schema の生成                                  |
| `statistics/daily_best.py`            | 日次ベスト指標（UI統計の参照実装）                                   |
| `cli.py`                              | `exercise-lab` コマンド（入力補助）                                  |
| `scripts/export_ui_parity_fixture.py` | UI統計の fixture を書き出す                                          |

演習固有の受理条件は `inputs/exercise.py` の中だけにある。

## コマンド

| コマンド                    | 用途                                                  |
| --------------------------- | ----------------------------------------------------- |
| `exercise-lab import-draft` | UIで組んだ演習編成を編成定義YAMLへ変換する            |
| `exercise-lab units`        | Catalog のユニットを検索してIDを引く                  |
| `exercise-lab memories`     | Catalog のメモリーを検索してIDを引く                  |
| `exercise-lab formations`   | 編成ライブラリ（`configs/formations/`）のIDを一覧する |
| `exercise-lab schema`       | エディタ補完用の JSON Schema を Catalog から生成する  |

### UIのドラフトを取り込む（`exercise-lab import-draft`）

UI は演習モードの編成を localStorage `mlgg:last-draft:exercise` へ保存している。

1. UI（`mise run ui:dev` またはデプロイ済みの Pages）で演習モードの編成を組む
2. DevTools のコンソールで `copy(localStorage.getItem("mlgg:last-draft:exercise"));` を実行する
3. クリップボードの中身を `local_storage/draft/<名前>.json` として保存する（gitignore 済み）
4. 変換する

   ```bash
   uv run exercise-lab import-draft local_storage/draft/kotoha-anis.json -o configs/formation.yaml
   ```

`-o` を省くと標準出力へ出る。生成物には**育成状態（レベル・ギア・学園レベル）を含めない** —
正本は手持ちデータ側に一本化してある。ドラフトの強化入力は読み飛ばす。

演習用ではなく通常戦闘の `mlgg:last-draft` を渡した場合、敵が2体以上のときと敵メモリーを
持つときはここで落とす。ただし**敵1体・敵メモリーなしの通常戦闘ドラフトは判別できない**
（保存形式が同じ `BattleDraft` のため）。その取り違えは `inputs.exercise.validate_against_catalog`
が捕まえる——通常戦闘の敵は `PLAYABLE` なので R-TEX-11 #1 で弾かれる。

`--library` を付けると、敵を含まない編成ライブラリ形式（`units` + `memoryDefinitionIds`）で
出す。`--note` で意図・狙いも書ける（`--library` 専用）。

```bash
uv run exercise-lab import-draft local_storage/draft/kotoha-anis.json --library \
  --note "属性デバフ特化" -o configs/formations/kotoha-anis.yaml
```

### 編成ライブラリ（`exercise-lab formations`）

`configs/formations/<id>.yaml` 1ファイルが、敵に依らない味方編成1件である（ファイル名がID）。

```yaml
note: 属性デバフ特化
units:
  - unitDefinitionId: UNIT_OLGA_NADYA_BOND
    position: { column: 0, row: FRONT }
memoryDefinitionIds:
  - MEM_GIDDY_CIRCUMSTANCES
```

```bash
uv run exercise-lab formations              # 全件
uv run exercise-lab formations --grep olga  # 部分一致
```

`configs/formations/` は個人の編成置き場であり gitignore してある。公開サンプル・テストはここに依存しない。
編成ライブラリは陣営に依らないので、通常戦闘・総力戦の対戦入力からも `{ library: <id> }` で参照できる
（`battle-lab` / `total-war-lab` へこのディレクトリを `formations_dir` として渡す）。

### エディタ補完（`exercise-lab schema`）

Catalog から実IDを enum に焼いた JSON Schema を生成する。既定の出力先は `.schema/`（gitignore 済み）。

| 生成物                               | 対象YAML                                   |
| ------------------------------------ | ------------------------------------------ |
| `.schema/formation.schema.json`      | 演習の編成定義                             |
| `.schema/formation-seed.schema.json` | 編成ライブラリ1件（`configs/formations/`） |

対象YAMLの先頭へ対応する1行を置くと、YAML Language Server が ID を補完・検証する。

```yaml
# yaml-language-server: $schema=../.schema/formation.schema.json
```

```yaml
# configs/formations/<id>.yaml は1つ下の階層なので `../../` になる。
# yaml-language-server: $schema=../../.schema/formation-seed.schema.json
```

味方枠と敵枠には別々の enum が入るので、R-TEX-11 #1 はエディタ上で分かる。学園レベルのキー9種と、
「`ally.academyLevels` なしにユニットの `level` / `rank` / `gears` / `module` は書けない」もSchemaで表す。
味方の配置重複は JSON Schema で表せないため、エディタは通しローダーが落とす
（差異は `tests/test_schema.py` で固定してある）。**Catalog を更新したら作り直す。**

### IDを引く（`exercise-lab units` / `exercise-lab memories`）

```bash
uv run exercise-lab units --owned --player-data local_storage/player-data.json   # 手持ちだけに絞る
uv run exercise-lab units --grep 反逆                              # 表示名・キャラ名・IDの部分一致
uv run exercise-lab units --category EXERCISE_ENEMY                # 演習の敵一覧
uv run exercise-lab memories --grep 心
uv run exercise-lab units --grep コトハ --yaml                     # 編成YAMLへ貼れる形で出す
```

`--yaml` の `position` は仮置きなので、貼った後に実際の配置へ直す。`--owned` のレベル列は
レベルリンク解決後の値を出し、リンク由来の値には `*` を付ける（`250*`）。

## 編成定義 YAML（演習）

`configs/formation.example.yaml` を写して使う（個人ファイルなしで読み込める）。

- ユニットとメモリーは**書いた順のまま**リクエストへ載る。メモリーをID順に並べ替えない。
- `ally.academyLevels` を書くと強化計算が有効になる。書かない場合、ユニット側の
  `level` / `rank` / `gears` / `module` は指定できない（API が 422 で拒むため）。
- レベル 200・ランク 5（`LR+5`）・ギア 0 件・モジュール上書きなしのユニットは、API の省略時既定と
  同値のため `enhancement` を送らない。`rank` は既定と同値のときだけキー単体で省略する。
  `module` は1項目でも上書きがあれば送る（R-ENH-08）。
- `module` の値の単位は API と同じ（`ratio` は内部表現の小数、例 `0.1` = 10%）。非有限値は拒否する。
- 敵はちょうど 1 体・メモリーなし・強化なし。**配置は結果に影響する**。
- 未知キーは拒否する（綴り違いを既定動作へすり替えない）。

## 手持ちデータ（`mlgg:player-data`）

1. UI の DevTools コンソールで `copy(localStorage.getItem("mlgg:player-data"));` を実行する
2. 中身を `local_storage/player-data.json` として保存する（gitignore 済み）

```python
from pathlib import Path

from exercise_lab.inputs.exercise import (
    dump_resolved_exercise_input,
    load_resolved_exercise_input,
    resolve_exercise_input,
)

resolved = resolve_exercise_input(
    Path("configs/formation.example.yaml"),
    player_data_path=Path("local_storage/player-data.json"),
)
print(resolved.provenance.warnings)  # 手持ちデータに無いユニットなど
request = resolved.to_request()  # {"allyFormation": ..., "enemyFormation": ...}

# 解決済み入力はJSONへ保存して読み戻せる（元ファイルを読み直さない）。
Path("resolved.json").write_text(dump_resolved_exercise_input(resolved), encoding="utf-8")
assert load_resolved_exercise_input(Path("resolved.json")).to_request() == request
```

`catalog=`（`mlgg_lab_common.inputs.catalog.CatalogClient(...).fetch_catalog()` の結果）を渡すと、
未知IDと編成プール違反をまとめて事前検証する。

手持ちデータの適用は陣営に依らない `mlgg_lab_common.inputs.player_data.apply_player_data(formation, data)`
（`FormationSpec` を渡す）が行い、ここは味方へだけ当てる。

適用規則:

- 編成に明示した値が常に優先する。手持ちデータは「書かなかった項目」（`None`）だけを埋める。
  明示した `0` 等は未指定と区別する。
- 編成に `academyLevels` が無ければ手持ちの学園レベルが入り、強化計算が有効になる。
- 枠ごとに解決する。同じユニットを2枠へ置いても、片方へ明示した値はもう片方へ移らない。
- 手持ちデータに無いユニットは警告を返し、レベル 200（リンクONならリンクレベル）・ランク 5・
  ギアなしとして扱う。
- `schemaVersion` が 1 以外のデータは読み替えず失敗させる。未知キーも拒否する
  （UI が新項目を書き始める前に、ここを先に対応させる）。
- `rank` / `module` / `linkExcluded` / `levelLink` は導入前のエクスポートに無いため、無ければ既定値で読む。
- 手持ちの `module.ratio` は UI 表示のパーセント単位（`10` = 10%）で保存されているため、API の
  小数（`0.1`）へ変換する。未上書き（`""`）の項目はキーごと送らない。

レベルの解決（`apps/ui/src/features/formation/level-link.ts` と同じ規則）:

- `levelLink.enabled` が真で `level` が 1 以上なら、ユニットはリンクレベルで評価する。
- `linkExcluded: true` のユニットだけは個別の `level` を使う。
- 手持ちデータに記録の無いユニットもリンク対象になる（UI は編集した枠だけを書き戻すため）。
- 編成に書いた `level` はリンクより優先する。

## UI統計の参照実装と fixture

`apps/ui/src/features/exercise-stats/` は `mlgg_lab_common.statistics.descriptive`（記述統計・敗北率・
ブレイク分布・ヒストグラムのビン数）と `exercise_lab.statistics.daily_best`（期待日次ベスト・
日次ベスト分位点・実効サンプル数）をTypeScriptへ移植している。UI 側のテストはここから書き出した
期待値を読む。

```bash
cd tools/exercise-lab
uv run python scripts/export_ui_parity_fixture.py
cd ../.. && mise exec -- pnpm exec prettier --write apps/ui/src/features/exercise-stats/__fixtures__/python-parity.ts
```

統計の定義を変えたら再生成し、UI のテスト（`mise run ui:test`）が通ることまで見る。標本は
スクリプト内の LCG で作るので、Python や依存の版が変わっても同じ入力が再現する。
コミット済みの fixture が再生成結果と一致することは `tests/test_ui_parity_fixture.py` が検査する。

## 開発

```bash
cd tools
uv run pytest common exercise-lab tests
uv run ruff check .
uv run ruff format --check .
```

workspace 全体のコマンドと境界の検査は [`../README.md`](../README.md) にある。
