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
| 既定ログレベル         | `DETAILED`                                             |

新しい永続リソースを作成しないため `201 Created` は使用しない。途中処理を非同期ジョブとして受け付けるAPIではないため `202 Accepted` も使用しない。

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

`Cache-Control: no-store`は戦闘シミュレーションPOSTとエラーレスポンスへ適用する。Catalog一覧GETの200応答は不変の `catalogRevision` をETagとして使い、`Cache-Control: public, max-age=300` を返す。`If-None-Match`が現在のETagと一致する場合は本文なしの304を返す。Catalog更新は新しいapplication deploymentであり、同一revisionの内容を稼働中に変更しない。

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
      "positionAptitudes": ["FRONT"],
      "selectable": true,
      "unavailableCapabilities": []
    }
  ],
  "memories": [
    {
      "memoryDefinitionId": "MEM_HEART_COLOR",
      "displayName": "心の色",
      "selectable": false,
      "unavailableCapabilities": ["CAP_MEMORY_TRIGGERED_EFFECT"]
    }
  ]
}
```

### BattleSimulationCatalogResponse

| プロパティ        | 型                               | 説明                                    |
| ----------------- | -------------------------------- | --------------------------------------- |
| `schemaVersion`   | integer                          | response schema版。初期値1。            |
| `catalogRevision` | string                           | 一覧と戦闘事前検証が使用するCatalog版。 |
| `units`           | `CatalogUnitSummaryResponse[]`   | 全Unit。`unitDefinitionId`昇順。        |
| `memories`        | `CatalogMemorySummaryResponse[]` | 全Memory。`memoryDefinitionId`昇順。    |

### CatalogUnitSummaryResponse

| プロパティ                | 型       | 必須 | 説明                                                                 |
| ------------------------- | -------- | ---- | -------------------------------------------------------------------- |
| `unitDefinitionId`        | string   | 必須 | 不透明なUnit定義ID。                                                 |
| `displayName`             | string   | 必須 | Catalog metadataの表示名。                                           |
| `characterName`           | string   | 必須 | Catalog metadataのキャラクター名。                                   |
| `attribute`               | string   | 必須 | Unit属性。未知の将来値を許容する。                                   |
| `unitType`                | string   | 必須 | `PHYSICAL`、`ENERGY`、`AGILE`。未知の将来値を許容する。              |
| `role`                    | string   | 必須 | Unit Role。将来追加を許容する。                                      |
| `positionAptitudes`       | string[] | 必須 | `FRONT`、`BACK`の1件以上。API編成入力の後衛 `REAR`とは名称が異なる。 |
| `selectable`              | boolean  | 必須 | 現在の実装Capabilityで戦闘事前検証を通過可能か。                     |
| `unavailableCapabilities` | string[] | 必須 | 未実装Capability ID。重複なし・昇順。                                |

### CatalogMemorySummaryResponse

| プロパティ                | 型       | 必須 | 説明                                             |
| ------------------------- | -------- | ---- | ------------------------------------------------ |
| `memoryDefinitionId`      | string   | 必須 | 不透明なMemory定義ID。                           |
| `displayName`             | string   | 必須 | Catalog metadataの表示名。                       |
| `selectable`              | boolean  | 必須 | 現在の実装Capabilityで戦闘事前検証を通過可能か。 |
| `unavailableCapabilities` | string[] | 必須 | 未実装Capability ID。重複なし・昇順。            |

### 選択可否の規則

- 対象定義自身だけでなく、参照Skill、EffectActionまで推移的に必要Capabilityを収集する。
- 全必要CapabilityがCatalog上で `IMPLEMENTED`の場合だけ `selectable: true`とする。
- `selectable: true`と `unavailableCapabilities: []`は常に対応する。
- `selectable: false`では `unavailableCapabilities`を1件以上返す。
- 同じCatalog revisionに対する一覧判定と `POST /api/v1/battle-simulations` の事前検証は一致しなければならない。
- 未対応定義も一覧から除外しない。

### 情報公開境界

一覧APIは次を公開しない。

- Skill、EffectAction、Formula、Condition、triggeredEffectsの完全定義
- Capabilityの内部実装状況説明や実装計画
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
        }
      }
    ],
    "memoryDefinitionIds": ["memory-001"]
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

| プロパティ            | 型                       | 必須 | 制約     |
| --------------------- | ------------------------ | ---- | -------- |
| `units`               | `FormationUnitRequest[]` | 必須 | 1～5件。 |
| `memoryDefinitionIds` | string[]                 | 必須 | 0～6件。 |

同じ `unitDefinitionId` を複数指定できる。それぞれ別の参加枠として扱う。

メモリーIDの重複可否は現仕様で制限されていないため、API境界では拒否しない。同じメモリーを複数装備できるかなどのCatalog定義上の制約が追加された場合は、アプリケーション検証へ追加する。

### FormationUnitRequest

| プロパティ         | 型                         | 必須 | 制約                     |
| ------------------ | -------------------------- | ---- | ------------------------ |
| `unitDefinitionId` | string                     | 必須 | 空でない不透明な定義ID。 |
| `position`         | `FormationPositionRequest` | 必須 | 陣営内の配置。           |

定義IDはクライアントが解析しない不透明な文字列として扱う。大文字小文字を区別し、前後の空白を自動除去しない。

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

| プロパティ | 型     | 必須 | 既定値     | 制約                                  |
| ---------- | ------ | ---- | ---------- | ------------------------------------- |
| `logLevel` | string | 任意 | `DETAILED` | `SUMMARY`、`DETAILED`、`DIAGNOSTIC`。 |

`DIAGNOSTIC` は内部判定情報を多く含み、レスポンスも大きくなる。初期APIでは定義済みの選択肢として受理する。将来、公開環境で利用を制限する場合は、認可規則とエラーコードをAPI契約へ明示し、黙って `DETAILED` へ落とさない。

### null・省略・空配列

- 必須プロパティへ `null` を指定できない。
- 任意プロパティは省略できるが、`null` は指定できない。
- メモリーを指定しない場合は `memoryDefinitionIds: []` とする。
- `options` を省略した場合だけ全オプションの既定値を使用する。
- 数値を文字列として送信できない。
- `NaN`、`Infinity`、小数の `turnLimit` や `column` は受理しない。

## Inbound Adapterでの変換

Inbound Adapterは外部DTOを次のようにCommandへ変換する。

| API DTO                | Application Command      |
| ---------------------- | ------------------------ |
| `allyFormation.units`  | `allyFormation.slots`    |
| `enemyFormation.units` | `enemyFormation.slots`   |
| `unitDefinitionId`     | `UnitDefinitionId`       |
| `{ column, row }`      | `FormationPositionInput` |
| `memoryDefinitionIds`  | `MemoryDefinitionId[]`   |
| `turnLimit`            | `turnLimit`              |
| `options.logLevel`     | `logLevel`               |

DTOの構造検証に成功しても、IDの存在、配置重複、未対応ルールなどはアプリケーション層で検証する。Inbound AdapterはCatalogを直接参照しない。

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
  "events": [],
  "stateTransitions": []
}
```

### BattleSimulationResponse

| プロパティ         | 型                          | 説明                                                   |
| ------------------ | --------------------------- | ------------------------------------------------------ |
| `schemaVersion`    | integer                     | レスポンス本文スキーマのバージョン。初期値は1。        |
| `battleId`         | string                      | 今回の実行を識別するID。結果取得用リソースIDではない。 |
| `catalogRevision`  | string                      | 今回使用したCatalogスナップショットの版。              |
| `result`           | `BattleResultResponse`      | 確定した勝敗。                                         |
| `initialState`     | `BattleStateResponse`       | `READY` 時点の状態。`stateVersion` は0。               |
| `finalState`       | `BattleStateResponse`       | `COMPLETED` 時点の状態。                               |
| `events`           | `BattleLogEventResponse[]`  | 指定された公開レベルのイベント。                       |
| `stateTransitions` | `StateTransitionResponse[]` | 全状態変更。公開レベルに依存して間引かない。           |

### BattleResultResponse

| プロパティ         | 型      | 値                                                                               |
| ------------------ | ------- | -------------------------------------------------------------------------------- |
| `outcome`          | string  | `ALLY_WIN` または `ALLY_LOSE`。                                                  |
| `completionReason` | string  | `ENEMY_DEFEATED`、`ALLY_DEFEATED`、`SIMULTANEOUS_DEFEAT`、`TURN_LIMIT_REACHED`。 |
| `completedTurn`    | integer | 戦闘が終了したターン。1～規定ターン数。                                          |

`SIMULTANEOUS_DEFEAT` の `outcome` は仕様に従い `ALLY_WIN` とする。

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

値はJSON numberで返す。ダメージなど仕様上整数に確定した値はintegerとする。途中計算値をDIAGNOSTICログへ出す場合も `NaN` や無限値を返してはならない。

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
  category
  effectKindKey
  stackMode
  isEffective
  value
  duration
  appliedTurnNumber
  appliedActionId?
}
```

| プロパティ      | 説明                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `category`      | `BUFF`、`DEBUFF`、`STATUS_ABNORMALITY`のいずれか。状態異常はデバフの一種だが、解除・無効判定のため区別して返す。 |
| `effectKindKey` | 重複判定で同種を識別する安定したキー。                                                                           |
| `stackMode`     | `STACKABLE` または `NON_STACKING`。                                                                              |
| `isEffective`   | 現在の計算へ採用されているか。重複なしの次点効果はfalse。                                                        |
| `value`         | 効果種別ごとの構造化された値。                                                                                   |
| `duration`      | `{ unit: "ACTION"                                                                                                | "TURN", remaining: integer }`。永続効果では省略する。 |

`effectKindKey` を `value` の判別子として使用し、効果種別ごとの `value` スキーマはOpenAPIの `oneOf` で定義する。重複あり効果と、再付与された重複なし効果を別インスタンスとしてすべて返す。最強効果が失効した後に次点を有効化できる状態を失わない。

### MarkerStateResponse

```text
MarkerStateResponse {
  markerInstanceId
  markerId
  sourceUnitId
  stackCount
  stackMax
  duration?
}
```

| プロパティ         | 説明                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `markerInstanceId` | 個別インスタンスの安定したドメインID。                                                     |
| `markerId`         | Marker種別を識別するID（`MARKER_` 接頭辞）。                                               |
| `sourceUnitId`     | 直近の付与者。複数付与元から同じMarkerが付与された場合も対象ごとに単一インスタンスへ積む。 |
| `stackCount`       | 現在のスタック数（0未満にならない）。                                                      |
| `stackMax`         | スタック上限。上限なしは `null`。                                                          |
| `duration`         | `{ unit: "ACTION" \| "TURN", remaining: integer }`。永続効果では省略する。                 |

`EffectStateResponse` と異なり `category`/`stackMode`/`isEffective`/`value` を持たない。Markerは重複あり・なしの選択（R-EFF-05）の対象ではなく、対象ごとに常に1インスタンスだけが存在し、`ADD`/`KEEP_EXISTING`/`REFRESH`/`REPLACE`の付与方針でこのインスタンスを更新する（R-EFF-10）。

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

サブユニットは同じ表示用シールド合計へ含まれる場合でも、消費順と固有効果を追跡するためインスタンスごとに返す。

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

設定した同じ行動・ターンでは減算しないことを追跡できるよう、設定スコープを含める。`unit`に応じてどちらか一方だけが存在する（`ACTION`なら`setAtActionId`、`TURN`なら`setAtTurnNumber`）。Domain側もこの設定scopeを行動単位・ターン単位のいずれか一方でしか保持しないため（`06_戦闘状態遷移.md`R-SKL-04）、両方を常に返す契約にはしない。

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
- DETAILEDでは乱数の内部状態やサーバー実装情報を含めない。
- DIAGNOSTICでもスタックトレース、ファイルパス、秘密情報を含めない。

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

| レベル       | 含めるもの                                                                    |
| ------------ | ----------------------------------------------------------------------------- |
| `SUMMARY`    | 戦闘開始・終了、行動結果、戦闘不能、ターン終了など主要イベント。              |
| `DETAILED`   | SUMMARYに加え、スキル、PS、各ヒット、ダメージ、シールド、効果、リソース変更。 |
| `DIAGNOSTIC` | DETAILEDに加え、候補除外、乱数判定、上限超過などの診断イベント。              |

公開レベルに関係なく、状態変更は `stateTransitions` へすべて含める。SUMMARYで原因イベントが非公開でも、`causedBySequence` は元のイベント連番を保持する。

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
}
```

```text
battle: {
  battleStatus?: ValueChange
  turnNumber?: ValueChange
  cycleNumber?: ValueChange
}

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
  resources?: {
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
}
```

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

| プロパティ     | 型     | 必須 | 説明                          |
| -------------- | ------ | ---- | ----------------------------- |
| `path`         | string | 任意 | JSON Pointer形式の入力位置。  |
| `definitionId` | string | 任意 | 問題がある定義ID。            |
| `ruleId`       | string | 任意 | 違反規則またはCapability ID。 |
| `message`      | string | 必須 | 個別違反の説明。              |

`message` の文言は互換性契約にしない。クライアントは `code`、`ruleId`、`path` を使用する。

### ステータスコード対応

| HTTP                         | code                           | 使用条件                                 |
| ---------------------------- | ------------------------------ | ---------------------------------------- |
| `400 Bad Request`            | `MALFORMED_REQUEST`            | JSON構文不正、必須構造の欠落、型不正。   |
| `406 Not Acceptable`         | `NOT_ACCEPTABLE`               | 対応しないAccept指定。                   |
| `413 Content Too Large`      | `REQUEST_TOO_LARGE`            | リクエスト本文上限超過。                 |
| `415 Unsupported Media Type` | `UNSUPPORTED_MEDIA_TYPE`       | JSON以外のContent-Type。                 |
| `422 Unprocessable Content`  | `INVALID_COMMAND`              | 人数、配置、値域などCommand違反。        |
| `422 Unprocessable Content`  | `DEFINITION_NOT_FOUND`         | 指定された定義IDが存在しない。           |
| `422 Unprocessable Content`  | `UNSUPPORTED_RULE`             | 選択定義が未実装Capabilityを必要とする。 |
| `429 Too Many Requests`      | `RATE_LIMIT_EXCEEDED`          | 配備環境の要求数または同時実行数上限。   |
| `500 Internal Server Error`  | `INVALID_DEFINITION`           | サーバーが保持するCatalog定義の不整合。  |
| `500 Internal Server Error`  | `INTERNAL_INVARIANT_VIOLATION` | 集約や状態復元の内部矛盾。               |
| `503 Service Unavailable`    | `CAPACITY_EXCEEDED`            | Worker Poolの待機キュー上限超過。        |
| `503 Service Unavailable`    | `EXECUTION_LIMIT_EXCEEDED`     | イベント数やPS深度など安全上限超過。     |
| `504 Gateway Timeout`        | `EXECUTION_TIMEOUT`            | サーバー期限までに完了しなかった。       |

`DOMAIN_RULE_VIOLATION` は原因に応じて変換する。クライアント入力から生じた既知の違反は `422 INVALID_COMMAND`、事前検証後の予期しない不変条件違反は `500 INTERNAL_INVARIANT_VIOLATION` とする。

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

次は破壊的変更としてAPIメジャーバージョンを検討する。

- 既存必須プロパティの削除・型変更
- 既存列挙値の意味変更
- 座標系や割合単位の変更
- 差分適用規則の変更
- 既存イベント種別の意味変更

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
- DIAGNOSTICログにも内部例外や秘密情報を含めない。
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
6. 未実装Capabilityを必要とする定義を `422 UNSUPPORTED_RULE` で返す。
7. 未知プロパティを拒否する。
8. 対応しないContent-Type、Acceptをそれぞれ `415`、`406` で拒否する。

### ログレベルと障害

1. SUMMARYでも全状態差分を返す。
2. DETAILEDで各スキル、PS、ダメージ、効果を返す。
3. DIAGNOSTICで候補除外理由を返し、内部秘密情報は返さない。
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

## 次の設計への申し送り

次の `11_インフラストラクチャ設計.md` では、次を詳細化する。

- Node.js／TypeScriptでのモジュール構成と依存方向
- HTTPサーバーおよびInbound Adapterの実装方式
- Catalog定義の格納形式、読み込み、起動時検証
- RandomSource、ID生成器、実行ガードのアダプター
- 設定値、構造化ログ、メトリクス、ヘルスチェック
- OpenAPI生成・検証とテスト環境
