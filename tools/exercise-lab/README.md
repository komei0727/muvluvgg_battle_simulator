# exercise-lab

戦術演習（スコアアタック）のローカル専用ツール。役割は2つある。

- **統計** (`lab stats`) — 同一編成を大量に試行し、スコアの分布・信頼区間・ブレイク数分布・生データを出す
- **探索** (`lab optimize`) — 候補プールから、スコアの期待値が高く下振れの小さい編成を探す

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
| `lab optimize`     | 候補プールから上位編成を探す                         |
| `lab compare`      | 探索アルゴリズムを同一予算で比較する                 |
| `lab import-draft` | UIで組んだ演習編成を編成定義YAMLへ変換する           |
| `lab schema`       | エディタ補完用の JSON Schema を Catalog から生成する |
| `lab units`        | Catalog のユニットを検索してIDを引く                 |
| `lab memories`     | Catalog のメモリーを検索してIDを引く                 |

`stats` / `optimize` / `compare` 以外は編成を用意するための補助である
（「編成をIDで書かずに用意する」参照）。

## 実行

`configs/formation.example.yaml` は現行 Catalog の実IDで書かれており、そのまま実行できる。

```bash
cd tools/exercise-lab
uv run lab stats configs/formation.example.yaml --runs 200 --seed abc123 --out reports/
```

ただしこれは全員レベル200・ギアなし・強化計算なしの「素の性能」比較になる。実際の育成状態で
評価するなら、後述の「手持ちデータの取り込み」で `local_storage/player-data.json` を
書き出して渡す。

```bash
uv run lab stats configs/formation.example.yaml --runs 200 --seed abc123 \
  --player-data local_storage/player-data.json --out reports/
```

自分の編成を試すときはサンプルを写して編集する（`configs/` 直下はサンプル以外 gitignore 済み）。

```bash
cp configs/formation.example.yaml configs/formation.yaml
uv run lab stats configs/formation.yaml --runs 1000 --seed abc123 \
  --player-data local_storage/player-data.json --out reports/
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

## 最適編成を探す（`lab optimize`）

候補プールを与えると、その中からスコアの高い編成を探して上位5件を返す。探索変数は
**ユニットの選抜・6マスへの配置・メモリーの選抜**の3つである。

**メモリーの並び順は探索しない。** 発動解決順（R-MEM-02）は並びで決まるが、現行の
メモリー効果はどの順で解決してもスコアが動かない。並べ替えただけの編成は同じものとして
扱い、送信時はID順へ揃える。並びがスコアへ効くようになったら、順序を探索変数へ戻す
必要がある（`optimize/candidate.py` の冒頭にその前提を書いてある）。

```bash
uv run lab optimize configs/search.example.yaml --budget 5000 --seed abc123 \
  --player-data local_storage/player-data.json --out reports/
```

`configs/search.example.yaml` は現行 Catalog の実IDで書かれており、そのまま実行できる。
自分のプールで探すときはこれを写して編集する。

| オプション         | 既定           | 説明                                                       |
| ------------------ | -------------- | ---------------------------------------------------------- |
| `--budget`         | `5000`         | シミュレーション総試行数の上限。時間ではなく回数で切る。   |
| `--seed`           | 生成           | 省略時はランダム生成して先頭に表示する。                   |
| `--algorithm`      | `local-search` | `local-search` / `random` / `optuna`。                     |
| `--resume`         | なし           | 出力先の `state.json` から再開する。                       |
| `--out`            | `reports`      | レポート出力先。                                           |
| `--player-data`    | なし           | `mlgg:player-data` のエクスポート JSON。                   |
| `--max-candidates` | `32`           | 1リクエストの候補数上限（`EVALUATION_MAX_CANDIDATES`）。   |
| `--max-total-runs` | `300`          | 1リクエストの総試行数上限（`EVALUATION_MAX_TOTAL_RUNS`）。 |

### 何を最大化しているか

スコアアタックは1日 `bestOf` 回（既定5回）挑戦でき、その日の成績は**最大値**で決まる。
そこで平均ではなく **`λ × E[bestOf回中のベスト] + (1−λ) × 保証値`** を最大化する。
既定は `bestOf=5`・`λ=0.5`・`guardQuantile=0.25`。

- **期待日次ベスト** `E[best-of-k]` は、n回の評価から「ランダムにk回引いたときの最大値の
  期待値」を順序統計量の重み付き和で不偏推定した値。会心で伸びる上振れは資産として
  正しく評価され、稀な崩壊は「k回のうち1回を無駄にする」ぶんしか効かない
  （全滅は p^k でしか起きない）。下振れの正しいコストが指標そのものに織り込まれるので、
  別立ての下振れペナルティは持たない。
- **保証値**は日次ベストの `guardQuantile` 分位点。`P(日次ベスト ≤ x) = F(x)^k` の閉形式
  から、1試行分布の `q^(1/k)` 分位点として引ける（0.25 なら「4日に3日はこれ以上出る」値）。
  ごく稀な外れ値1本で期待値が吊り上がった編成への防波堤になる。

`bestOf` を上げるほど上振れ重視になるが、重みが上位の標本へ集中するぶん
**実効サンプル数は `n` ではなく約 `n(2k−1)/k²`**（k=5 で n の36%）に縮む。
`bestOf` を上げたら `finalStageRuns` も増やす。`λ=1` で純粋な期待日次ベストになる。

### 予算の配り方

全候補へ同じ試行数を配ると、見込みの薄い候補にも深い評価を払うことになる。そこで浅い評価で
広く篩い、生き残りにだけ試行数を積む（Successive Halving）。既定は `8 → 24 → 72` 試行で、
各段で上位半分だけが次へ進む。**第1段は中央値だけで判定する** — 8試行では期待日次ベストの
実効サンプルが約3しかなく順位が雑音になるためで、平均を使わないのは、稀な崩壊が平均だけを
線形に引き下げて「たまに崩れるが天井の高い編成」を浅い段で系統的に殺すためである。

最終選抜は**探索で1回も使っていない乱数の範囲**でやり直す。上位24件を50試行で篩い、
残った8件ほどを100試行まで積んで上位5件を確定する（SAR型レース）。探索が使ったのと同じ
乱数列で選ぶと、「その乱数列にたまたま強かった候補」をそのまま結果にしてしまう。

`--budget` は目安ではなく**上限**である。探索と最終選抜で分け合い、最終選抜のぶんは先に
取り置く。世代を始める前にその世代を回しきれるか確かめるので、途中で予算を食い破らない。
実行前に内訳と「1世代あたりの最大試行数」「最低予算」を表示する。予算が最低額に満たない
場合は、必要な額を添えて実行前に失敗する。

### 上位5件が5件に満たないことがある

同じ乱数列で**スコア列が完全に一致した**編成は1件に畳む。メモリーの並びを変えても結果が
まったく動かない組み合わせは珍しくなく、別物として数えると上位5件の枠が「並びだけ違う
同じ編成」で埋まって選択肢の役に立たない。畳んだ結果、報告が `topK` より少なくなることがある。
候補を増やしたいなら `finalPoolSize` を上げる。

### 出力

| ファイル            | 内容                                                  |
| ------------------- | ----------------------------------------------------- |
| `optimization.json` | 上位5編成の統計・編成表・探索条件・best-so-far 履歴。 |
| `evaluations.csv`   | 全評価の生値。探索後の横断分析の正本。                |
| `best-so-far.png`   | 消費試行数に対する暫定ベストの曲線。                  |
| `state.json`        | 中断・再開用の状態。`--resume` が読む。               |

コンソールには上位5編成の 適応度・期待日次ベスト・日次ベスト中央値・保証値・平均・敗北率・試行数の表と、
**UIへそのまま入力できる編成表**（表示名つきの配置とメモリーの並び）を出す。

### 再現性

`--seed` と探索設定が同じなら、何度走らせても同じ結果になる。中断して `--resume` した
場合も、中断せずに走らせた軌跡と一致する（乱数の位置と評価済みスコアの両方を保存している）。

### アルゴリズムを比べる

採用の根拠を残すために、同一予算・同一seedで並べて走らせられる。

```bash
uv run lab compare configs/search.example.yaml --budget 5000 --seed abc123 \
  --out reports/compare/
```

`comparison.png` に `best-so-far スコア vs 消費シミュレーション数` の曲線が重なり、
`comparison.json` に各実装の到達点が並ぶ。アルゴリズムごとの詳細レポートは
`reports/compare/<algorithm>/` に残る。評価器はアルゴリズムごとに作り直すので、
後から走る実装が先の実装の試行にただ乗りすることはない。

- `local-search` — 既知の良編成を種にした反復局所探索（既定）
- `optuna` — TPE + `WilcoxonPruner` + `enqueue_trial` によるウォームスタート
- `random` — 下限のベースライン

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

3. クリップボードの中身を `local_storage/draft/<名前>.json` として保存する
   （`local_storage/` 配下は gitignore 済み。編成ごとに名前を分けて残せる）
4. 変換する

   ```bash
   uv run lab import-draft local_storage/draft/kotoha-anis.json -o configs/formation.yaml
   ```

`-o` を省くと標準出力へ出る。生成物には**育成状態（レベル・ギア・学園レベル）を含めない** —
正本は `--player-data` 側に一本化してある。ドラフトの強化入力は読み飛ばす。

演習用ではなく通常戦闘の `mlgg:last-draft` を渡した場合、敵が2体以上のときと敵メモリーを
持つときはここで落とす。ただし**敵1体・敵メモリーなしの通常戦闘ドラフトは判別できない**
（保存形式が同じ `BattleDraft` のため）。その取り違えは `lab stats` の Catalog 検証が捕まえる
——通常戦闘の敵は `PLAYABLE` なので、演習の敵プール（`EXERCISE_ENEMY`）に合わず R-TEX-11 #1
で弾かれる。

### 反復編集する — エディタ補完を効かせる

Catalog から実IDを enum に焼いた JSON Schema を生成できる。編成定義YAMLと探索設定YAMLで
書式が違うため、Schemaも2つ出る。

```bash
uv run lab schema           # 既定の出力先ディレクトリは .schema/
```

| 生成物                          | 対象YAML                   |
| ------------------------------- | -------------------------- |
| `.schema/formation.schema.json` | 編成定義（`lab stats`）    |
| `.schema/search.schema.json`    | 探索設定（`lab optimize`） |

対象のYAMLの先頭へ対応する1行を置くと、YAML Language Server（VSCode の
`redhat.vscode-yaml` など）が `unitDefinitionId:` や `memoryDefinitionIds:` でIDを補完し、
その場で検証する。

```yaml
# yaml-language-server: $schema=../.schema/formation.schema.json
```

```yaml
# yaml-language-server: $schema=../.schema/search.schema.json
```

味方枠と敵枠には別々の enum が入るので、`R-TEX-11` #1（味方は `PLAYABLE`、敵は
`EXERCISE_ENEMY`）は実行前にエディタ上で分かる。補完候補には日本語表示名・role・
適性も添えてある（表示はエディタの実装次第）。学園レベルのキー9種と、
「`ally.academyLevels` なしにユニットの `level` / `gears` は書けない」もSchemaで表す。

探索設定は実IDを書く場所が多い——`unitPool` / `memoryPool` / `enemy` /
`constraints.fixedPlacements` / `constraints.requiredUnits` /
`constraints.requiredMemories` / `knownFormations` のすべてで補完が効く。
プール外のIDは矯正で黙って落とされる（打ち間違えたユニットが探索されないまま終わる）ので、
書いた時点で分かることの効きが大きい。

**Schema は受理条件をすべては表さない。** 味方の配置重複は、要素の一部（`position`）に
ついての一意性であり JSON Schema では表せないため、エディタは通し実行時にエラーになる。
差異は `tests/test_schema.py` / `tests/test_search_schema.py` で固定してある。

生成物は Catalog revision に紐づくため gitignore してある。**Catalog を更新したら
`lab schema` を実行し直す。**

### IDを引く — カタログ検索

```bash
uv run lab units --owned --player-data local_storage/player-data.json   # 手持ちだけに絞る
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

## 探索設定 YAML

`lab optimize` / `lab compare` の入力。`configs/search.example.yaml` を写して使う。
編成定義 YAML（`lab stats` の入力）とは別物で、確定した編成ではなく**探す範囲**を書く。

| キー              | 必須 | 内容                                                       |
| ----------------- | ---- | ---------------------------------------------------------- |
| `enemy`           | 必須 | 演習の敵1体と配置。`EXERCISE_ENEMY` のみ（R-TEX-11 #1）。  |
| `unitPool`        | 必須 | 探索するユニットのID。`PLAYABLE` のみ。                    |
| `memoryPool`      | 任意 | 探索するメモリーのID。                                     |
| `knownFormations` | 任意 | 既知の良編成。初期母集団の種になる。                       |
| `constraints`     | 任意 | 重複可否・固定スロット・必須ユニット・必須メモリー。       |
| `objective`       | 任意 | `bestOf`・`lambda`・`guardQuantile`。                      |
| `schedule`        | 任意 | 母集団サイズ・評価段の試行数・最終選抜の設定・`patience`。 |
| `operatorWeights` | 任意 | 近傍生成の重み。                                           |
| `academyLevels`   | 任意 | 学園レベル。`--player-data` を使うなら書かなくてよい。     |

`knownFormations` は初期母集団の**25%まで**しか入らない。種で埋め尽くすと集団が似通って
未知の組み合わせへ届かなくなるため、残りは種の変異体・ヒューリスティック種・ランダムで埋める。

`operatorWeights` の既定はユニット入替を低頻度（18%）にしてある。配置とメモリーの
組み合わせ最適化が主な目的で、ユニットの入れ替えは未知の構成を適度に探すための手だからである。
未知のユニット組み合わせをもっと掘りたいなら `unitSwap` / `unitAdd` を上げる。

`constraints.requiredMemories` は「入っていること」を強制する。並び順は探索対象では
ないので、指定しても位置は選べない。

ユニットとメモリーのIDは `lab units` / `lab memories` で引ける（「IDを引く」参照）。
`lab schema` を実行して先頭へ次の1行を置けば、エディタ上でIDが補完される。

```yaml
# yaml-language-server: $schema=../.schema/search.schema.json
```

未知IDと編成プール違反は、1試行も投げる前にカタログと突き合わせて検出する。

## 手持ちデータ（`mlgg:player-data`）の取り込み

ブラウザで入力したレベル・ギア・学園レベルを、編成 YAML へ書き写さずに使える。編成そのもの
（誰をどこへ置くか）はここでは決まらない——それは上の `import-draft` 側が持つ。

1. UI（`mise run ui:dev` またはデプロイ済みの Pages）を開く
2. DevTools のコンソールで次を実行する

   ```js
   copy(localStorage.getItem("mlgg:player-data"));
   ```

3. クリップボードの中身を `local_storage/player-data.json` として保存する
   （`local_storage/` 配下は gitignore 済み）
4. `--player-data local_storage/player-data.json` を渡す

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
