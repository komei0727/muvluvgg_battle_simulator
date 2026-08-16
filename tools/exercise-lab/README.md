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

## 実行

```bash
cd tools/exercise-lab
uv run lab stats configs/formation.yaml --runs 1000 --seed abc123 --out reports/
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

ブラウザで入力したレベル・ギア・学園レベルを、編成 YAML へ書き写さずに使える。

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
