# API設計

## 目的

本書は、戦闘シミュレーションを外部クライアントへ提供するHTTP APIについて、次を定義する。

- エンドポイント、HTTPメソッド、ステータスコード
- リクエストと成功レスポンスのJSON契約
- 戦闘状態、イベントログ、状態差分の公開形式
- エラーレスポンスとアプリケーションエラーの対応
- タイムアウト、レスポンスサイズ、バージョニングなどの運用上の境界

本書は [08\_ドメインイベント.md](./08_ドメインイベント.md) と [09\_アプリケーション設計.md](./09_アプリケーション設計.md) を外部契約へ具体化する。HTTPフレームワークやバリデーションライブラリには依存しない。

## API方針

- 1回のHTTPリクエストで戦闘開始から終了まで同期実行する。
- 戦闘結果をサーバーへ保存しない。
- 成功時は勝敗、初期状態、最終状態、イベントログ、全状態差分を返す。
- APIの外部DTOとアプリケーションCommandを分離する。
- ドメインイベント名や内部クラス構造を無条件に公開しない。
- イベントと列挙値は表示文言ではなく、安定した機械判読可能なコードで返す。
- 数値や配列を暗黙に補正せず、不正な入力は構造化エラーとして返す。
- ログや状態履歴を途中で黙って切り捨てない。

### ユニットIDフィールド名の対応（wire契約 ⇔ Domain内部名）

戦闘中のユニットを指す3概念のフィールド名は、wire契約とDomain内部で**同一**であり読み替えは無い（REF-020／Issue #323）。同一概念に複数の名前を併存させると読み手に無用の区別を強いるため、内部名をwire名へ一本化した。

| 概念                 | wire契約・Domain内部で共通の名前           | 型             |
| -------------------- | ------------------------------------------ | -------------- |
| 効果・ダメージの対象 | `targetUnitId`（複数形は `targetUnitIds`） | `BattleUnitId` |
| 効果の付与元         | `sourceUnitId`                             | `BattleUnitId` |
| 行動主体             | `actorUnitId`                              | `BattleUnitId` |

廃止した内部名は `targetId` / `targetIds` / `targetBattleUnitId` / `sourceId` / `actorId` で、再導入は `UT-NAMING-001`〜`UT-NAMING-003`（`apps/api/src/__tests__/architecture/unit-id-naming.test.ts`）が機械的に禁止する。

`CatalogIntegrityViolation.targetId`（`11_インフラストラクチャ設計.md` のCatalogロード失敗行）だけは同名だが**別概念**であり、`BattleUnitId` ではなくCatalog定義ID（`UNIT_*` 等）を指す。この用途はwireへ現れない。

## エンドポイント

### 戦闘をシミュレーションする

```http
POST /api/v1/battle-simulations
```

指定された両陣営の編成で戦闘を最後まで実行し、完了結果を返す。

| 項目                   | 値                                                     |
| ---------------------- | ------------------------------------------------------ |
| 認証                   | M4.5ではなし。public Cloud Run serviceとして公開する。 |
| リクエストContent-Type | `application/json`                                     |
| レスポンスContent-Type | `application/json; charset=utf-8`                      |
| 成功ステータス         | `200 OK`                                               |
| 永続化                 | しない                                                 |
| 冪等性                 | 保証しない                                             |
| 既定ログレベル         | `SUMMARY`                                              |

新しい永続リソースを作成しないため `201 Created` は使用しない。途中処理を非同期ジョブとして受け付けるAPIではないため `202 Accepted` も使用しない。

### 戦術演習をシミュレーションする

```http
POST /api/v1/tactical-exercises
```

味方編成と敵ユニット1体で戦術演習（UC-03）を最後まで実行し、スコアとブレイク履歴を含む演習結果を返す。

| 項目                   | 値                                               |
| ---------------------- | ------------------------------------------------ |
| 認証                   | なし。戦闘シミュレーションと同じ公開条件とする。 |
| リクエストContent-Type | `application/json`                               |
| レスポンスContent-Type | `application/json; charset=utf-8`                |
| 成功ステータス         | `200 OK`                                         |
| 永続化                 | しない                                           |
| 冪等性                 | 保証しない                                       |
| 既定ログレベル         | `SUMMARY`                                        |

既存の `POST /api/v1/battle-simulations` の契約は変更しない（Q-TEX-08）。規定ターン数は5で固定であり、リクエストで指定できない。

### 編成の開始時ステータスをプレビューする

```http
POST /api/v1/formation-stat-previews
```

両陣営の編成と強化指定を受け取り、各参加枠の開始時ステータス（`R-STA-01` 適用後の戦闘中ステータスと最大HP）だけを返す。戦闘は実行しない。

| 項目                   | 値                                                   |
| ---------------------- | ---------------------------------------------------- |
| 認証                   | なし。戦闘シミュレーションと同じ公開条件とする。     |
| リクエストContent-Type | `application/json`                                   |
| レスポンスContent-Type | `application/json; charset=utf-8`                    |
| 成功ステータス         | `200 OK`                                             |
| 永続化                 | しない                                               |
| 冪等性                 | 同一リクエストは同一結果を返す（乱数を伴わないため） |

編成画面が強化指定の効果を実行前に確認するための読み取り専用エンドポイントである。算出の正本をDomainの1か所（`FormationFactory`）に保つためにサーバー側で計算し、クライアントへ `R-ENH-02`〜`06`・`R-BON-01`〜`03`・`R-STA-01` を再実装させない。

戦闘を実行しないため、乱数・イベント・状態差分・Worker Poolを伴わない。したがって `429`・`503`・`504` を返さず、HTTPメインスレッドで同期的に応答する。既存の `POST /api/v1/battle-simulations` の契約は変更しない（加算的変更）。

### 戦闘シミュレーション用Catalogを取得する

```http
GET /api/v1/battle-simulation-catalog
```

UIなどのクライアントが戦闘条件を構成するために必要なUnit・Memoryの一覧、表示用属性、現在の選択可否を返す。

| 項目                   | 値                                                     |
| ---------------------- | ------------------------------------------------------ |
| 認証                   | M4.5ではなし。public Cloud Run serviceとして公開する。 |
| リクエストContent-Type | 本文を持たないため不要。                               |
| レスポンスContent-Type | `application/json; charset=utf-8`                      |
| 成功ステータス         | `200 OK`、条件付きGETで未変更なら `304 Not Modified`   |
| 永続化                 | しない。起動時検証済みの不変read modelを返す。         |
| pagination             | 初期スコープでは使用しない。                           |

検索・属性filter・Role filterは初期件数ではクライアント側で行う。APIへquery parameterを追加せず、同一Catalog revisionのUnit・Memoryを1回のresponseで取得する。

このAPIはCatalog管理APIではない。Unit・Memory・Skillの登録、更新、削除を提供しない。

### ヘルスチェック

実装時は運用監視向けに次を分離してよい。

```http
GET /health/live
GET /health/ready
```

- `live` はプロセスが応答可能かだけを確認する。
- `ready` はCatalogの読み込みと構造検証が完了し、新規シミュレーションを受け付けられるかを確認する。
- 戦闘ルールやCatalog内容をレスポンスへ公開しない。

ヘルスチェックはBattle Simulation Contextのユースケースではなく、インフラストラクチャ上のエンドポイントとする。

## HTTPヘッダー

### リクエスト

| ヘッダー          | 必須 | 説明                                                                                 |
| ----------------- | ---- | ------------------------------------------------------------------------------------ |
| `Content-Type`    | 条件 | 本文を持つ戦闘POSTでは必須。`application/json` を指定する。Catalog GETでは送らない。 |
| `Accept`          | 任意 | 省略時は `application/json` とみなす。                                               |
| `X-Request-Id`    | 任意 | 呼び出し側の追跡ID。許容形式を満たさない場合はサーバー側で再生成する。               |
| `Accept-Encoding` | 任意 | 大きなレスポンス向けに圧縮方式を指定できる。                                         |
| `If-None-Match`   | 任意 | Catalog一覧GETで直前のETagを指定する。                                               |

`X-Request-Id` は戦闘結果や乱数へ影響させない。個人情報、認証情報、任意の長文を入れない。

### レスポンス

| ヘッダー           | 説明                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| `Content-Type`     | JSON本文を持つresponseでは `application/json; charset=utf-8`。304では送らない。 |
| `X-Request-Id`     | サーバーが採用した追跡ID                                                        |
| `Cache-Control`    | エンドポイント別。戦闘POSTは `no-store`。Catalog一覧GETは下記cache規則。        |
| `Content-Encoding` | 圧縮した場合に設定する。                                                        |
| `ETag`             | Catalog一覧GETの200応答で設定する。                                             |

戦闘には乱数が含まれ、同一リクエストの同一結果を保証しないため、共有キャッシュへ保存させない。

`Cache-Control: no-store`は戦闘シミュレーションPOSTとエラーレスポンスへ適用する。Catalog一覧GETの200応答は不変のrepresentation版をETagとして使い、`Cache-Control: public, max-age=300` を返す。`If-None-Match`が現在のETagと一致する場合は本文なしの304を返す。Catalog更新は新しいapplication deploymentであり、同一revisionの内容を稼働中に変更しない。

ETagは `catalogRevision` と `gearEffects`（R-ENH-04 #3の効果表）のfingerprintの両方から導出する。効果表はCatalog定義ファイルではなくコード定数であり `catalogRevision` に紐づかないため、`catalogRevision` だけを導出元にすると、効果表だけを変更したデプロイでETagが変わらず、クライアントが古い表を304で保持し続ける。ETagは不透明な文字列であり、導出元を増やしてもクライアント契約（比較して一致するかだけを見る）は変わらない。

## 戦闘シミュレーション用Catalogレスポンス

### JSON構造

```json
{
  "schemaVersion": 1,
  "catalogRevision": "2026-07-12.12",
  "units": [
    {
      "unitDefinitionId": "UNIT_MEIYA_FATED",
      "displayName": "【天命を受けし剣術乙女】御剣冥夜",
      "characterName": "御剣冥夜",
      "attribute": "SHY",
      "unitType": "PHYSICAL",
      "role": "PHYSICAL_ATTACKER",
      "positionAptitudes": ["FRONT"]
    }
  ],
  "memories": [
    {
      "memoryDefinitionId": "MEM_HEART_COLOR",
      "displayName": "心の色"
    }
  ],
  "gearEffects": [
    {
      "stat": "MAXIMUM_HP",
      "application": "RATIO",
      "values": [
        { "tier": "II", "grade": "D", "percentagePoints": 0.75 },
        { "tier": "III", "grade": "S", "percentagePoints": 3.33 }
      ]
    },
    {
      "stat": "CRITICAL_RATE",
      "application": "POINT",
      "values": [
        { "tier": "II", "grade": "D", "percentagePoints": 1.5 },
        { "tier": "III", "grade": "S", "percentagePoints": 7 }
      ]
    }
  ]
}
```

### BattleSimulationCatalogResponse

| プロパティ        | 型                               | 説明                                     |
| ----------------- | -------------------------------- | ---------------------------------------- |
| `schemaVersion`   | integer                          | response schema版。初期値1。             |
| `catalogRevision` | string                           | 一覧と戦闘事前検証が使用するCatalog版。  |
| `units`           | `CatalogUnitSummaryResponse[]`   | 全Unit。`unitDefinitionId`昇順。         |
| `memories`        | `CatalogMemorySummaryResponse[]` | 全Memory。`memoryDefinitionId`昇順。     |
| `gearEffects`     | `CatalogGearEffectResponse[]`    | R-ENH-04 #3のギア効果表。7ステータス分。 |

### CatalogUnitSummaryResponse

| プロパティ          | 型       | 必須 | 説明                                                                                    |
| ------------------- | -------- | ---- | --------------------------------------------------------------------------------------- |
| `unitDefinitionId`  | string   | 必須 | 不透明なUnit定義ID。                                                                    |
| `displayName`       | string   | 必須 | Catalog metadataの表示名。                                                              |
| `characterName`     | string   | 必須 | Catalog metadataのキャラクター名。                                                      |
| `category`          | string   | 必須 | 編成プールの区分（`PLAYABLE`／`EXERCISE_ENEMY`、R-TEX-11 #1）。未知の将来値を許容する。 |
| `exerciseActive`    | boolean  | 任意 | 開催中バッジ用の表示情報（R-TEX-11 #4）。`EXERCISE_ENEMY` のときだけ現れる。            |
| `attribute`         | string   | 必須 | Unit属性。未知の将来値を許容する。                                                      |
| `unitType`          | string   | 必須 | `PHYSICAL`、`ENERGY`、`AGILE`。未知の将来値を許容する。                                 |
| `role`              | string   | 必須 | Unit Role。将来追加を許容する。                                                         |
| `positionAptitudes` | string[] | 必須 | `FRONT`、`BACK`の1件以上。API編成入力の後衛 `REAR`とは名称が異なる。                    |

### CatalogMemorySummaryResponse

| プロパティ           | 型     | 必須 | 説明                       |
| -------------------- | ------ | ---- | -------------------------- |
| `memoryDefinitionId` | string | 必須 | 不透明なMemory定義ID。     |
| `displayName`        | string | 必須 | Catalog metadataの表示名。 |

### CatalogGearEffectResponse

| プロパティ    | 型                                 | 必須 | 説明                                                                     |
| ------------- | ---------------------------------- | ---- | ------------------------------------------------------------------------ |
| `stat`        | string                             | 必須 | 対象ステータス（R-ENH-01の7種）。未知の将来値を許容する。                |
| `application` | string                             | 必須 | `RATIO`（基本値への割合補正）、`POINT`（値そのものへの加算）。R-ENH-06。 |
| `values`      | `CatalogGearEffectValueResponse[]` | 必須 | 種別×ランクの全組み合わせ。                                              |

### CatalogGearEffectValueResponse

| プロパティ         | 型     | 必須 | 説明                                                                  |
| ------------------ | ------ | ---- | --------------------------------------------------------------------- |
| `tier`             | string | 必須 | ギアの種別（`II`／`III`）。未知の将来値を許容する。                   |
| `grade`            | string | 必須 | ギアのランク（`D`〜`S`）。未知の将来値を許容する。                    |
| `percentagePoints` | number | 必須 | R-ENH-04 #3の表の値。パーセントポイント表記のまま返し、`/100`しない。 |

効果表を公開するのは、クライアントが選択肢の上昇値を表示するために表を持たなくて済むようにするためである。クライアントは値を再計算せず、`application`で表記（割合か加算か）だけを切り替える。

### 情報公開境界

一覧APIは次を公開しない。

- Skill、EffectAction、Formula、Condition、triggeredEffectsの完全定義
- Catalogファイルパス、hash、manifest全文
- 画像URL。初期版はUIの任意アセットmapで解決する。

## リクエスト

### JSON構造

```json
{
  "allyFormation": {
    "units": [
      {
        "unitDefinitionId": "unit-001",
        "position": {
          "column": 0,
          "row": "FRONT"
        },
        "enhancement": {
          "level": 220,
          "gears": [{ "stat": "ATTACK", "tier": "III", "grade": "S" }]
        }
      }
    ],
    "memoryDefinitionIds": ["memory-001"],
    "enhancement": {
      "academyLevels": {
        "unitTypes": { "PHYSICAL": 50 },
        "attributes": { "AGGRESSIVE": 50 }
      }
    }
  },
  "enemyFormation": {
    "units": [
      {
        "unitDefinitionId": "unit-101",
        "position": {
          "column": 1,
          "row": "FRONT"
        }
      }
    ],
    "memoryDefinitionIds": []
  },
  "turnLimit": 10,
  "options": {
    "logLevel": "DETAILED"
  }
}
```

### BattleSimulationRequest

| プロパティ       | 型                  | 必須 | 制約                       |
| ---------------- | ------------------- | ---- | -------------------------- |
| `allyFormation`  | `FormationRequest`  | 必須 | 味方陣営の編成。           |
| `enemyFormation` | `FormationRequest`  | 必須 | 敵陣営の編成。             |
| `turnLimit`      | integer             | 必須 | 1～99。                    |
| `options`        | `SimulationOptions` | 任意 | 省略時は既定値を使用する。 |

未定義のトップレベルプロパティは拒否する。スペルミスを黙って無視して既定動作へ変えないためである。

### FormationRequest

| プロパティ            | 型                            | 必須 | 制約                    |
| --------------------- | ----------------------------- | ---- | ----------------------- |
| `units`               | `FormationUnitRequest[]`      | 必須 | 1～5件。                |
| `memoryDefinitionIds` | string[]                      | 必須 | 0～6件。                |
| `enhancement`         | `FormationEnhancementRequest` | 任意 | 陣営の強化指定（M11）。 |

同じ `unitDefinitionId` を複数指定できる。それぞれ別の参加枠として扱う。

メモリーIDの重複可否は現仕様で制限されていないため、API境界では拒否しない。同じメモリーを複数装備できるかなどのCatalog定義上の制約が追加された場合は、アプリケーション検証へ追加する。

### FormationEnhancementRequest

陣営の強化指定（R-ENH-01。M11で追加）。指定した陣営の全ユニットが強化計算の対象になり、タイプ装備・モジュールが常時適用される。省略した陣営は従来どおりユニット定義の基本ステータスを使用する。

| プロパティ      | 型                     | 必須 | 制約                                      |
| --------------- | ---------------------- | ---- | ----------------------------------------- |
| `academyLevels` | `AcademyLevelsRequest` | 任意 | 学園レベル。省略時は全系統1（加算なし）。 |

### AcademyLevelsRequest

| プロパティ   | 型     | 必須 | 制約                                                                                                 |
| ------------ | ------ | ---- | ---------------------------------------------------------------------------------------------------- |
| `unitTypes`  | object | 任意 | キーは `PHYSICAL`、`ENERGY`、`AGILE`。値は1以上の整数（上限なし）。省略したキーは1。                 |
| `attributes` | object | 任意 | キーは `AGGRESSIVE`、`SHY`、`CUTE`、`SMART`、`COMICAL`、`CLEVER`。値は1以上の整数。省略したキーは1。 |

### FormationUnitRequest

| プロパティ         | 型                         | 必須 | 制約                        |
| ------------------ | -------------------------- | ---- | --------------------------- |
| `unitDefinitionId` | string                     | 必須 | 空でない不透明な定義ID。    |
| `position`         | `FormationPositionRequest` | 必須 | 陣営内の配置。              |
| `enhancement`      | `UnitEnhancementRequest`   | 任意 | ユニットの強化指定（M11）。 |

定義IDはクライアントが解析しない不透明な文字列として扱う。大文字小文字を区別し、前後の空白を自動除去しない。

`enhancement` は所属する `FormationRequest` に `enhancement` があるときだけ指定できる。陣営の指定なしにユニットの `enhancement` を指定した場合は、アプリケーション検証の `422` として拒否する（黙って無視して既定動作へ変えない）。

### UnitEnhancementRequest

| プロパティ | 型              | 必須 | 制約                                                                                                                         |
| ---------- | --------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `level`    | integer         | 任意 | 1以上（上限なし）。省略時は200。`levelGrowth` を持たないユニットへの200以外の指定はアプリケーション検証の `422` として拒否。 |
| `gears`    | `GearRequest[]` | 任意 | 0～9件。省略時は0件。                                                                                                        |

### GearRequest

| プロパティ | 型     | 必須 | 制約                                                                                                            |
| ---------- | ------ | ---- | --------------------------------------------------------------------------------------------------------------- |
| `stat`     | string | 必須 | `MAXIMUM_HP`、`ATTACK`、`DEFENSE`、`ACTION_SPEED`、`CRITICAL_RATE`、`CRITICAL_DAMAGE_BONUS`、`AFFINITY_BONUS`。 |
| `tier`     | string | 必須 | `II` または `III`。                                                                                             |
| `grade`    | string | 必須 | `D`、`C`、`B`、`A`、`S`。                                                                                       |

同じ `stat` のギアを複数指定できる。補正割合は効果表（R-ENH-04）に従い単純加算する。

### FormationPositionRequest

| プロパティ | 型      | 必須 | 制約                                                    |
| ---------- | ------- | ---- | ------------------------------------------------------- |
| `column`   | integer | 必須 | 俯瞰時の絶対左から `0`、`1`、`2`。                      |
| `row`      | string  | 必須 | `FRONT` または `REAR`。各陣営から敵へ近い側が `FRONT`。 |

同じ陣営内で同じ `column` と `row` を二つの参加枠へ指定できない。敵味方は別編成なので、両陣営が同じ値を使用できる。

ドメインの共通座標への変換は次のとおり。

| 陣営 | row     | y   |
| ---- | ------- | --- |
| 敵   | `REAR`  | 0   |
| 敵   | `FRONT` | 1   |
| 味方 | `FRONT` | 2   |
| 味方 | `REAR`  | 3   |

`x` は両陣営とも `column` と同じ値とする。

### SimulationOptions

| プロパティ | 型     | 必須 | 既定値    | 制約                    |
| ---------- | ------ | ---- | --------- | ----------------------- |
| `logLevel` | string | 任意 | `SUMMARY` | `SUMMARY`、`DETAILED`。 |

既定を `SUMMARY` とするのは、既定の用途が編成比較であり、`DETAILED` を既定にすると指定しないクライアントが毎回数MBのレスポンスを受け取るためである。`DETAILED` は内部判定情報を多く含み、レスポンスも大きくなる。将来、公開環境で `DETAILED` の利用を制限する場合は、認可規則とエラーコードをAPI契約へ明示し、黙って `SUMMARY` へ落とさない。

`DIAGNOSTIC` は廃止した（「公開レベル」参照）。指定は `422 INVALID_COMMAND` で拒否し、黙って `DETAILED` として扱わない。

### TacticalExerciseRequest

`POST /api/v1/tactical-exercises` のリクエスト本文。

| プロパティ       | 型                  | 必須 | 制約                                                    |
| ---------------- | ------------------- | ---- | ------------------------------------------------------- |
| `allyFormation`  | `FormationRequest`  | 必須 | 味方陣営の編成。`BattleSimulationRequest` と同じ制約。  |
| `enemyFormation` | `FormationRequest`  | 必須 | `units` はちょうど1件、`memoryDefinitionIds` は空配列。 |
| `options`        | `SimulationOptions` | 任意 | 省略時は既定値を使用する。                              |

`turnLimit` は持たない。未定義のトップレベルプロパティ（`turnLimit` を含む）は拒否する。敵編成のユニット数・メモリー数の違反は、他の値域違反と同様にアプリケーション検証の `422` として返す。

編成プール（R-TEX-11: 味方は `PLAYABLE` のみ、敵は `EXERCISE_ENEMY` のみ）の違反も参照解決後のアプリケーション検証で `422`（`INVALID_COMMAND`）として返し、violation へ `ruleId: "R-TEX-11"` を載せる。通常戦闘 `POST /api/v1/battle-simulations` では両陣営とも `PLAYABLE` のみを受理する（同じ `ruleId` の `422`）。`exerciseActive` は受理条件に影響しない。

### FormationStatPreviewRequest

`POST /api/v1/formation-stat-previews` のリクエスト本文。編成部分は `BattleSimulationRequest` と同形にし、同じ `FormationRequest`（強化指定を含む）をそのまま送れるようにする。

| プロパティ       | 型                 | 必須 | 制約                                                                                                                  |
| ---------------- | ------------------ | ---- | --------------------------------------------------------------------------------------------------------------------- |
| `allyFormation`  | `FormationRequest` | 必須 | 味方陣営の編成。`units` は0～5件。                                                                                    |
| `enemyFormation` | `FormationRequest` | 必須 | 敵陣営の編成。`units` は0～5件。                                                                                      |
| `mode`           | string             | 任意 | `NORMAL`／`TACTICAL_EXERCISE`。省略時 `NORMAL`。R-TEX-11 #5の編成プール検証にだけ使い、ステータス計算へは影響しない。 |

`turnLimit` と `options` は持たない。戦闘を実行せず、ターン上限もログ公開レベルも結果に影響しないためである。未定義のトップレベルプロパティ（`turnLimit`・`options` を含む）は拒否する。

配置重複・値域・強化指定の検証、および定義IDの参照検証と `levelGrowth` 事前検証（`R-ENH-05` #5）は戦闘シミュレーションと同じ経路を再利用し、同じ `422` の `code`・`path` を返す。

人数の**下限だけ**が戦闘シミュレーション（`R-FRM-01` の1～5体）と異なり、0体の陣営を受け付ける。開始時ステータスは陣営ごとに独立して決まり（編成ボーナスも配置適性も自陣営の情報だけで求まる）、編成画面は片側ずつ埋めていくため、両陣営が揃うまで拒否するとプレビューを見たい場面のほとんどで返せなくなる。上限5体・配置重複・メモリー0～6件は戦闘と同じである。

### null・省略・空配列

- 必須プロパティへ `null` を指定できない。
- 任意プロパティは省略できるが、`null` は指定できない。
- メモリーを指定しない場合は `memoryDefinitionIds: []` とする。
- `options` を省略した場合だけ全オプションの既定値を使用する。
- 数値を文字列として送信できない。
- `NaN`、`Infinity`、小数の `turnLimit` や `column` は受理しない。

## Inbound Adapterでの変換

Inbound Adapterは外部DTOを次のようにCommandへ変換する。

| API DTO                 | Application Command         |
| ----------------------- | --------------------------- |
| `allyFormation.units`   | `allyFormation.slots`       |
| `enemyFormation.units`  | `enemyFormation.slots`      |
| `unitDefinitionId`      | `UnitDefinitionId`          |
| `{ column, row }`       | `FormationPositionInput`    |
| `memoryDefinitionIds`   | `MemoryDefinitionId[]`      |
| `*.enhancement`（陣営） | `FormationEnhancementInput` |
| `units[].enhancement`   | `UnitEnhancementInput`      |
| `turnLimit`             | `turnLimit`                 |
| `options.logLevel`      | `logLevel`                  |

DTOの構造検証に成功しても、IDの存在、配置重複、未対応ルールなどはアプリケーション層で検証する。Inbound AdapterはCatalogを直接参照しない。

`FormationStatPreviewRequest` も同じ表に従って `PreviewFormationStatsCommand` の `allyFormation`／`enemyFormation` へ変換する（`turnLimit`・`options` の行だけ対象外）。`mode` は指定があるときだけそのまま通す。

## 成功レスポンス

### JSON構造

```json
{
  "schemaVersion": 1,
  "battleId": "battle-01J...",
  "catalogRevision": "2026-06-28.1",
  "result": {
    "outcome": "ALLY_WIN",
    "completionReason": "ENEMY_DEFEATED",
    "completedTurn": 3
  },
  "initialState": {},
  "finalState": {},
  "unitSummaries": [],
  "events": [],
  "stateTransitions": []
}
```

### BattleSimulationResponse

| プロパティ         | 型                            | 説明                                                   |
| ------------------ | ----------------------------- | ------------------------------------------------------ |
| `schemaVersion`    | integer                       | レスポンス本文スキーマのバージョン。初期値は1。        |
| `battleId`         | string                        | 今回の実行を識別するID。結果取得用リソースIDではない。 |
| `catalogRevision`  | string                        | 今回使用したCatalogスナップショットの版。              |
| `result`           | `BattleResultResponse`        | 確定した勝敗。                                         |
| `initialState`     | `BattleStateResponse`         | `READY` 時点の状態。`stateVersion` は0。               |
| `finalState`       | `BattleStateResponse`         | `COMPLETED` 時点の状態。`SUMMARY` では省略する。       |
| `unitSummaries`    | `UnitBattleSummaryResponse[]` | ユニット別の戦闘集計。公開レベルに依存しない。         |
| `events`           | `BattleLogEventResponse[]`    | 公開レベルのイベント。`SUMMARY` では空配列。           |
| `stateTransitions` | `StateTransitionResponse[]`   | 全状態変更。`SUMMARY` では空配列。                     |

### BattleResultResponse

| プロパティ         | 型      | 値                                                                               |
| ------------------ | ------- | -------------------------------------------------------------------------------- |
| `outcome`          | string  | `ALLY_WIN` または `ALLY_LOSE`。                                                  |
| `completionReason` | string  | `ENEMY_DEFEATED`、`ALLY_DEFEATED`、`SIMULTANEOUS_DEFEAT`、`TURN_LIMIT_REACHED`。 |
| `completedTurn`    | integer | 戦闘が終了したターン。1～規定ターン数。                                          |

`SIMULTANEOUS_DEFEAT` の `outcome` は仕様に従い `ALLY_WIN` とする。

### TacticalExerciseResponse

`POST /api/v1/tactical-exercises` の成功レスポンス。`BattleSimulationResponse` と同じ構造を再利用し、`result` だけを演習結果へ差し替える。

| プロパティ         | 型                            | 説明                                             |
| ------------------ | ----------------------------- | ------------------------------------------------ |
| `schemaVersion`    | integer                       | レスポンス本文スキーマのバージョン。初期値は1。  |
| `battleId`         | string                        | 今回の実行を識別するID。                         |
| `catalogRevision`  | string                        | 今回使用したCatalogスナップショットの版。        |
| `result`           | `ExerciseResultResponse`      | 確定した演習結果。                               |
| `initialState`     | `BattleStateResponse`         | `READY` 時点の状態。                             |
| `finalState`       | `BattleStateResponse`         | `COMPLETED` 時点の状態。`SUMMARY` では省略する。 |
| `unitSummaries`    | `UnitBattleSummaryResponse[]` | ユニット別の戦闘集計。公開レベルに依存しない。   |
| `events`           | `BattleLogEventResponse[]`    | 公開レベルのイベント。`SUMMARY` では空配列。     |
| `stateTransitions` | `StateTransitionResponse[]`   | 全状態変更。`SUMMARY` では空配列。               |

### UnitBattleSummaryResponse

ユニット別の戦闘集計。両エンドポイントが同じ形で返す。配列順は `BattleStateResponse.units` と同じ（味方陣営を先に、各陣営は配置順）で、参加ユニット全件を必ず含む。

| プロパティ     | 型      | 説明                                                                     |
| -------------- | ------- | ------------------------------------------------------------------------ |
| `battleUnitId` | string  | 対象の戦闘ユニット。                                                     |
| `side`         | string  | `ALLY` または `ENEMY`。                                                  |
| `damageDealt`  | integer | このユニットが与えた実HP減少量の合計。0以上。                            |
| `damageTaken`  | integer | このユニットが受けた実HP減少量の合計。0以上。                            |
| `healingDone`  | integer | このユニットが行った実HP増加量の合計。0以上。                            |
| `finalHp`      | number  | `finalState` 時点の現在HP。`BattleUnitStateResponse.hp.current` と同値。 |
| `maximumHp`    | number  | `finalState` 時点の最大HP。`BattleUnitStateResponse.hp.maximum` と同値。 |
| `combatStatus` | string  | `finalState` 時点の `ACTIVE` / `DEFEATED`。                              |

#### 集計セマンティクス

集計元は**公開レベルによる間引き前の全イベント**である。`logLevel` を下げても `unitSummaries` の値は変わらない — 大量実行時の用途（勝敗とユニット別集計だけを見る）が `SUMMARY` で成立しなければ、レベルを下げる意味がないためである。

`damageDealt` / `damageTaken` は次の2イベントの `hitPointDamage` を合算する。

| イベント                  | 与ダメージの帰属先                    | 被ダメージの帰属先 |
| ------------------------- | ------------------------------------- | ------------------ |
| `DamageApplied`           | イベントエンベロープの `sourceUnitId` | `targetUnitId`     |
| `ContinuousDamageApplied` | イベントエンベロープの `sourceUnitId` | `targetUnitId`     |

- 計上するのは `hitPointDamage`（実際に減ったHP量）だけである。シールド吸収（`typedShieldAbsorbed` / `untypedShieldAbsorbed`）・サブユニット吸収（`subUnitAbsorbed`）・HPクランプで消えた超過分（`discardedDamage`）は含めない。`calculatedDamage` ではない。
- 反射ダメージ（`isReflectedDamage`）・リンクダメージ（`isLinkedDamage`）は `DamageApplied` として流れるため追加の規則を持たない。エンベロープの `sourceUnitId` が指すユニット（反射側・リンク発生側）の与ダメージへ計上される。
- `sourceUnitId` を持たない `ContinuousDamageApplied`（R-MEM-04 のMemory由来付与。`sourceSide` だけを持つ）は、被ダメージにだけ計上し与ダメージへは帰属させない。陣営から特定のユニットを推測して埋めることはしない。

`healingDone` は次の2イベントの `appliedAmount`（最大HPを超えない範囲で実際に増加したHP量）を合算し、いずれも**回復者**へ計上する。

| イベント             | 回復者                                | 実HP増加量      |
| -------------------- | ------------------------------------- | --------------- |
| `HealApplied`        | `details.sourceUnitId`                | `appliedAmount` |
| `HealingTransferred` | イベントエンベロープの `sourceUnitId` | `appliedAmount` |

- 要求量（`healAmount`）でも破棄分を含む `formulaResult` でもなく、実HP増加量を使う。
- `HealApplied.appliedAmount` は回復リンク（R-HEAL-04）の転送分を含まないため、`HealingTransferred.appliedAmount` を加えないと回復者の実回復量を過小に集計する。転送分の回復者は `HealingTransferred` のエンベロープ `sourceUnitId`（元の `HealApplied` と同じ回復者）であり、`details.fromUnitId`（リンク保持者）を回復者と読み替える推測はしない。

`unitSummaries` に現れないユニットIDを指すイベント（Rosterに存在しない `sourceUnitId` / `targetUnitId`）は、どの行へも計上しない。

### ExerciseResultResponse

| プロパティ         | 型                        | 値                                                    |
| ------------------ | ------------------------- | ----------------------------------------------------- |
| `completionReason` | string                    | `TURN_LIMIT_REACHED` または `ALLY_DEFEATED`。         |
| `completedTurn`    | integer                   | 演習が終了したターン。1～5。                          |
| `totalScore`       | integer                   | 総スコア（R-TEX-02）。0以上。                         |
| `breakCount`       | integer                   | ブレイク回数。0以上。                                 |
| `breaks`           | `ExerciseBreakResponse[]` | ブレイク履歴。発生順。`breakCount` と件数が一致する。 |

### ExerciseBreakResponse

| プロパティ               | 型      | 値                         |
| ------------------------ | ------- | -------------------------- |
| `breakNumber`            | integer | 1から始まるブレイク番号。  |
| `turnNumber`             | integer | ブレイクが発生したターン。 |
| `cumulativeScoreAtBreak` | integer | ブレイク時点の累計スコア。 |

勝敗（`outcome`）は含めない。

### FormationStatPreviewResponse

`POST /api/v1/formation-stat-previews` の成功レスポンス。

```json
{
  "schemaVersion": 1,
  "catalogRevision": "2026-06-28.1",
  "units": [
    {
      "side": "ALLY",
      "unitDefinitionId": "UNIT_MEIYA_FATED",
      "formationPosition": { "column": 0, "row": "FRONT" },
      "maximumHp": 12345,
      "combatStats": {
        "attack": 1234.5,
        "defense": 678.9,
        "criticalRate": 15,
        "actionSpeed": 120,
        "affinityBonus": 25,
        "criticalDamageBonus": 50
      },
      "enhancedBaseStats": {
        "maximumHp": 11223,
        "attack": 1122.3,
        "defense": 522.2,
        "criticalRate": 10,
        "actionSpeed": 120,
        "affinityBonus": 25,
        "criticalDamageBonus": 50
      }
    }
  ]
}
```

| プロパティ        | 型                                   | 説明                                               |
| ----------------- | ------------------------------------ | -------------------------------------------------- |
| `schemaVersion`   | integer                              | レスポンス本文スキーマのバージョン。初期値は1。    |
| `catalogRevision` | string                               | 算出に使用したCatalogスナップショットの版。        |
| `units`           | `FormationStatPreviewUnitResponse[]` | 各参加枠の開始時ステータス。味方、敵の順に並べる。 |

`units` は味方、敵の順に並べ、各陣営内はリクエストの `units` 配列と同じ順序とする。クライアントは配列位置でリクエストの枠と対応づけられる。

### FormationStatPreviewUnitResponse

| プロパティ          | 型                    | 説明                                                                                                     |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `side`              | string                | `ALLY` または `ENEMY`。                                                                                  |
| `unitDefinitionId`  | string                | 元となるユニット定義ID。                                                                                 |
| `formationPosition` | object                | `{ column, row }`。リクエストと同じ陣営内表現。                                                          |
| `maximumHp`         | number                | 開始時の最大HP。`BattleUnitStateResponse.hp.maximum` と同じ値。                                          |
| `combatStats`       | `CombatStatsResponse` | 開始時の戦闘中ステータス（後述の戦闘状態と同じ形・同じ単位）。                                           |
| `enhancedBaseStats` | object                | `R-ENH-06` の強化後基本ステータス。`CombatStatsResponse` と同じ形・同じ単位に `maximumHp` を加えたもの。 |

同じ編成・強化指定で `POST /api/v1/battle-simulations` を実行したときの `initialState.units[]` の `combatStats` と `hp.maximum` に一致する。プレビューは戦闘開始時の値だけを返し、`BattleStarted` で解決されるMemory由来の `triggeredEffects`（`R-MEM-03`）や戦闘中のバフ・デバフは含まない。

`maximumHp` は `CombatStatsResponse` が `maximumHp` を持たない（公開上の置き場所が `hp.maximum` である）ため、ユニット直下へ置く。`R-NUM-01` に従い丸めない——`BattleUnitStateResponse.hp.maximum` も同じく丸めない全精度値であり、ここで整数へ落とすと両者が一致しなくなる。表示上の丸めはクライアントの責務とする。

`enhancedBaseStats` は `combatStats` の算出元になった `R-STA-01` の基本値であり、編成補正（`R-BON-01`〜`03`）と適性補正を**適用する前**の値である。編成画面が補正込みの値と補正前の値を切り替えて示せるように公開する。強化指定のない陣営ではユニット定義の基本ステータスと一致する。`maximumHp` は `combatStats` 側と違ってこのオブジェクトの内側へ置く——外側へ出す理由（`hp.maximum` との公開上の対応）が補正前の値には無いためである。AP・PPは編成画面の表示対象ではないため含めない。`R-NUM-01` に従い丸めない。

補正の内訳（編成補正・適性補正それぞれの量）は返さない。`combatStats` との差から逆算できるのは合成後の補正量だけであり、内訳が要るようになった時点で改めて公開項目を決める。

## 戦闘状態

### BattleStateResponse

```text
BattleStateResponse {
  stateVersion
  battleStatus
  turnNumber
  cycleNumber
  units[]
  actionQueue[]
}
```

| プロパティ     | 型                            | 説明                                            |
| -------------- | ----------------------------- | ----------------------------------------------- |
| `stateVersion` | integer                       | 状態変更ごとに増加するバージョン。初期状態は0。 |
| `battleStatus` | string                        | `READY`、`RUNNING`、`COMPLETED`。               |
| `turnNumber`   | integer                       | 開始前は0、開始後は1～99。                      |
| `cycleNumber`  | integer                       | 周回外は0、ターン内では1以上。                  |
| `units`        | `BattleUnitStateResponse[]`   | 味方、敵の順で、各陣営は配置順に並べる。        |
| `actionQueue`  | `ActionReservationResponse[]` | 現在の未行動予約。順位順。                      |

配列順は表示上の安定性のため定めるが、差分適用や同一性判定には各IDを使用する。

### BattleUnitStateResponse

```text
BattleUnitStateResponse {
  battleUnitId
  unitDefinitionId
  side
  formationPosition
  coordinate
  combatStatus
  hp
  resources
  combatStats
  shields
  subUnits[]
  effects[]
  markers?[]
  cooldowns[]
  charge?
}
```

| プロパティ          | 型                        | 説明                                                                                                                                                                                                   |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `battleUnitId`      | string                    | この戦闘内の参加枠ID。                                                                                                                                                                                 |
| `unitDefinitionId`  | string                    | 元となるユニット定義ID。                                                                                                                                                                               |
| `side`              | string                    | `ALLY` または `ENEMY`。                                                                                                                                                                                |
| `formationPosition` | object                    | `{ column, row }`。リクエストと同じ陣営内表現。                                                                                                                                                        |
| `coordinate`        | object                    | `{ x, y }`。3×4共通座標。                                                                                                                                                                              |
| `combatStatus`      | string                    | `ACTIVE` または `DEFEATED`。                                                                                                                                                                           |
| `hp`                | `CurrentMaximumValue`     | 現在HPと最大HP。                                                                                                                                                                                       |
| `resources`         | `ResourceStateResponse`   | AP、PP、EXゲージ。                                                                                                                                                                                     |
| `combatStats`       | `CombatStatsResponse`     | 現時点で有効な戦闘ステータス。                                                                                                                                                                         |
| `shields`           | `ShieldStateResponse`     | タイプ別シールドプール。                                                                                                                                                                               |
| `subUnits`          | `SubUnitStateResponse[]`  | サブユニットごとの耐久状態。                                                                                                                                                                           |
| `effects`           | `EffectStateResponse[]`   | 個別管理される全効果インスタンス。                                                                                                                                                                     |
| `markers`           | `MarkerStateResponse[]`   | 対象ごとに1インスタンスのMarker。EFF-004でv1へ追加した任意プロパティ（「schemaVersion」の後方互換規則により必須にしない）。Response Mapperは常に値を設定する（`charge`のように省略されることはない）。 |
| `cooldowns`         | `CooldownStateResponse[]` | 残数があるスキルクールタイム。                                                                                                                                                                         |
| `charge`            | `ChargeStateResponse`     | チャージ中だけ存在する。                                                                                                                                                                               |

### HP・リソース

```json
{
  "hp": {
    "current": 850,
    "maximum": 1000
  },
  "resources": {
    "ap": { "current": 2, "maximum": 3 },
    "pp": { "current": 1, "maximum": 2 },
    "extraGauge": { "current": 40, "maximum": 100 }
  }
}
```

- HPの `current` と `maximum` は0以上の有限numberとし、戦闘中ステータス計算の途中値を丸めない。
- AP、PP、EXゲージの `current` と `maximum` は0以上のintegerとする。
- いずれも `current` は `maximum` を超えない。
- 戦闘不能時のHPは0とする。
- EXゲージ最大値はユニットごとに異なる。

### CombatStatsResponse

```text
CombatStatsResponse {
  attack
  defense
  criticalRate
  actionSpeed
  affinityBonus
  criticalDamageBonus
}
```

割合値はパーセントポイントで返す。例えば `criticalRate: 15` は15%を表す。会心率そのものは0～100へ制限せず、会心判定時だけ内部で補正する。

値はJSON numberで返す。ダメージなど仕様上整数に確定した値はintegerとする。`DETAILED` が途中計算値を返す場合も `NaN` や無限値を返してはならない。

### ShieldStateResponse

```json
{
  "physical": 100,
  "energy": 50,
  "untyped": 30
}
```

シールドはタイプごとの合計プールを0以上の有限numberで返し、効果量計算の途中値を丸めない。サブユニット耐久値は消費順と個別状態が異なるため `subUnits` へ分ける。

### EffectStateResponse

```text
EffectStateResponse {
  effectInstanceId
  effectDefinitionId
  sourceUnitId?
  sourceSide?
  category
  effectKindKey
  statusKind?
  stackMode
  isEffective
  value
  duration
  appliedTurnNumber
  appliedActionId?
}
```

| プロパティ      | 説明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sourceSide`    | Memory の `triggeredEffects` 由来の効果だけが持つ付与元の陣営（`R-MEM-04`、M7-006/Issue #179）。この場合 `sourceUnitId` は持たない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `category`      | `BUFF`、`DEBUFF`、`STATUS_ABNORMALITY`のいずれか。状態異常はデバフの一種だが、解除・無効判定のため区別して返す。分類は解除・免疫判定と同じ`effect-category-classifier.ts`が付与時点に確定した`EffectSnapshot.categories`だけから導く（`STATUS`を含めば`STATUS_ABNORMALITY`、次に`DEBUFF`を含めば`DEBUFF`、それ以外は`BUFF`）。したがって`R-STS-01`が定義する状態異常5種——気絶・凍結・暗闇（`APPLY_STATUS`）に加えて**炎上・毒**（`APPLY_CONTINUOUS_DAMAGE`）——がいずれも`STATUS_ABNORMALITY`になる。`STEALTH`/`EVASION`/`DAMAGE_IMMUNITY`等の対象に有利な`APPLY_STATUS`は`BUFF`、固定継続ダメージ（`FIXED`）は状態異常ではないため`DEBUFF`である。効果量の符号からは導かない（Issue #224: 継続ダメージは`magnitude`がダメージ量＝正値のため、符号で分類すると毒・炎上が公開API上だけ`BUFF`になりDomain分類と矛盾する）。 |
| `effectKindKey` | 重複判定で同種を識別する安定したキー。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `statusKind`    | `APPLY_STATUS`由来の効果だけが持つ状態の種別（`EffectApplied.details.statusKind`と同じ列挙、M7-009/Issue #182）。有利な状態（`category: BUFF`）も含めて設定するため、`STATUS_ABNORMALITY`かどうかの判定には使わず`category`を見る。クライアントが`effectKindKey`の命名規則を解析せずに気絶・凍結・暗闇・隠密などを表示できるようにする。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `stackMode`     | `STACKABLE` または `NON_STACKING`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `isEffective`   | 現在の計算へ採用されているか。重複なしの次点効果はfalse。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `value`         | 効果種別ごとの構造化された値。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `duration`      | `{ unit: "ACTION" \| "TURN" \| "SKILL_USE", remaining: integer }`。永続効果では省略する（TGT-004フェーズ1／Issue #167で`SKILL_USE`を追加）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

`effectKindKey` を `value` の判別子として使用し、効果種別ごとの `value` スキーマはOpenAPIの `oneOf` で定義する。重複あり効果と、再付与された重複なし効果を別インスタンスとしてすべて返す。最強効果が失効した後に次点を有効化できる状態を失わない。

### MarkerStateResponse

```text
MarkerStateResponse {
  markerInstanceId
  markerId
  sourceUnitId?
  sourceSide?
  stackCount
  stackMax
  duration?
}
```

| プロパティ         | 説明                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `markerInstanceId` | 個別インスタンスの安定したドメインID。                                                                              |
| `markerId`         | Marker種別を識別するID（`MARKER_` 接頭辞）。                                                                        |
| `sourceUnitId`     | 直近の付与者。複数付与元から同じMarkerが付与された場合も対象ごとに単一インスタンスへ積む。                          |
| `sourceSide`       | Memory の `triggeredEffects` 由来のMarkerだけが持つ付与元の陣営（`R-MEM-04`）。この場合 `sourceUnitId` は持たない。 |
| `stackCount`       | 現在のスタック数（0未満にならない）。                                                                               |
| `stackMax`         | スタック上限。上限なしは `null`。                                                                                   |
| `duration`         | `{ unit: "ACTION" \| "TURN", remaining: integer }`。永続効果では省略する。                                          |

`EffectStateResponse` と異なり `category`/`stackMode`/`isEffective`/`value` を持たない。Markerは重複あり・なしの選択（R-EFF-05）の対象ではなく、対象ごとに常に1インスタンスだけが存在し、`ADD`/`KEEP_EXISTING`/`REFRESH`/`REPLACE`の付与方針でこのインスタンスを更新する（R-EFF-10）。

#### Memory由来Markerの付与元（M7-008 / Issue #176、REL-008 / Issue #263）

R-MEM-04 の Memory は使用者 `BattleUnit` を持たないため、Memory が付与した `MarkerState` は付与者ユニットの代わりに付与元陣営（`sourceSide`）だけを持つ。M7-008 でこの表現を Domain・`StateDelta`・`MarkerApplied`/`MarkerUpdated` の各payloadへ実装した時点では、`MarkerStateResponse.sourceUnitId`（および同名のイベント `details` プロパティ）が必須のままだったため、Memory が Marker を付与する production 定義（`MEM_ALWAYS_PICO_BESIDE_YOU`）は編成不可として弾いていた。

REL-008 で `EffectStateResponse`・`EffectApplied` と同じ「`sourceUnitId` と `sourceSide` のどちらか一方だけを持つ」形へ揃え、`/api/v1`・`schemaVersion: 1` のまま公開した。下記「バージョニング」の後方互換な追加として扱う根拠は次のとおりである。

- ユニットが付与した Marker は従来どおり常に `sourceUnitId` を持つため、既存クライアントがそれまで受け取れたレスポンスの形は変わらない。
- `sourceUnitId` を持たない変種は `CAP_MEMORY_GRANTED_MARKER` が編成段階で弾いていたため、v1 のレスポンスとして一度も出現していない。解放によって初めて現れる新しい変種である。

付与者を推測して埋めることはしない（`08_ドメインイベント.md`「Markerイベント」と同じく、代替の付与者を作らない）。

### SubUnitStateResponse

```text
SubUnitStateResponse {
  subUnitInstanceId
  subUnitDefinitionId
  sourceUnitId?
  durability: CurrentMaximumValue
  appliedTurnNumber
  appliedActionId?
}
```

サブユニットは同じ表示用シールド合計へ含まれる場合でも、消費順と固有効果を追跡するためインスタンスごとに返す。`DMG-005`（Issue #190）で `APPLY_SUBUNIT` 由来の効果インスタンス（`AppliedEffect.subUnit`）へ配線した — `durability.maximum` は付与時の最大耐久力、`durability.current` は吸収で減った残量である。耐久力が0になったインスタンスは `EffectExpired`（`reason: SUBUNIT_DEPLETED`）で失効するため、この配列には現れない。

### CooldownStateResponse

```text
CooldownStateResponse {
  skillDefinitionId
  unit: ACTION | TURN
  remaining
  setAtActionId?
  setAtTurnNumber?
}
```

設定した同じ行動・ターンでは減算しないことを追跡できるよう、設定スコープを含める。`unit`に応じて対応する側だけが存在する（`ACTION`なら`setAtActionId`、`TURN`なら`setAtTurnNumber`）。Domain側もこの設定scopeを行動単位・ターン単位のいずれか一方でしか保持しないため（`06_戦闘状態遷移.md`R-SKL-04）、両方を常に返す契約にはしない。

#### 設定スコープを持たないクールタイム（REL-004 / Issue #203）

対応する側の設定スコープも省略され得る。PSがターン開始・終了など**行動外のトップレベルイベント**から発動した場合、R-SKL-04のクールタイムは対応する`actionId`を持たず、その**不在自体**が「どの行動でも設定スコープに一致しない＝所有者の次の行動終了で減る」の正本になる（`08_ドメインイベント.md`「差分がフィールドを持たないこと」と同じ扱い）。したがって`setAtActionId`・`setAtTurnNumber`はいずれも任意とする。

この緩和は「バージョニング」の後方互換な追加に当たる。設定スコープなしの変種は一度も公開されたことがなく（Response Mapperが不変条件違反として落とし、実HTTP経路が`500 INTERNAL_INVARIANT_VIOLATION`を返していた。実在Unit`UNIT_LUCIE_MAID`の`SKL_LUCIE_MAID_PS1`が該当）、従来から公開されていた「行動内で設定されたクールタイム」は緩和後も必ず`setAtActionId`を持つため、既存クライアントが受け取れたレスポンスの形は変わらない。

### ChargeStateResponse

```text
ChargeStateResponse {
  skillDefinitionId
  startedActionId
  status: CHARGING | RELEASE_READY | HELD_BY_FREEZE
}
```

チャージ開始と効果発動は別行動であるため、開始行動IDを保持する。チャージが解除、発動またはキャンセルされた後は `charge` 自体を省略する。

### ActionReservationResponse

```text
ActionReservationResponse {
  order
  battleUnitId
  actionSpeedAtOrdering
  reservedActionType: ACTIVE_SKILL | EXTRA_SKILL
}
```

速度変化で並べ替えた後も `reservedActionType` は変更しない。

## イベントログ

### BattleLogEventResponse

```text
BattleLogEventResponse {
  sequence
  type
  category
  turnNumber
  cycleNumber
  actionId?
  skillUseId?
  parentSequence?
  rootSequence
  sourceUnitId?
  sourceSide?
  targetUnitIds[]
  details
  stateVersionBefore
  stateVersionAfter
  stateTransitionIndex?
}
```

| プロパティ             | 説明                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sequence`             | 内部イベント列と同じ1以上の連番。公開レベルによる欠番を許容する。                                                   |
| `type`                 | `DAMAGE_APPLIED` など公開イベント種別。                                                                             |
| `category`             | `FACT`、`TIMING`、`DIAGNOSTIC`。                                                                                    |
| `parentSequence`       | 直接の原因イベントが公開されているかにかかわらず、元の連番を返す。                                                  |
| `rootSequence`         | 解決スコープの起点イベント連番。                                                                                    |
| `sourceSide`           | Memory由来イベント（`MemoryTriggered`等）だけが持つ発生源の陣営。この場合`sourceUnitId`は持たない。                 |
| `targetUnitIds`        | 対象なしの場合は空配列。対象順を保持する。                                                                          |
| `details`              | イベント種別ごとのJSON object。                                                                                     |
| `stateTransitionIndex` | このイベントが所有する状態変更の `stateTransitions` 配列における0始まりのインデックス。状態変更がなければ省略する。 |

イベントへ状態差分本体を重複して埋め込まず、`stateTransitionIndex` で全状態履歴を参照する。これにより、イベントから変化を追跡できる要件を保ちつつレスポンスサイズを抑える。

公開イベントの `type` は大文字スネークケースとし、API v1内では意味を変更しない。新しいイベント種別を追加する可能性があるため、クライアントは未知の `type` だけでレスポンス全体を拒否しないことが望ましい。

### detailsの規則

- 表示用の日本語文章を含めない。
- ID、列挙値、計算値など構造化された情報を持つ。
- イベント種別ごとにスキーマを定義する。
- 共通エンベロープに存在する値を無目的に重複しない。
- 最大の公開レベルである `DETAILED` でも、乱数の内部状態やサーバー実装情報、スタックトレース、ファイルパス、秘密情報を含めない。DIAGNOSTICカテゴリのイベント（候補除外・乱数判定・超過切り捨て）も同じ規則に従う。

例：

```json
{
  "sequence": 42,
  "type": "DAMAGE_APPLIED",
  "category": "FACT",
  "turnNumber": 2,
  "cycleNumber": 1,
  "actionId": "action-8",
  "skillUseId": "skill-use-11",
  "parentSequence": 40,
  "rootSequence": 31,
  "sourceUnitId": "ally:1",
  "targetUnitIds": ["enemy:1"],
  "details": {
    "damageType": "PHYSICAL",
    "calculatedDamage": 250,
    "shieldAbsorbed": 50,
    "hpDamage": 200,
    "defeated": false
  },
  "stateVersionBefore": 15,
  "stateVersionAfter": 16,
  "stateTransitionIndex": 15
}
```

### 公開レベル

| レベル     | 含めるもの                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUMMARY`  | `result`・`initialState`・`unitSummaries`（演習は `breaks` も）。イベントと状態差分は返さず、`finalState` は省略する。                                                  |
| `DETAILED` | 全イベント。スキル、PS、各ヒット、ダメージ、シールド、効果、リソース変更に加え、候補除外・乱数判定・上限超過などの診断イベントを含む。加えて全状態差分と `finalState`。 |

用途は「大量実行して勝敗とユニット別集計だけを見る」（`SUMMARY`）と「効果発動を追う」（`DETAILED`）の2つしかない。既定値は `SUMMARY` とする。

`SUMMARY` はイベント・状態差分・`finalState` を返さない。前者の用途が必要とするのは勝敗とユニット別集計だけであり、主要イベントを数種類だけ返しても読まれないまま応答サイズだけが増えるためである。表示に要る最終HP・戦闘状態は `unitSummaries` が運ぶ。`initialState` だけは残す — クライアントが表示用Rosterを解決する唯一の入力だからである。

`DIAGNOSTIC` は廃止した。`DETAILED` と同一挙動になった以上、同じ意味の値が2つある状態を公開契約へ残さない。指定は `422 INVALID_COMMAND`（`path: /options/logLevel`）で拒否する。

公開レベルは**公開量だけ**を決める。サーバー内部の整合性検証（`stateVersion` の連続性、独立Reducerによる `initialState` + 全差分 = `finalState` の一致）はレベルに関係なく全量で行う。`SUMMARY` だから検証が緩むことはない。

`DETAILED` では従来どおり、状態変更を `stateTransitions` へすべて含める。`unitSummaries` はレベルに関係なく間引かない。

## 状態差分

### StateTransitionResponse

```text
StateTransitionResponse {
  causedBySequence
  stateVersionBefore
  stateVersionAfter
  delta: BattleStateDeltaResponse
}
```

- `stateTransitions` は `stateVersionAfter` の昇順に並べる。
- 先頭の `stateVersionBefore` は0とする。
- 各要素の `stateVersionAfter` は `stateVersionBefore + 1` とする。
- 前要素の `stateVersionAfter` と次要素の `stateVersionBefore` は一致する。
- 状態変更のないイベントに要素を作らない。
- `causedBySequence` は状態変更を所有する主イベントの連番とする。

### BattleStateDeltaResponse

```text
BattleStateDeltaResponse {
  battle?
  units?
  actionQueue?
  exercise?
}
```

```text
battle: {
  battleStatus?: ValueChange
  turnNumber?: ValueChange
  cycleNumber?: ValueChange
}

exercise: {
  totalScore?: ValueChange
  breakCount?: ValueChange
}
```

`exercise` は戦術演習だけで現れる（R-TEX-02／03）。

```text
units: {
  [battleUnitId]: UnitStateDeltaResponse
}

actionQueue: {
  before: ActionReservationResponse[]
  after: ActionReservationResponse[]
}
```

`ValueChange` は `{ before, after }` とする。変更されていないプロパティは省略し、値がなくなったことを表す必要がある場合だけ `after: null` を使用する。

### UnitStateDeltaResponse

```text
UnitStateDeltaResponse {
  combatStatus?: ValueChange
  hp?: ValueChange
  hpMaximum?: ValueChange
  resources?: {
    ap?: ValueChange
    pp?: ValueChange
    extraGauge?: ValueChange
  }
  resourceMaximums?: {
    ap?: ValueChange
    pp?: ValueChange
    extraGauge?: ValueChange
  }
  combatStats?: {
    [statName]: ValueChange
  }
  shields?: {
    [shieldType]: ValueChange
  }
  subUnits?: EntityCollectionDelta
  effects?: EntityCollectionDelta
  markers?: EntityCollectionDelta
  cooldowns?: EntityCollectionDelta
  charge?: ValueChange
  baseCombatStats?: {
    [statName]: ValueChange
  }
}
```

`baseCombatStats` は戦術演習のブレイク強化（R-TEX-04、`UnitRevived` が所有）だけで現れる基礎戦闘ステータスの書き換え差分であり、通常戦闘では発生しない。

`resources` は `BattleUnitStateResponse.resources.{ap,pp,extraGauge}.current`（現在値）の差分、`resourceMaximums` は同じゲージの `.maximum`（上限）の差分であり、互いに独立に変化する（G-09／M7-002A・Issue #255、`MODIFY_RESOURCE_CAPACITY`）。

HPも同じく `hp`（`hp.current` の差分）と `hpMaximum`（`hp.maximum` の差分）に分かれる。Domain側ではHP上限は `MAXIMUM_HP` 戦闘中ステータス（`stateDelta.combatStats.maximumHp`）だが、`CombatStatsResponse` は `maximumHp` を持たず `hp.maximum` が公開上の置き場所であるため、差分も同じ場所へ運ぶ。`APPLY_STAT_MOD(MAXIMUM_HP)` と `MODIFY_RESOURCE_CAPACITY(resource: HP)` の両方がこの差分を生む。

`combatStats` は `BattleUnitStateResponse.combatStats` と同じキー集合だけを持ち、`maximumHp` は含まない（`hpMaximum` が運ぶ）。`criticalRate` / `affinityBonus` / `criticalDamageBonus` は `CombatStatsResponse` と同じくパーセントポイントで表す — 差分だけを比率のまま返すと、クライアントが `ValueChange.before` を現在値と突き合わせられない。

`EntityCollectionDelta` は次の形式とする。

```text
EntityCollectionDelta {
  added: object[]
  updated: Array<{ id, before, after }>
  removed: Array<{ id, before }>
}
```

配列位置に依存するJSON Patchは使用しない。`battleUnitId`、`effectInstanceId`、`skillDefinitionId` など安定したドメインIDで差分対象を識別する。

### 差分の適用

```text
reconstructedFinalState = apply(
  initialState,
  stateTransitions ordered by stateVersionAfter
)
```

`reconstructedFinalState` は `finalState` と一致しなければならない。クライアントはイベント配列ではなく `stateTransitions` を状態復元の正本として使用する。

## エラーレスポンス

### ErrorResponse

成功レスポンスとエラーレスポンスを同じ本文に混在させない。

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "INVALID_COMMAND",
    "message": "The request contains invalid battle conditions.",
    "violations": [
      {
        "path": "/allyFormation/units/1/position",
        "ruleId": "FORMATION_POSITION_DUPLICATED",
        "message": "The position is already occupied."
      }
    ],
    "diagnosticId": "diag-01J..."
  }
}
```

### ErrorObject

| プロパティ     | 型     | 必須 | 説明                                                     |
| -------------- | ------ | ---- | -------------------------------------------------------- |
| `code`         | string | 必須 | クライアントが分岐に使用する安定したエラーコード。       |
| `message`      | string | 必須 | 人が読める概要。ロジック判定には使用しない。             |
| `violations`   | array  | 必須 | 個別違反。存在しない場合は空配列。                       |
| `diagnosticId` | string | 任意 | サーバーログと照合するID。内部情報そのものは公開しない。 |

### ViolationResponse

| プロパティ     | 型     | 必須 | 説明                         |
| -------------- | ------ | ---- | ---------------------------- |
| `path`         | string | 任意 | JSON Pointer形式の入力位置。 |
| `definitionId` | string | 任意 | 問題がある定義ID。           |
| `ruleId`       | string | 任意 | 違反規則ID。                 |
| `message`      | string | 必須 | 個別違反の説明。             |

`message` の文言は互換性契約にしない。クライアントは `code`、`ruleId`、`path` を使用する。

### ステータスコード対応

| HTTP                         | code                           | 使用条件                                |
| ---------------------------- | ------------------------------ | --------------------------------------- |
| `400 Bad Request`            | `MALFORMED_REQUEST`            | JSON構文不正、必須構造の欠落、型不正。  |
| `406 Not Acceptable`         | `NOT_ACCEPTABLE`               | 対応しないAccept指定。                  |
| `413 Content Too Large`      | `REQUEST_TOO_LARGE`            | リクエスト本文上限超過。                |
| `415 Unsupported Media Type` | `UNSUPPORTED_MEDIA_TYPE`       | JSON以外のContent-Type。                |
| `422 Unprocessable Content`  | `INVALID_COMMAND`              | 人数、配置、値域などCommand違反。       |
| `422 Unprocessable Content`  | `DEFINITION_NOT_FOUND`         | 指定された定義IDが存在しない。          |
| `429 Too Many Requests`      | `RATE_LIMIT_EXCEEDED`          | 配備環境の要求数または同時実行数上限。  |
| `500 Internal Server Error`  | `INVALID_DEFINITION`           | サーバーが保持するCatalog定義の不整合。 |
| `500 Internal Server Error`  | `INTERNAL_INVARIANT_VIOLATION` | 集約や状態復元の内部矛盾。              |
| `503 Service Unavailable`    | `CAPACITY_EXCEEDED`            | Worker Poolの待機キュー上限超過。       |
| `503 Service Unavailable`    | `EXECUTION_LIMIT_EXCEEDED`     | イベント数やPS深度など安全上限超過。    |
| `504 Gateway Timeout`        | `EXECUTION_TIMEOUT`            | サーバー期限までに完了しなかった。      |

`POST /api/v1/formation-stat-previews` は戦闘を実行しないため、この表のうち `400`・`406`・`413`・`415`・`422`・`500` だけを返す。Worker Poolの容量・実行保護・期限に由来する `429`・`503`・`504` は構造上発生しない。

`DOMAIN_RULE_VIOLATION` は原因に応じて変換する。クライアント入力から生じた既知の違反は `422 INVALID_COMMAND`、事前検証後の予期しない不変条件違反は `500 INTERNAL_INVARIANT_VIOLATION` とする。

実装上、入力起因の違反はUseCaseが `DomainValidationError` を受けた時点で `INVALID_COMMAND` へ変換しており（`simulate-battle-use-case.ts`）、`DOMAIN_RULE_VIOLATION` を送出する経路は存在しない。HTTP境界の変換表（`error-response-mapper.ts`）はこのコードを `500 INTERNAL_INVARIANT_VIOLATION` と同じ扱いに固定した防御的なマッピングとして持つ。実経路が生まれた時点で 422 側の分岐を追加する（REL-004 / Issue #203）。

クライアント切断によるキャンセルでは接続自体が失われるため、レスポンスを返せない場合がある。サーバー内部からのキャンセルで返却可能なら `503 Service Unavailable` とし、`EXECUTION_CANCELLED` を使用する。

### 情報公開

エラーレスポンスへ次を含めない。

- スタックトレース
- ローカルファイルパス
- SQLやCatalogファイルの生データ
- 環境変数
- 未公開のスキル定義全体
- 乱数生成器の内部状態

詳細は `diagnosticId` とサーバー側ログで追跡する。

## バージョニング

### URLバージョン

互換性を壊すAPI契約変更はURLのメジャーバージョンを上げる。

```text
/api/v1/...
/api/v2/...
```

### schemaVersion

レスポンス本文とイベントdetailsのスキーマ版を `schemaVersion` で示す。v1開始時は1とする。

次は原則として後方互換な追加とする。

- 任意プロパティの追加
- 新しいイベント種別の追加
- 新しいエラーコードの追加
- 新しい列挙値の追加。ただし既存クライアントが未知値を扱えることを前提とする。
- 編成段階で弾かれていたため一度も公開されたことがない変種の追加。既存クライアントが受け取れたレスポンスの形が変わらないことが条件であり、そのために必須プロパティを任意へ緩める場合は、緩めた後も従来から公開されていた変種では常に存在することを併せて示す（REL-008 / Issue #263 の `MarkerStateResponse.sourceUnitId`。上記「Memory由来Markerの付与元」を参照）。
- 同じ理由で、Response Mapperが常に例外にしていたため一度も公開されたことがない変種の追加（REL-004 / Issue #203 の `CooldownStateResponse.setAtActionId`。上記「設定スコープを持たないクールタイム」を参照）。

次は破壊的変更としてAPIメジャーバージョンを検討する。

- 既存必須プロパティの削除・型変更
- 既存列挙値の削除・意味変更
- 座標系や割合単位の変更
- 差分適用規則の変更
- 既存イベント種別の意味変更

#### v1のまま行った破壊的変更（ログ方針刷新 / Issue #465）

上の原則に反して、次の3点はメジャーバージョンを上げずにv1のまま変更した。

1. `options.logLevel` の既定値を `DETAILED` から `SUMMARY` へ反転した。
2. 列挙値 `DIAGNOSTIC` を削除した（指定は `422 INVALID_COMMAND`）。
3. `SUMMARY` の応答から `events`・`stateTransitions` の中身と `finalState` を落とした（`finalState` は必須プロパティから任意へ）。

v2を切らずに行える判断の根拠は、このAPIの公開範囲が閉じていることである。既知のクライアントは本リポジトリのUIだけであり、UIは `logLevel` を常に明示送信し、Issue #464 で `finalState`・`events`・`stateTransitions` の欠落を受理できる状態を**先にデプロイ済み**である。したがって「既存クライアントが受け取れていた応答の形が壊れる」事態は発生しない。

この免除は公開範囲がこの前提を満たす間だけ有効である。第三者クライアントが現れた時点で、以後の同種の変更はv2を切って行う。

なお `apps/api/openapi/v1-baseline.json` はこの変更を反映して再生成した。互換性検査（`API-OPENAPI-022`）は再生成後のbaselineを基準に、これ以降の**意図しない**破壊的変更を検出し続ける。

#### v1のまま行った破壊的変更（攻撃前観測 / Issue #480）

`UnitBeingAttacked` の `details` から必須プロパティ `effectActionDefinitionId`・`hitIndex` を削除し、必須プロパティ `damageTypes`（ダメージ型の配列）を追加した。

`R-ATM-03`（攻撃前観測）でこのイベントの発行位置がヒット単位から「効果処理開始前・対象ごとに1回」へ変わり、発行時点ではどのEffectActionの何ヒット目かが定まらなくなったためである。値を捏造して欄だけ残すことはできない以上、削除以外の選択肢はない（`10_API設計.md` の原則では既存必須プロパティの削除は破壊的変更にあたる）。

v2を切らない根拠はIssue #465と同じで、既知のクライアントが本リポジトリのUIだけであり、そのUIはこのイベントの `details` を一切読んでいないことによる。同じくbaselineは再生成した。

## サイズ・タイムアウト・圧縮

### リクエストサイズ

編成入力自体は小さいため、実装ではJSON本文へ明示的な上限を設ける。具体値は配備環境で決めるが、上限超過はJSON解析前または解析中に `413` で拒否する。

ID文字列、配列要素、オブジェクト階層にも上限を設け、巨大文字列や未知プロパティでメモリーを消費させない。

### レスポンスサイズ

- 状態差分はイベントへ複製せず、`stateTransitionIndex` で参照する。
- 完全状態は `initialState` と `finalState` だけ返す。
- 中間状態は差分で返し、イベントごとの完全な `stateAfter` は返さない。
- HTTP圧縮を有効にできる。
- ログを件数で途中切り捨てして成功扱いにしない。
- 実行前に正確な応答サイズを予測できないため、イベント総数などの実行保護で上限を管理する。

出力上限に達した場合は不完全な `200 OK` を返さず、`EXECUTION_LIMIT_EXCEEDED` とする。上限値はAPI契約ではなく運用設定とし、正常な99ターン戦闘を十分扱える値にする。

### タイムアウト

タイムアウトは次の順で整合させる。

```text
Battle実行期限 < HTTPサーバー期限 < リバースプロキシ期限
```

Battle実行期限を最も短くし、HTTP接続が強制終了される前に構造化エラーを返せる余地を確保する。期限切れをターン上限敗北として返してはならない。

クライアント切断を検出した場合はキャンセルシグナルを `SimulationExecutionContext` へ伝える。新しいトップレベル解決スコープや安全な内部処理境界で中断する。

## 同時実行とレート制限

戦闘はCPUとメモリーを長時間占有する可能性があるため、一般的な短時間APIとは別に同時実行数を制限する。

- 受付中と実行中の戦闘数を監視する。
- 利用者別の要求数上限は `429 RATE_LIMIT_EXCEEDED`、Worker Poolの容量不足は `503 CAPACITY_EXCEEDED` で拒否する。
- `Retry-After` を設定できる場合は設定する。
- あるリクエストのBattle、Observation、RandomSourceを別リクエストと共有しない。
- レート制限キーの選択は認証方式または配備環境で決める。

## セキュリティ境界

- リクエストからスキル式、PS条件式、任意コードを受け取らない。
- ユニット、スキル、メモリーはサーバー内Catalogの定義だけを使用する。
- 未知プロパティを拒否する。
- IDをファイルパスやSQLへ直接連結しない。
- JSONの深さ、配列長、文字列長を制限する。
- 最大の公開レベルである `DETAILED` のレスポンスにも内部例外や秘密情報を含めない。
- M4.5はCloud Runのunauthenticated invocationを許可し、TLS終端はCloud Runに委ねる。
- CORSはbrowser origin制御であり認証ではない。public APIへの直接requestは本文上限、timeout、bounded queue、maximum instancesで保護する。

### CORS

GitHub Pages UIから別originのAPIを呼ぶため、M4.5でCORSをAPI契約へ追加する。

- productionの許可originは `https://komei0727.github.io` を完全一致で設定する。
- 開発originは環境設定で明示し、production許可値と混在させない。
- 許可methodは `GET`、`POST`、`OPTIONS`。
- 許可request headerは `Content-Type`、`Accept`、`X-Request-Id`、`If-None-Match`。
- 公開response headerは `X-Request-Id`、`Retry-After`、`ETag`。
- credentialsは許可しない。
- productionの既定を `*` にしない。
- `Origin`を持たないCLI/サーバー間requestは従来どおり処理する。

## API契約テスト

### 正常系

1. Catalog一覧が全Unit・Memoryを安定順で返す。
2. Catalog一覧の選択可否が同revisionの戦闘事前検証と一致する。
3. Catalog一覧が完全なSkill・EffectAction定義を含まない。
4. ETag一致の条件付きCatalog GETが304を返す。
5. 最小編成同士、ターン数1で `200` と完了結果を返す。
6. 各陣営5体、メモリー6件、ターン数99を受理する。
7. 同じユニット定義を複数枠へ指定し、異なる `battleUnitId` を返す。
8. `options` 省略時にDETAILEDイベントを返す。
9. 同時全滅で `ALLY_WIN` と `SIMULTANEOUS_DEFEAT` を返す。
10. 初期状態へ全差分を適用すると最終状態に一致する。
11. イベントの `stateTransitionIndex` が対応する原因連番と状態バージョンを参照する。
12. PP消費と同量のEX増加をイベントと状態差分から確認できる。
13. 重複なし効果の次点が `isEffective: false` で保持され、繰り上げ後にtrueになる。
14. 行動・ターン期間効果が付与スコープでは減らず、次回以降に失効する。

### 入力エラー

1. 不正JSONを `400 MALFORMED_REQUEST` で拒否する。
2. 必須値の `null`、数値文字列、小数ターンを拒否する。
3. 0体、6体、7件のメモリー、0・100ターンをそれぞれ拒否する。
4. 同じ陣営内の配置重複をJSON Pointer付きで返す。
5. 不明なユニット・メモリーIDを `422 DEFINITION_NOT_FOUND` で返す。
6. 未知プロパティを拒否する。
7. 対応しないContent-Type、Acceptをそれぞれ `415`、`406` で拒否する。

### ログレベルと障害

1. `options` を省略するとSUMMARYになり、`events` と `stateTransitions` が空で `finalState` を持たない。`result`・`initialState`・`unitSummaries` は完全に返す。
2. DETAILEDで各スキル、PS、ダメージ、効果に加え、候補除外理由などの診断イベントも返し、内部秘密情報は返さない。
3. 廃止済みの `DIAGNOSTIC` を指定すると `422 INVALID_COMMAND`（`path: /options/logLevel`）を返す。
4. 実行保護上限到達時に不完全な成功結果を返さない。
5. タイムアウトを敗北へ変換しない。
6. 内部例外でスタックトレースを返さず、`diagnosticId` を返す。
7. すべてのレスポンスに同じ `X-Request-Id` を返す。

### CORS

1. 許可したGitHub Pages originのCatalog GETと戦闘POSTにCORS headerを返す。
2. JSON POSTのpreflightを成功させる。
3. 許可していないoriginへCORS headerを返さない。
4. `X-Request-Id`、`Retry-After`、`ETag`をbrowserから参照できる。
5. `Origin`なしの既存API contract testとCLI requestを壊さない。

## OpenAPIへの反映

実装時には本書を正本としてOpenAPI 3.0.3文書を作成し、次を自動検証する。

- リクエスト・レスポンスの必須項目と値域
- `additionalProperties: false` による未知プロパティ拒否
- 列挙値
- 正常・エラーのステータスコード
- イベント共通エンベロープ
- イベントdetailsの種別ごとのスキーマ
- API例と実レスポンスの契約一致
- Catalog一覧の200/304と戦闘POSTのcache header差異
- CORS preflightと公開header

ドメインクラスからOpenAPIスキーマを直接生成しない。外部DTOの変更がドメインモデルへ波及しない境界を維持する。

戦術演習エンドポイントの追加は既存契約への加算的変更とする。実装時にはOpenAPI baseline（`apps/api/openapi/v1-baseline.json`）を再生成し、互換性検査で破壊的変更が検出されないことを確認する。編成ステータスプレビューエンドポイントの追加も同じ扱いとする。
