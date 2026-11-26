# exercise-lab

ローカル専用のPythonツール。役割は2つに絞ってある。

- **入力の取り込み**（`exercise_lab.inputs`）— 手持ちデータ（育成状態）・編成（YAML・UIのドラフト・
  編成ライブラリ）・Catalog を読み、検証し、API の `FormationRequest` へ変換する
- **UI統計の参照実装**（`exercise_lab.reference_stats`）— UIの統計表示
  （`apps/ui/src/features/exercise-stats/`）が数値一致を検証する fixture の生成元

戦闘ルール・育成計算の正本は TypeScript 側（`apps/api/`）にあり、ここでは再実装しない。

このディレクトリは pnpm workspace にも CI 品質ゲートにも属さない。`ruff` / `pytest` は
ツール内で完結し、`scripts/run-quality-gates.sh` からは呼ばれない。

> 以前ここにあった統計・探索・ギア分析（`lab stats` / `optimize` / `compare` /
> `gear-sensitivity` / `gear-plan`）は Issue #881 で削除した。実装は Git 履歴
> （`59c78fe0` 以前）で参照できる。それらが書き出した `reports/` 等の既存成果物は
> そのまま残しており、読み込み互換は持たない。

## セットアップ

[uv](https://docs.astral.sh/uv/) と Python 3.12 以上が要る。

```bash
cd tools/exercise-lab
uv sync --locked
```

Catalog を引くコマンドはローカルの dev サーバー（`apps/api/` で `mise run dev`、既定ポート 3000）を
相手にする。別の配備を指すときは `--base-url` を渡す。

## 構成

| モジュール              | 役割                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `inputs/models.py`      | 味方編成の値型（配置・ギア・学園レベル・モジュール）と `FormationRequest`（味方）変換 |
| `inputs/player_data.py` | 手持ちデータ `mlgg:player-data` の版・形・値の検証と、育成値の解決                    |
| `inputs/draft.py`       | UIの編成ドラフト（`BattleDraft`）の版検証と、配置・ユニット・メモリーの抽出           |
| `inputs/library.py`     | 編成ライブラリ（`configs/formations/<id>.yaml`）の一覧・読み書き                      |
| `inputs/catalog.py`     | Catalog の取得・DTO・検索                                                             |
| `inputs/exercise.py`    | 戦術演習の既存形式（編成YAML・演習ドラフト）のアダプター                              |
| `inputs/schema.py`      | 編成YAML・編成ライブラリ用 JSON Schema の生成                                         |
| `reference_stats/`      | UI統計の参照実装（記述統計・日次ベスト指標）                                          |
| `cli.py`                | `lab` コマンド（入力補助）                                                            |

演習固有の受理条件（敵ちょうど1体・敵メモリーなし・敵は `EXERCISE_ENEMY`）は `inputs/exercise.py`
の中だけにある。他のモジュールは戦闘種別に依らない。

## コマンド

| コマンド           | 用途                                                  |
| ------------------ | ----------------------------------------------------- |
| `lab import-draft` | UIで組んだ演習編成を編成定義YAMLへ変換する            |
| `lab units`        | Catalog のユニットを検索してIDを引く                  |
| `lab memories`     | Catalog のメモリーを検索してIDを引く                  |
| `lab formations`   | 編成ライブラリ（`configs/formations/`）のIDを一覧する |
| `lab schema`       | エディタ補完用の JSON Schema を Catalog から生成する  |

### UIのドラフトを取り込む（`lab import-draft`）

UI は演習モードの編成を localStorage `mlgg:last-draft:exercise` へ保存している。

1. UI（`mise run ui:dev` またはデプロイ済みの Pages）で演習モードの編成を組む
2. DevTools のコンソールで `copy(localStorage.getItem("mlgg:last-draft:exercise"));` を実行する
3. クリップボードの中身を `local_storage/draft/<名前>.json` として保存する（gitignore 済み）
4. 変換する

   ```bash
   uv run lab import-draft local_storage/draft/kotoha-anis.json -o configs/formation.yaml
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
uv run lab import-draft local_storage/draft/kotoha-anis.json --library \
  --note "属性デバフ特化" -o configs/formations/kotoha-anis.yaml
```

### 編成ライブラリ（`lab formations`）

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
uv run lab formations              # 全件
uv run lab formations --grep olga  # 部分一致
```

`configs/formations/` は個人の編成置き場であり gitignore してある。公開サンプル・テストはここに依存しない。

### エディタ補完（`lab schema`）

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

### IDを引く（`lab units` / `lab memories`）

```bash
uv run lab units --owned --player-data local_storage/player-data.json   # 手持ちだけに絞る
uv run lab units --grep 反逆                              # 表示名・キャラ名・IDの部分一致
uv run lab units --category EXERCISE_ENEMY                # 演習の敵一覧
uv run lab memories --grep 心
uv run lab units --grep コトハ --yaml                     # 編成YAMLへ貼れる形で出す
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

from exercise_lab.inputs.exercise import apply_player_data, build_enemy_formation, load_formation_config
from exercise_lab.inputs.models import build_ally_formation
from exercise_lab.inputs.player_data import load_player_data

config = load_formation_config(Path("configs/formation.example.yaml"))
data = load_player_data(Path("local_storage/player-data.json"))
config, warnings = apply_player_data(config, data)
request = {
    "allyFormation": build_ally_formation(config.ally),
    "enemyFormation": build_enemy_formation(config.enemy),
}
```

演習以外の編成は `inputs.player_data.apply_player_data(ally, data)` へ `AllySpec` を直接渡す。

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

`apps/ui/src/features/exercise-stats/` は `reference_stats/descriptive.py`（記述統計・敗北率・
ブレイク分布・ヒストグラムのビン数）と `reference_stats/daily_best.py`（期待日次ベスト・
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
uv sync --locked
uv run pytest
uv run ruff check src tests scripts
uv run ruff format src tests scripts
```
