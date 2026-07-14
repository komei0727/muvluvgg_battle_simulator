# API・データ連携設計

## 1. 正本

HTTP契約の正本は [../ddd/10_API設計.md](../ddd/10_API設計.md) と実行環境の `/openapi.json` である。本書はUIからの利用方法、表示モデルへの変換、エラー表示を定義する。

## 2. エンドポイント

### 2.1 Unit・Memory一覧

```http
GET {VITE_API_BASE_URL}/api/v1/battle-simulation-catalog
Accept: application/json
X-Request-Id: ui-<UUID>
If-None-Match: "<previous-etag>"
```

成功時は `200 OK`、条件付きGETで変更がなければ `304 Not Modified` を返す。UIはUnit・Memoryの表示と選択可否をこのresponseだけから決定する。

```ts
interface BattleSimulationCatalogResponse {
  readonly schemaVersion: 1;
  readonly catalogRevision: string;
  readonly units: readonly CatalogUnitSummary[];
  readonly memories: readonly CatalogMemorySummary[];
}

interface CatalogAvailability {
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly string[];
}

interface CatalogUnitSummary extends CatalogAvailability {
  readonly unitDefinitionId: string;
  readonly displayName: string;
  readonly characterName: string;
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
}

interface CatalogMemorySummary extends CatalogAvailability {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
}
```

- `selectable`はバックエンドが対象定義からSkill/EffectActionまで推移的にCapabilityを収集して判定する。
- `unavailableCapabilities`は選択不可理由となるCapability IDを重複なく昇順で返す。
- Unit/Memory配列はdefinition ID昇順とし、UI側の表示sortに依存しない安定順を持つ。
- 画像URLはAPI契約に含めない。UIはdefinition IDに対応する任意のローカル画像mapを重ね、なければfallbackを使う。
- Skill、EffectAction、Formula、Condition、triggeredEffectsの内容を返さない。
- pagination、検索query、availability filterは初期契約に設けない。

### 2.2 戦闘シミュレーション

```http
POST {VITE_API_BASE_URL}/api/v1/battle-simulations
Content-Type: application/json
Accept: application/json
X-Request-Id: ui-<UUID>
```

### 2.3 共通リクエスト方針

- `Content-Type`と`Accept`を明示する。
- UIでUUIDを生成できる場合は `X-Request-Id` を付ける。生成失敗時は省略し、サーバー生成に任せる。
- CookieやHTTP credentialを送らない。`fetch`の `credentials` は `omit` とする。
- 一覧GETはHTTP cache/ETagを利用し、戦闘POSTは `cache: "no-store"` とする。
- 自動retryしない。戦闘は冪等ではなく、同じ条件でも別結果になり得る。
- 一覧GETの失敗にも自動無限retryを行わず、利用者の手動再読込を提供する。

## 3. UI入力モデル

```ts
type Side = "ally" | "enemy";
type UiRow = "FRONT" | "REAR";
type LogLevel = "SUMMARY" | "DETAILED" | "DIAGNOSTIC";

interface FormationSlotInput {
  readonly slotKey: `${Side}:${UiRow}:${0 | 1 | 2}`;
  readonly side: Side;
  readonly row: UiRow;
  readonly column: 0 | 1 | 2;
  readonly unitDefinitionId?: string;
}

interface BattleDraft {
  readonly allySlots: readonly FormationSlotInput[]; // 常に6件
  readonly enemySlots: readonly FormationSlotInput[]; // 常に6件
  readonly allyMemoryDefinitionIds: readonly string[]; // 0～6件
  readonly enemyMemoryDefinitionIds: readonly string[]; // 0～6件
  readonly turnLimit: number | "";
  readonly logLevel: LogLevel;
}
```

`slotKey`はUI DOMと編集状態の安定キーであり、APIへ送らない。

## 4. 座標変換

画面とAPIの対応は次で固定する。

| 画面     | UI row  | API `position.row` | `position.column` |
| -------- | ------- | ------------------ | ----------------- |
| 前衛左   | `FRONT` | `FRONT`            | `0`               |
| 前衛中央 | `FRONT` | `FRONT`            | `1`               |
| 前衛右   | `FRONT` | `FRONT`            | `2`               |
| 後衛左   | `REAR`  | `REAR`             | `0`               |
| 後衛中央 | `REAR`  | `REAR`             | `1`               |
| 後衛右   | `REAR`  | `REAR`             | `2`               |

Catalogの `positionAptitudes` は現時点で `FRONT` / `BACK` を使う。UI表示用にだけ `BACK`を「後衛適性」と解釈するが、API requestへは必ず `REAR` を送る。この名称差異を1つの変換関数に閉じ込める。

```ts
function apiRowForUiRow(row: UiRow): "FRONT" | "REAR" {
  return row;
}

function aptitudeMatches(row: UiRow, aptitudes: readonly string[]): boolean {
  return aptitudes.includes(row === "REAR" ? "BACK" : "FRONT");
}
```

## 5. リクエスト生成

```ts
interface BattleSimulationRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly turnLimit: number;
  readonly options: { readonly logLevel: LogLevel };
}

interface FormationRequest {
  readonly units: readonly {
    readonly unitDefinitionId: string;
    readonly position: {
      readonly column: 0 | 1 | 2;
      readonly row: "FRONT" | "REAR";
    };
  }[];
  readonly memoryDefinitionIds: readonly string[];
}
```

変換規則：

1. 空のslotを除外する。
2. FRONT column 0～2、REAR column 0～2の順に安定sortする。
3. 画面表示名、属性、ロール、画像URLを送らない。
4. `turnLimit`を文字列化しない。
5. `options.logLevel`を常に送る。
6. 未定義プロパティを追加しない。

例：

```json
{
  "allyFormation": {
    "units": [
      {
        "unitDefinitionId": "UNIT_DOROTHEA_GRACE",
        "position": { "column": 0, "row": "FRONT" }
      }
    ],
    "memoryDefinitionIds": []
  },
  "enemyFormation": {
    "units": [
      {
        "unitDefinitionId": "UNIT_EVIE_ECO",
        "position": { "column": 0, "row": "FRONT" }
      }
    ],
    "memoryDefinitionIds": []
  },
  "turnLimit": 10,
  "options": { "logLevel": "DETAILED" }
}
```

## 6. クライアント検証

送信前に全違反を収集し、一度に表示する。

| Path                     | 規則              | UIメッセージ                                         |
| ------------------------ | ----------------- | ---------------------------------------------------- |
| `/allyFormation/units`   | 1～5体            | 味方ユニットを1～5体設定してください。               |
| `/enemyFormation/units`  | 1～5体            | 敵ユニットを1～5体設定してください。                 |
| `/*/units/*/position`    | 座標重複なし      | 同じ配置枠に複数のユニットは設定できません。         |
| `/*/memoryDefinitionIds` | 0～6件            | メモリーは6件まで設定できます。                      |
| `/turnLimit`             | integer 1～99     | ターン上限は1～99の整数で入力してください。          |
| `/options/logLevel`      | 許容列挙値        | ログレベルを選択してください。                       |
| definition               | `selectable=true` | 未対応の戦闘ルールを必要とする定義は選択できません。 |

クライアント検証を通過してもサーバー検証を省略できない。Catalog revision差、UI生成の不具合、直接HTTP呼び出しがあるため、APIの422を通常の入力エラーとして扱う。

## 7. API client

```ts
interface SimulationApiClient {
  getCatalog(options: {
    readonly signal: AbortSignal;
    readonly requestId?: string;
    readonly etag?: string;
  }): Promise<CatalogApiResult>;

  simulate(
    request: BattleSimulationRequest,
    options: { readonly signal: AbortSignal; readonly requestId?: string },
  ): Promise<SimulationApiResult>;
}

type CatalogApiResult =
  | {
      readonly ok: true;
      readonly response: BattleSimulationCatalogResponse;
      readonly etag?: string;
      readonly requestId?: string;
    }
  | {
      readonly ok: true;
      readonly notModified: true;
      readonly etag: string;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly error: UiApiError;
      readonly requestId?: string;
    };

type SimulationApiResult =
  | {
      readonly ok: true;
      readonly response: BattleSimulationResponse;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly error: UiApiError;
      readonly requestId?: string;
      readonly retryAfterSeconds?: number;
    };
```

既知のHTTP失敗をthrowだけで表現せず、判別可能な結果へ正規化する。ネットワーク例外とAbortだけをcatchし、同じ `UiApiError` へ変換する。

### タイムアウトとキャンセル

- サーバー既定期限は30秒である。
- UIは35秒を既定のクライアント待機上限とし、API側が構造化504を返す余地を残す。
- `AbortController`を1実行につき1つ作る。
- 利用者キャンセル、page unload、UI待機上限でabortする。
- Abort後に到着した結果でstateを更新しない。実行ごとの `executionId` を照合する。
- UIキャンセルはサーバーで戦闘が確実に停止したことを意味しないため、「キャンセル要求済み」と表現する。
- 一覧GETには10秒のUI待機上限を設け、戦闘実行用AbortControllerと共有しない。

## 8. 一覧レスポンスの検証

最低限、次を実行時検証する。

- `schemaVersion`が1
- `catalogRevision`が空でないstring
- `units`と`memories`がarray
- 各定義IDが空でなく、配列内で重複しない
- `displayName`、分類値、`selectable`、`unavailableCapabilities`が契約shapeを満たす
- `selectable: true`なら `unavailableCapabilities`が空
- `selectable: false`なら `unavailableCapabilities`が1件以上

契約違反時は編成を有効にせず `RESPONSE_CONTRACT_MISMATCH`を表示する。UIがCatalogファイルから欠損値を補完しない。

## 9. 戦闘成功レスポンスの検証

最低限、次を実行時検証する。

- `schemaVersion`がnumber
- `battleId`と`catalogRevision`がstring
- `result`の必須3項目
- `initialState.units`と`finalState.units`がarray
- `events`と`stateTransitions`がarray
- 各unitに `battleUnitId`、`unitDefinitionId`、`side`、HP、combatStatusがある

未知の任意プロパティ、イベントtype、列挙値は許容する。必須shape欠落時は部分表示で誤解を招かず、`RESPONSE_CONTRACT_MISMATCH`として失敗扱いにする。検証ライブラリを使う場合も、OpenAPI全体を厳格に再実装して将来の追加を拒否しない。

## 10. 表示用Roster

同一性は `battleUnitId` を使用する。

```ts
interface RosterEntry {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: "ALLY" | "ENEMY" | string;
  readonly displayName: string;
  readonly imageUrl?: string;
  readonly formationPosition: { readonly row: string; readonly column: number };
}
```

生成手順：

1. `initialState.units`を入力順で走査する。
2. `unitDefinitionId`をUI Catalogで解決する。
3. 未解決なら `displayName = unitDefinitionId` とする。
4. `finalState.units`はbattleUnitIdでindex化し、最終状態と結合する。
5. finalに存在しないunitは契約不一致とする。

## 11. サマリ集計

### 11.1 出力型

```ts
interface UnitBattleSummary {
  readonly battleUnitId: string;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly healingDone: number;
  readonly combatStatus: string;
  readonly finalHp: number;
  readonly maximumHp: number;
}
```

### 11.2 DAMAGEとDEFENSE

`DAMAGE_APPLIED`イベントのみを対象とする。

```text
amount = details.hitPointDamage
damageDealt[sourceUnitId] += amount
damageTaken[details.targetUnitId] += amount
```

- `calculatedDamage`ではなく `hitPointDamage` を使用する。
- sourceUnitId欠落、targetUnitId不明、details shape不正の場合、そのイベントを集計から除外し警告件数を内部に保持する。
- 0ダメージも正しい値として扱う。
- numberが有限・0以上であることを確認する。
- 表示時に整数へ勝手に丸めない。現在の契約はintegerだが、将来の型変更を検出できるようvalidatorで守る。

### 11.3 HEAL

M4時点では回復EffectActionは基本resolverの対象外であり、公開回復イベント契約も未確定である。

- 列は常に表示する。
- 対応イベントがなければ0。
- イベント名やdetails keyを推測しない。
- M7で回復イベント契約が確定したPRに、event adapterと集計テストを追加する。

### 11.4 Adapter registry

```ts
type SummaryEventAdapter = (event: BattleLogEvent, accumulator: MutableSummaryAccumulator) => void;

const summaryAdapters: Readonly<Record<string, SummaryEventAdapter>> = {
  DAMAGE_APPLIED: applyDamageApplied,
  // M7: HEAL_APPLIED等、API契約確定後に追加
};
```

未知イベントは無視し、詳細画面には表示する。summary adapterの未登録を成功レスポンス全体のエラーにしない。

## 12. イベント表示

イベント表示文言はUI内のformatter registryで生成する。

```ts
type EventFormatter = (event: BattleLogEvent, roster: RosterIndex) => EventPresentation;
```

`type`ごとのformatterがdetailsをnarrowingする。formatterがない、またはdetailsが想定shapeでない場合：

- title: event.type
- summary: `source → targets` の汎用表示
- details: JSON整形表示
- severity: neutral

英語のerror messageやID命名規則を解析して日本語化しない。

## 13. エラー正規化

```ts
type UiApiErrorKind =
  | "VALIDATION"
  | "UNSUPPORTED_DEFINITION"
  | "RATE_LIMIT"
  | "CAPACITY"
  | "TIMEOUT"
  | "CANCELLED"
  | "SERVER"
  | "NETWORK"
  | "CORS_OR_NETWORK"
  | "RESPONSE_CONTRACT_MISMATCH";
```

| HTTP / code                | UI kind                   | 表示と操作                                     |
| -------------------------- | ------------------------- | ---------------------------------------------- |
| 400 `MALFORMED_REQUEST`    | `SERVER`                  | UI生成リクエストの不具合。再試行より報告を促す |
| 406 / 415                  | `SERVER`                  | UI/API設定不整合                               |
| 422 `INVALID_COMMAND`      | `VALIDATION`              | JSON Pointerに対応する入力を強調               |
| 422 `DEFINITION_NOT_FOUND` | `VALIDATION`              | Catalog版差異を示し再読込を案内                |
| 422 `UNSUPPORTED_RULE`     | `UNSUPPORTED_DEFINITION`  | Capability IDと定義IDを表示                    |
| 429                        | `RATE_LIMIT`              | `Retry-After`を表示し手動再試行                |
| 503 `CAPACITY_EXCEEDED`    | `CAPACITY`                | 一時的混雑。手動再試行                         |
| 503 cancel/limit           | `CANCELLED`または`SERVER` | code別表示                                     |
| 504                        | `TIMEOUT`                 | 条件変更または再試行を案内                     |
| 500                        | `SERVER`                  | diagnosticIdとrequestIdを表示                  |
| fetch失敗                  | `CORS_OR_NETWORK`         | API到達不可。CORSかnetworkかを断定しない       |

### JSON Pointerとの対応

サーバー `violations[].path`をslot/fieldへ対応させる。

- `/allyFormation/units/{n}/unitDefinitionId`
- `/allyFormation/units/{n}/position`
- `/allyFormation/memoryDefinitionIds/{n}`
- `/enemyFormation/...`
- `/turnLimit`
- `/options/logLevel`

送信DTOの `units[n]` と元の `slotKey` の対応表をrequest生成時に保持する。sort後の配列indexから画面slotを逆引きし、誤った枠を強調しない。

## 14. CORS要件

GitHub Pagesから `application/json` のPOSTを行うため、browser preflightを含むCORS対応が必須である。

API側のproduction推奨設定：

| 項目           | 値                                                        |
| -------------- | --------------------------------------------------------- |
| Allow origin   | `https://komei0727.github.io` を完全一致で許可            |
| Allow methods  | `GET`, `POST`, `OPTIONS`                                  |
| Allow headers  | `Content-Type`, `Accept`, `X-Request-Id`, `If-None-Match` |
| Expose headers | `X-Request-Id`, `Retry-After`, `ETag`                     |
| Credentials    | `false`                                                   |
| Max age        | 配備方針で決定。長期固定しすぎない                        |

開発環境では明示したlocalhost originだけ追加する。productionで `Access-Control-Allow-Origin: *` を既定にしない。

APIはHTTPSで公開する。HTTPSのGitHub PagesからHTTP APIを呼ぶmixed content構成は不可とする。

## 15. API連携受け入れ条件

- `UI-API-001`: UIの6枠をAPIのcolumn 0～2、row FRONT/REARへ正しく変換する。
- `UI-API-002`: 空枠とUI専用情報をrequestへ含めない。
- `UI-API-003`: 同じunitDefinitionIdを複数枠へ送れる。
- `UI-API-004`: 422のJSON Pointerを元の画面枠へ対応づける。
- `UI-API-005`: DAMAGE/DEFENSEをhitPointDamageからbattleUnitId単位で集計する。
- `UI-API-006`: 回復イベント未対応でもHEAL列を0表示する。
- `UI-API-007`: 未知イベントを詳細に残し、サマリ集計では安全に無視する。
- `UI-API-008`: Request ID、diagnosticId、Retry-After、ETagを取得でき、必要な値を表示できる。
- `UI-API-009`: 自動retryを行わない。
- `UI-API-010`: GitHub Pages originからpreflightとPOSTが成功する。
- `UI-API-011`: 一覧APIからUnit・Memory、選択可否、Catalog revisionを取得する。
- `UI-API-012`: 一覧APIのETagを使った条件付きGETと304を扱える。
- `UI-API-013`: 一覧API契約違反時に編成・戦闘送信を有効化しない。
