# exercise-lab

戦術演習（スコアアタック）の統計サマリーを出すローカル専用ツール。同一編成を大量に試行し、
スコアの分布・信頼区間・ブレイク数分布・生データを出す。

役割分担は「TS側が評価プリミティブ、Python側が統計・可視化・分析」。試行の実行は
API（`POST /api/v1/tactical-exercise-evaluations`）が行い、統計量はサーバーでは一切算出しない。

**ローカルの dev サーバー専用。** 本番 Cloud Run は同エンドポイントを
`EVALUATION_ENDPOINT_ENABLED=false` で閉じている（maxScale 1・リクエスト時間の制約のため）。

このディレクトリは pnpm workspace にも CI 品質ゲートにも属さない。`ruff` / `pytest` は
ツール内で完結し、`scripts/run-quality-gates.sh` からは呼ばれない。

## セットアップ

[uv](https://docs.astral.sh/uv/) と Python 3.12 以上が要る。

```bash
cd tools/exercise-lab
uv sync
```

## dev サーバーの起動

```bash
cd apps/api
mise run dev
```

`mise run dev` は `EVALUATION_ENDPOINT_ENABLED` を `true` に既定するので、追加の指定は要らない
（アプリ自体の既定は `false` で、本番 Cloud Run はそちらのまま）。既定のポートは 3000（`PORT`）。
スループットを上げたい場合は Worker の設定を渡す。

```bash
WORKER_MAX_THREADS=8 WORKER_MAX_QUEUE=200 EVALUATION_MAX_TOTAL_RUNS=300 mise run dev
```

| 環境変数                      | 既定                 | 用途                                                     |
| ----------------------------- | -------------------- | -------------------------------------------------------- |
| `EVALUATION_ENDPOINT_ENABLED` | `true`（`dev` 経由） | 一括評価の公開。`false` だと `404 ENDPOINT_DISABLED`。   |
| `EVALUATION_MAX_TOTAL_RUNS`   | `300`                | 1リクエストの総試行数上限。`--chunk-size` の上限になる。 |
| `EVALUATION_MAX_CANDIDATES`   | `32`                 | 1リクエストの候補数上限（このツールは常に1候補）。       |
| `SIMULATION_TIMEOUT_MS`       | `30000`              | リクエスト全体の期限。超えた分は部分結果として返る。     |
| `WORKER_MAX_THREADS`          | CPU依存              | Worker スレッド数。                                      |
| `WORKER_MAX_QUEUE`            | `100`                | Worker 待機キュー上限。                                  |

## コマンド

| コマンド           | 用途                                                 |
| ------------------ | ---------------------------------------------------- |
| `lab stats`        | 同一編成を大量試行して統計サマリーを出す             |
| `lab import-draft` | UIで組んだ演習編成を編成定義YAMLへ変換する           |
| `lab schema`       | エディタ補完用の JSON Schema を Catalog から生成する |
| `lab units`        | Catalog のユニットを検索してIDを引く                 |
| `lab memories`     | Catalog のメモリーを検索してIDを引く                 |

`stats` 以外は編成を用意するための補助である（「編成をIDで書かずに用意する」参照）。

## 実行

`configs/formation.example.yaml` は現行 Catalog の実IDで書かれており、そのまま実行できる。

```bash
cd tools/exercise-lab
uv run lab stats configs/formation.example.yaml --runs 200 --seed abc123 --out reports/
```

ただしこれは全員レベル200・ギアなし・強化計算なしの「素の性能」比較になる。実際の育成状態で
評価するなら、後述の「手持ちデータの取り込み」で `player-data.json` を書き出して渡す。

```bash
uv run lab stats configs/formation.example.yaml --runs 200 --seed abc123 \
  --player-data player-data.json --out reports/
```

自分の編成を試すときはサンプルを写して編集する（`configs/` 直下はサンプル以外 gitignore 済み）。

```bash
cp configs/formation.example.yaml configs/formation.yaml
uv run lab stats configs/formation.yaml --runs 1000 --seed abc123 \
  --player-data player-data.json --out reports/
```

| オプション      | 既定                    | 説明                                     |
| --------------- | ----------------------- | ---------------------------------------- |
| `--runs`        | `100`                   | 総試行数。                               |
| `--seed`        | 生成                    | 省略時はランダム生成して先頭に表示する。 |
| `--out`         | `reports`               | レポート出力先。無ければ作る。           |
| `--base-url`    | `http://localhost:3000` | dev サーバーの URL。                     |
| `--player-data` | なし                    | `mlgg:player-data` のエクスポート JSON。 |
| `--chunk-size`  | `300`                   | 1リクエストあたりの試行数。              |
| `--timeout`     | `120`                   | 1リクエストの待ち時間（秒）。            |

実行前に `GET /api/v1/battle-simulation-catalog` を1回引き、YAML 中の未知 ID と編成プール違反
（R-TEX-11 #1）を検出する。違反があれば1試行も投げずに終了する。

### 出力

| ファイル                       | 内容                                                     |
| ------------------------------ | -------------------------------------------------------- |
| `runs.csv`                     | 試行ごとの生値。後から pandas で横断分析するための正本。 |
| `summary.json`                 | 統計量・再現条件・実試行数。                             |
| `score-histogram.png`          | スコアのヒストグラム。                                   |
| `break-count-distribution.png` | ブレイク回数の分布。                                     |

コンソールには平均・中央値・標準偏差・min/max・p05/p25/p75/p95・平均の 95% 信頼区間・
敗北率（`ALLY_DEFEATED` の比率）を表で出す。

`runs.csv` の列は固定である。

```
run_index,chunk_index,chunk_seed,run_index_in_chunk,score,break_count,completed_turn,completion_reason
```

試行が1件も完了しなかった場合（期限到達で全チャンクが `completedRuns: 0`）は、空のレポートを
書かずにエラーで終える。ヘッダーだけの `runs.csv` を残すと、後段が「0件という結果」と
「そもそも走らなかった」を区別できないため。

## 編成をIDで書かずに用意する

`unitDefinitionId` / `memoryDefinitionIds` を手で書き写す必要はない。用途が2つに分かれる。

### 初回に編成を起こす — UIのドラフトを取り込む

UI は演習モードの編成を localStorage `mlgg:last-draft:exercise` へ保存している。書き出して
渡せば、UIの編成エディタ（ユニット選択・配置・適性表示）がそのまま入力手段になる。

1. UI（`mise run ui:dev` またはデプロイ済みの Pages）で演習モードの編成を組む
2. DevTools のコンソールで次を実行する

   ```js
   copy(localStorage.getItem("mlgg:last-draft:exercise"));
   ```

3. クリップボードの中身を `last-draft-exercise.json` として保存する（gitignore 済み）
4. 変換する

   ```bash
   uv run lab import-draft last-draft-exercise.json -o configs/formation.yaml
   ```

`-o` を省くと標準出力へ出る。生成物には**育成状態（レベル・ギア・学園レベル）を含めない** —
正本は `--player-data` 側に一本化してある。ドラフトの強化入力は読み飛ばす。

演習用ではなく通常戦闘の `mlgg:last-draft` を渡した場合、敵が2体以上のときと敵メモリーを
持つときはここで落とす。ただし**敵1体・敵メモリーなしの通常戦闘ドラフトは判別できない**
（保存形式が同じ `BattleDraft` のため）。その取り違えは `lab stats` の Catalog 検証が捕まえる
——通常戦闘の敵は `PLAYABLE` なので、演習の敵プール（`EXERCISE_ENEMY`）に合わず R-TEX-11 #1
で弾かれる。

### 反復編集する — エディタ補完を効かせる

Catalog から実IDを enum に焼いた JSON Schema を生成できる。

```bash
uv run lab schema           # 既定の出力先は .schema/formation.schema.json
```

編成YAMLの先頭へ次の1行を置くと、YAML Language Server（VSCode の `redhat.vscode-yaml` など）
が `unitDefinitionId:` や `memoryDefinitionIds:` でIDを補完し、その場で検証する。

```yaml
# yaml-language-server: $schema=../.schema/formation.schema.json
```

味方枠と敵枠には別々の enum が入るので、`R-TEX-11` #1（味方は `PLAYABLE`、敵は
`EXERCISE_ENEMY`）は実行前にエディタ上で分かる。補完候補には日本語表示名・role・
適性も添えてある（表示はエディタの実装次第）。学園レベルのキー9種と、
「`ally.academyLevels` なしにユニットの `level` / `gears` は書けない」もSchemaで表す。

**Schema は `lab stats` の受理条件をすべては表さない。** 味方の配置重複は、要素の一部
（`position`）についての一意性であり JSON Schema では表せないため、エディタは通し
`lab stats` がエラーにする。差異は `tests/test_schema.py` で固定してある。

生成物は Catalog revision に紐づくため gitignore してある。**Catalog を更新したら
`lab schema` を実行し直す。**

### IDを引く — カタログ検索

```bash
uv run lab units --owned --player-data player-data.json   # 手持ちだけに絞る
uv run lab units --grep 反逆                              # 表示名・キャラ名・IDの部分一致
uv run lab units --category EXERCISE_ENEMY                # 演習の敵一覧
uv run lab memories --grep 心
uv run lab units --grep コトハ --yaml                     # 編成YAMLへ貼れる形で出す
```

`--yaml` の `position` は仮置きなので、貼った後に実際の配置へ直す（配置は結果に影響する）。
未知IDを書いてしまった場合、`lab stats` のエラーがこの検索コマンドを案内する。

## 編成定義 YAML

`configs/formation.example.yaml` を写して使う。要点は次のとおり。

- ユニットとメモリーは**書いた順のまま**リクエストへ載る。UI と同じ並びで送るなら
  FRONT → REAR、各列は `column` 昇順に並べる。
- `ally.academyLevels` を書くと強化計算が有効になる。書かない場合、ユニット側の
  `level` / `gears` は指定できない（陣営の強化指定なしにユニットの強化だけ送ると API が 422 で拒む）。
- レベル 200・ギア 0 件のユニットは `enhancement` を送らない（API の省略時既定と同値のため）。
- 敵はちょうど 1 体・メモリーなし・強化なし。**配置は結果に影響する**（前後列優先の対象順や
  配置条件が参照するため）。

## 手持ちデータ（`mlgg:player-data`）の取り込み

ブラウザで入力したレベル・ギア・学園レベルを、編成 YAML へ書き写さずに使える。編成そのもの
（誰をどこへ置くか）はここでは決まらない——それは上の `import-draft` 側が持つ。

1. UI（`mise run ui:dev` またはデプロイ済みの Pages）を開く
2. DevTools のコンソールで次を実行する

   ```js
   copy(localStorage.getItem("mlgg:player-data"));
   ```

3. クリップボードの中身を `player-data.json` として保存する（このディレクトリ直下は gitignore 済み）
4. `--player-data player-data.json` を渡す

適用規則:

- YAML に書いた値が常に優先する。手持ちデータは「YAML に書かなかった項目」だけを埋める。
- `ally.academyLevels` を YAML に書いていなければ、手持ちデータの学園レベルが入り、強化計算が有効になる。
- 手持ちデータに無いユニットは警告を出し、レベル 200・ギアなしとして評価する。
- `schemaVersion` が 1 以外のデータは読み替えず失敗させる。

## 再現性

サーバーは1リクエストの中で `runIndex` を 0 から振り直し、乱数列を
`deriveRunSeed(hashSeedString(seed), runIndex)` で決める。したがって同じ `seed` のまま
リクエストを分割すると、**全チャンクがまったく同じ試行を繰り返す**。これを避けるため、
チャンクごとに通し試行番号を埋め込んだ `<seed>#<run_offset>` を送る。

この規約の帰結として、レポートを再現する鍵は `--seed` 単独ではなく
**`(--seed, --chunk-size, --runs)` の3つ**になる。3つが同じなら送信 seed もチャンク境界も
同じになり、同じ数値が出る。`summary.json` にはこの3つが記録される。

## 部分結果

期限（`SIMULATION_TIMEOUT_MS`）に達したチャンクは、完了した試行だけを返す（`200` の部分結果）。
このツールは**再送しない** — 同じ seed で同じ試行をやり直すことになり、同じところで切れるため。
不足は `summary.json` の `requestedRuns` と `completedRuns` の差として残り、コンソールにも
警告を出す。統計量は実際に完了した試行だけで算出する。

チャンクが頻繁に欠けるなら `--chunk-size` を下げるか、dev サーバーの `WORKER_MAX_THREADS` を上げる。

## 開発

```bash
uv run pytest
uv run ruff check src tests
uv run ruff format src tests
```
