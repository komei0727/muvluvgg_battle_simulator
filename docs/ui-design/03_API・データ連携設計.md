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
  // 効果表を公開しない旧APIと組み合わせても壊さないため任意項目として扱う。
  readonly gearEffects?: readonly CatalogGearEffect[];
}

interface CatalogGearEffect {
  readonly stat: string;
  /** R-ENH-06: `RATIO` は基本値への割合補正、`POINT` は値そのものへの加算。 */
  readonly application: string;
  readonly values: readonly CatalogGearEffectValue[];
}

interface CatalogGearEffectValue {
  readonly tier: string;
  readonly grade: string;
  /** R-ENH-04 #3の表の値。パーセントポイント表記のまま届く。 */
  readonly percentagePoints: number;
}

interface CatalogUnitSummary {
  readonly unitDefinitionId: string;
  readonly displayName: string;
  readonly characterName: string;
  /** R-TEX-11 #1: `PLAYABLE`／`EXERCISE_ENEMY`。不在は`PLAYABLE`として扱う。 */
  readonly category?: string;
  /** R-TEX-11 #4: 開催中バッジ用の表示専用情報。`EXERCISE_ENEMY`にだけ現れる。 */
  readonly exerciseActive?: boolean;
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
}

interface CatalogMemorySummary {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
}
```

- Unit/Memory配列はdefinition ID昇順とし、UI側の表示sortに依存しない安定順を持つ。
- `gearEffects`はギア選択肢の上昇値表示（`01_UI要求・画面設計.md` §5.7）にだけ使う。UIは値を再計算せず、効果表も換算式も持たない。
- `category`と`exerciseActive`は`gearEffects`と同じく任意項目として扱う。この2項目を返さない旧APIと組み合わせても壊さず、`category`不在は`PLAYABLE`として扱う。届いた場合の型違反は編成プールの判定を誤らせるため契約違反とする（§8）。
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

### 2.3 戦術演習

```http
POST {VITE_API_BASE_URL}/api/v1/tactical-exercises
Content-Type: application/json
Accept: application/json
X-Request-Id: ui-<UUID>
```

リクエストは戦闘シミュレーションと同じ`FormationRequest`構造を再利用するが、`turnLimit`を持たず、`enemyFormation.units`はちょうど1件、`enemyFormation.memoryDefinitionIds`は空配列とする。UIは送信前検証でこの制約を強制する。敵の強化はUIに入力を設けないため、`enemyFormation`は`enhancement`を持たない。

成功レスポンスは`result`だけが演習結果（`completionReason`、`completedTurn`、`totalScore`、`breakCount`、`breaks[]`）となり、`initialState`／`finalState`／`events`／`stateTransitions`は戦闘シミュレーションと同じ構造を共有する。正本は[../ddd/10_API設計.md](../ddd/10_API設計.md)「TacticalExerciseRequest」「TacticalExerciseResponse」とする。

`breaks[]`の`sourceUnitDefinitionId`（`R-TEX-03` #2 の発生源ユニット）は任意項目として読む。メモリー由来の継続ダメージのように発生源ユニットを持たないブレイクでは省略される（`R-MEM-04`）ため、不在を欠損ではなくメモリー由来として扱い、この項目より前にデプロイされたAPIの応答も受理する。

### 2.4 共通リクエスト方針

- `Content-Type`と`Accept`を明示する。
- UIでUUIDを生成できる場合は `X-Request-Id` を付ける。生成失敗時は省略し、サーバー生成に任せる。
- CookieやHTTP credentialを送らない。`fetch`の `credentials` は `omit` とする。
- 一覧GETはHTTP cache/ETagを利用し、戦闘POSTは `cache: "no-store"` とする。
- 自動retryしない。戦闘は冪等ではなく、同じ条件でも別結果になり得る。
- 一覧GETの失敗にも自動無限retryを行わず、利用者の手動再読込を提供する。

### 2.5 編成ステータスプレビュー

```http
POST {VITE_API_BASE_URL}/api/v1/formation-stat-previews
Content-Type: application/json
Accept: application/json
X-Request-Id: ui-<UUID>
```

リクエストは戦闘シミュレーションの`allyFormation`／`enemyFormation`と任意の`mode`を持ち、`turnLimit`と`options`を持たない。`mode`は`R-TEX-11` #5の編成プール検証にだけ使う。戦術演習モードでは`mode: "TACTICAL_EXERCISE"`を必ず送る — 送らないと敵枠の`EXERCISE_ENEMY`が`NORMAL`のプール制約で422になり、枠のステータス表示が落ちる。通常戦闘では省略する（サーバー既定の`NORMAL`と同じ意味であり、この項目を知らない旧APIを422にしないため）。強化指定（`enhancement`）は§5.1の変換規則をそのまま適用する — 戦闘実行時と同じペイロードから同じ開始時ステータスが得られなければ、プレビューの意味がないため。

APIは0体の陣営を受け付けるため、片側だけ埋まった編集途中の状態でもそのまま送る（味方から順に置くので、両陣営が揃うまで待つと編集中はプレビューを出せない）。両陣営とも0体のときだけ送らず、未取得として扱う。

成功レスポンスは`units[]`（`side`、`unitDefinitionId`、`formationPosition`、`maximumHp`、`combatStats`、および任意の`enhancedBaseStats`）だけを持つ。`enhancedBaseStats`は`R-ENH-06`の強化後基本ステータス（編成ボーナス・配置適性補正の適用前）で、`UI-AC-034`の補正前表示に使う。`units`は味方→敵の順で、各陣営内はリクエストの`units`配列と同じ順序である。正本は[../ddd/10_API設計.md](../ddd/10_API設計.md)「FormationStatPreviewRequest」「FormationStatPreviewResponse」とする。

戦闘POSTと同じく`cache: "no-store"`・`credentials: "omit"`とし、自動retryしない。編成・強化指定が変わるたびに送り直し、直前の実行中リクエストはabortする。プレビューは戦闘実行とは別の`AbortController`を使い、実行中の戦闘をプレビューの再取得で中断させない。

プレビューの失敗（ネットワーク・422・500のいずれも）は戦闘実行の可否へ影響させない。送信前検証にもプレビュー結果を使わない — サーバーが同じ検証を戦闘POSTでも行うため、プレビューを実行の前提条件にすると、プレビューだけが落ちた状態で戦闘を実行できなくなる。

## 3. UI入力モデル

```ts
type Side = "ally" | "enemy";
type UiRow = "FRONT" | "REAR";
type LogLevel = "SUMMARY" | "DETAILED";

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

### 3.1 強化入力（M11、`ENH-001`で追加予定）

```ts
type EnhancementUnitType = "PHYSICAL" | "ENERGY" | "AGILE";
type EnhancementAttribute = "AGGRESSIVE" | "SHY" | "CUTE" | "SMART" | "COMICAL" | "CLEVER";
type GearStat =
  | "MAXIMUM_HP"
  | "ATTACK"
  | "DEFENSE"
  | "ACTION_SPEED"
  | "CRITICAL_RATE"
  | "CRITICAL_DAMAGE_BONUS"
  | "AFFINITY_BONUS";

interface GearInput {
  readonly stat: GearStat;
  readonly tier: "II" | "III";
  readonly grade: "D" | "C" | "B" | "A" | "S";
}

interface UnitEnhancementInput {
  readonly level: number | ""; // 既定200
  readonly gears: readonly (GearInput | undefined)[]; // 常に9枠。空枠可
  readonly linkExcluded: boolean; // 既定false。陣営のレベルリンク（下記）から外す
}

interface LevelLinkInput {
  readonly enabled: boolean; // 既定false
  readonly level: number | ""; // 既定200
}

interface SideEnhancementInput {
  readonly enabled: boolean; // 既定false
  readonly academyLevels: {
    readonly unitTypes: Readonly<Record<EnhancementUnitType, number | "">>; // 既定1
    readonly attributes: Readonly<Record<EnhancementAttribute, number | "">>; // 既定1
  };
  readonly levelLink: LevelLinkInput;
}
```

- `FormationSlotInput`へ `enhancement?: UnitEnhancementInput` を、`BattleDraft`へ `allyEnhancement`／`enemyEnhancement`（`SideEnhancementInput`）を追加する。
- `enabled: false`（既定）の陣営では、学園レベルとユニット単位の入力値を保持したまま送信対象から外す。
- `levelLink`・`linkExcluded`（レベルリンク。[01_UI要求・画面設計.md](./01_UI要求・画面設計.md) §5.6・§5.7）はUIの入力モデルにだけ存在し、送信DTOへは出さない。どの枠へどの値を載せるかを決めるだけであり、`FormationEnhancementRequest`・`UnitEnhancementRequest`（§5.1）は変更しない。
- リンクの反映は参照時に解決する。枠の `level` は保持したまま、リンク中は読まない。
- リンクレベルが1以上の整数でない間はリンクを適用せず、枠の値へフォールバックする。この状態では`LEVEL_LINK_INVALID`（§6）で送信自体が止まるため、解決結果はステータスプレビューの表示にしか使われない。フォールバックしないと、リンクレベルを打ち直すために消した瞬間、**一度も開いていない枠まで含めた陣営の全枠**が`level: ""`のプレビューPOSTを起こし（プレビューは送信前検証でゲートされない。§2.5）、その陣営のプレビューがまとめて落ちる。従来は「ダイアログを開いてレベルを消した枠」1つに閉じていた挙動を、リンク導入で陣営全体へ広げない。
- ただし`UNIT_LEVEL_INVALID`の免除（§6）は**リンクレベルの妥当性を見ない**。リンクONで除外していない枠は常に免除する。免除条件を解決結果に合わせると、リンクレベルを消した瞬間に各枠の打ちかけの`""`が一斉に違反として現れ、免除の目的（詰み状態を作らない）が崩れる。

解決点は `features/formation/level-link.ts` の1か所に閉じ、リクエスト生成・送信前検証・表示が同じ規則を共有する。

```ts
/**
 * リンク中の枠は枠の`level`ではなくリンクレベルを使う。強化入力を一度も開いて
 * いない枠（`enhancement === undefined`）もリンク対象に含める（`UI-API-024`）。
 * リンクレベルが1以上の整数でない間（打ち直しのために消した`""`を含む）は
 * リンクを適用せず枠の値へフォールバックする。
 *
 * 同じ規則を`tools/exercise-lab`の`resolved_level`（`player_data.py`）が写している。
 * 片方だけ変えると、UIとlabが別のレベルで同じ編成を評価する。
 */
function resolveSlotLevel(
  slot: FormationSlotInput,
  sideEnhancement: SideEnhancementInput,
): number | "" {
  const { levelLink } = sideEnhancement;
  if (isSlotLevelLinked(slot, sideEnhancement) && isPositiveInteger(levelLink.level)) {
    return levelLink.level;
  }
  return slot.enhancement?.level ?? DEFAULT_UNIT_LEVEL; // 既定200
}

/**
 * その枠がリンクの適用を受けているか。読み取り専用表示と`UNIT_LEVEL_INVALID`の
 * 免除がこれを使う。判定はリンクレベルの妥当性を見ない（上記のとおり）。
 */
function isSlotLevelLinked(
  slot: FormationSlotInput,
  sideEnhancement: SideEnhancementInput,
): boolean {
  return (
    sideEnhancement.enabled &&
    sideEnhancement.levelLink.enabled &&
    slot.enhancement?.linkExcluded !== true
  );
}
```

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

### 5.1 強化指定（M11、`ENH-001`で追加予定）

`FormationRequest`と`FormationRequest.units[]`へ任意の`enhancement`を追加する。

```ts
interface FormationEnhancementRequest {
  readonly academyLevels: {
    readonly unitTypes: Readonly<Record<EnhancementUnitType, number>>;
    readonly attributes: Readonly<Record<EnhancementAttribute, number>>;
  };
}

interface UnitEnhancementRequest {
  readonly level: number;
  readonly gears: readonly GearInput[]; // 0～9件
}
```

変換規則：

1. 強化トグルOFF（`enabled: false`）の陣営では、陣営・ユニットとも`enhancement`プロパティ自体を出力しない。既存契約と同一のペイロードとする。
2. 強化トグルONの陣営では学園レベル9キーをすべて出力する。既定値1も省略しない。
3. ユニットのギアは空枠を除外し、0～9件の配列として枠順のまま出力する。
4. レベル200かつギア0件のユニットは`enhancement`を出力しない。省略時の既定と同値のため。
5. ユニット単位の`enhancement`は陣営の`enhancement`があるときだけ出力する。陣営指定なしのユニット指定はAPIが422で拒否する。
6. ユニットの`level`には解決済みレベル（§3.1の`resolveUnitLevel`）を出力する。送信するのは解決済みレベルであり、`levelLink`・`linkExcluded`は出力しない。`FormationEnhancementRequest`・`UnitEnhancementRequest`の形は変えない。
7. 規則4（レベル200かつギア0件は出力しない）は解決済みレベルへ適用する。**強化入力を一度も開いていない枠（`enhancement === undefined`）もリンク対象**であり、リンクONで解決済みレベルが200以外ならギア0件の`enhancement`を出力する。リンクOFFなら従来どおり出力しない（省略時の既定と同値のため）。
8. レベルリンクは規則1の後に効く。強化トグルOFFの陣営ではリンクONでも`enhancement`を出力しない。

## 6. クライアント検証

送信前に全違反を収集し、一度に表示する。

| Path                     | 規則          | UIメッセージ                                 |
| ------------------------ | ------------- | -------------------------------------------- |
| `/allyFormation/units`   | 1～5体        | 味方ユニットを1～5体設定してください。       |
| `/enemyFormation/units`  | 1～5体        | 敵ユニットを1～5体設定してください。         |
| `/*/units/*/position`    | 座標重複なし  | 同じ配置枠に複数のユニットは設定できません。 |
| `/*/memoryDefinitionIds` | 0～6件        | メモリーは6件まで設定できます。              |
| `/turnLimit`             | integer 1～99 | ターン上限は1～99の整数で入力してください。  |
| `/options/logLevel`      | 許容列挙値    | ログレベルを選択してください。               |

M10（`TEX-011`）で次を追加する。違反コードは `UNIT_POOL_MISMATCH`（error）とする。

| Path                    | 規則                                                     | UIメッセージ                                                           |
| ----------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/allyFormation/units`  | `PLAYABLE`のみ（両モード）                               | この枠には戦術演習専用ユニットを設定できません。選び直してください。   |
| `/enemyFormation/units` | 通常戦闘は`PLAYABLE`のみ、戦術演習は`EXERCISE_ENEMY`のみ | この枠には戦術演習専用ユニットだけを設定できます。選び直してください。 |

- 選択ダイアログの候補を編成プールで絞る（`01_UI要求・画面設計.md` §5.2）だけでは足りない。保存draftの復元やCatalog更新で誤ったプールのユニットが枠へ残り得るため、送信経路にも同じ制約を置く。
- `exerciseActive`は検証に使わない。開催終了の演習ユニットもサーバーが受理する（`R-TEX-11` #4）。
- Catalogに存在しない定義は`UNKNOWN_DEFINITION`が指す。カテゴリが判らない枠へプール違反を重ねて出さない。

M11（`ENH-001`）で次を追加する。

| Path                             | 規則          | UIメッセージ                                    |
| -------------------------------- | ------------- | ----------------------------------------------- |
| `/*/enhancement/academyLevels/*` | integer 1以上 | 学園レベルは1以上の整数で入力してください。     |
| `/*/units/*/enhancement/level`   | integer 1以上 | ユニットレベルは1以上の整数で入力してください。 |
| `/*/units/*/enhancement/gears`   | 0～9件        | ギアは9枠まで設定できます。                     |

- 上表の強化3規則は、その陣営の強化トグルがONのときだけ検証する。OFFの陣営は入力値をdraftへ保持したまま送信対象から外す（`UI-CMP-014`）ため、保持しているだけの値で送信を止めてはならない。
- 「陣営指定なしのユニット指定」（`R-ENH-01` #3）は送信前検証ではなくリクエスト生成で保証する。§5.1の変換規則1が、トグルOFFの陣営では陣営・ユニットとも `enhancement` プロパティ自体を出力しないため、この組み合わせは送信ペイロード上に表現され得ない。検証で重ねて検査すると、編集後にトグルをOFFへ戻しただけで送信が止まる（`UI-API-017` がこの不在を証跡として持つ）。
- 成長値（levelGrowth）を持たないユニットへの200以外のレベル指定は事前検証しない。UIはユニット定義の成長値を持たず、APIの422を通常の入力エラーとして該当入力へ表示する。レベルリンクはこの422の発生確率を上げるが方針は変えない。リンク中でレベル入力を編集できない枠でも、サーバー違反の文言は`UI-API-019`の対応づけどおり該当入力へ表示する。

レベルリンクで次を追加する。違反コードは `LEVEL_LINK_INVALID`（error）とする。

| Path                             | 規則          | UIメッセージ                                  |
| -------------------------------- | ------------- | --------------------------------------------- |
| `/*/enhancement/levelLink/level` | integer 1以上 | リンクレベルは1以上の整数で入力してください。 |

- `LEVEL_LINK_INVALID`は、その陣営の強化トグルONかつリンクONのときだけ検証する。トグルOFF・リンクOFFの陣営は入力値をdraftへ保持したまま送信対象から外すため、保持しているだけの値で送信を止めない（学園レベルと同じ扱い）。
- リンク中の枠には`UNIT_LEVEL_INVALID`を出さない。リンク中の枠の`level`は送信に使われないためであり、免除しないと「リンクをONにする前に途中まで打った`""`」がリンクON後も永久に送信を止める。「リンクから外す」を指定した枠は従来どおり検証する。免除はリンクONで除外していないことだけで決め、リンクレベルが妥当かどうかを見ない（§3.1）。
- `/*/enhancement/levelLink/level`はUI入力モデル上のpathであり、送信DTOには存在しない。サーバーのJSON Pointerがこのpathを指すことはなく、対応づけ（§13）はクライアント違反の表示先を決めるためだけに使う。

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

  previewFormationStats(
    request: FormationStatPreviewRequest,
    options: { readonly signal: AbortSignal; readonly requestId?: string },
  ): Promise<FormationStatPreviewApiResult>;
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

type FormationStatPreviewApiResult =
  | {
      readonly ok: true;
      readonly response: FormationStatPreviewResponse;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly error: UiApiError;
      readonly requestId?: string;
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
- `displayName`と分類値が契約shapeを満たす
- `gearEffects`は不在を許容する。届いた場合は各項目が`stat`・`application`・`values`を持ち、各値が`tier`・`grade`・有限数の`percentagePoints`を持つ
- `category`・`exerciseActive`は不在を許容する。届いた場合は`category`が空でないstring、`exerciseActive`がbooleanである

契約違反時は編成を有効にせず `RESPONSE_CONTRACT_MISMATCH`を表示する。UIがCatalogファイルから欠損値を補完しない。

## 9. 戦闘成功レスポンスの検証

最低限、次を実行時検証する。

- `schemaVersion`がnumber
- `battleId`と`catalogRevision`がstring
- `result`の必須3項目
- `initialState.units`がarray
- `events`と`stateTransitions`がarray
- 各unitに `battleUnitId`、`unitDefinitionId`、`side`、HP、combatStatusがある
- `unitSummaries`がarrayであり、各行が§11.1の全項目を持つ
- `unitSummaries`が`initialState.units`の各`battleUnitId`をちょうど1行ずつ持つ（過不足・重複なし）

未知の任意プロパティ、イベントtype、列挙値は許容する。必須shape欠落時は部分表示で誤解を招かず、`RESPONSE_CONTRACT_MISMATCH`として失敗扱いにする。検証ライブラリを使う場合も、OpenAPI全体を厳格に再実装して将来の追加を拒否しない。

`finalState`は**不在を許容する**。サーバーは`SUMMARY`実行でこれを省略しうるためである。届いた場合だけ、`finalState.units`のshapeと§10手順5のroster対応を従来どおり検証する — 存在するのに壊れているのは、表示層まで通してはいけない契約違反のままである。

`unitSummaries`だけは逆に**必須**とする。サマリ表はこの配列だけから描くため、rosterとの対応が1対1でないと表示が静かに壊れる。

- 行が足りない: その枠が警告なく0表示になる（クライアント集計時代の既知の不具合と同じ見え方）。
- 同じ`battleUnitId`が複数ある: §11.2のindex化で後の行が無警告で勝ち、矛盾した集計値が「正しい値」として表示される。
- rosterに無い`battleUnitId`がある: どの行にも現れず、集計の一部が黙って消える。

包含だけを見ると後ろ2つを通してしまうため、件数・IDの一意性・rosterとの完全一致をそれぞれ確認する。

配列順もAPI契約は定めている（[10_API設計.md](../ddd/10_API設計.md)「UnitBattleSummaryResponse」: 配列順は `BattleStateResponse.units` と同じ）。ただしこの最小validatorは順序違反だけでは拒否しない。UIは `battleUnitId` で結合し、表の並びは§11.2のとおりrosterが決めるため、順序が違っても表示は壊れないためである。本節冒頭の方針（表示が成立するレスポンスをOpenAPIの厳密な再実装で拒否しない）をここでも適用する。

値域はサーバーのschemaに合わせ、集計3項目は0以上のinteger、`finalHp`・`maximumHp`は0以上の有限number（丸めない）とする。

### 9.1 プレビューレスポンスの検証

最低限、次を実行時検証する。

- `schemaVersion`がnumber、`catalogRevision`がstring
- `units`がarray
- 各unitに `side`、`unitDefinitionId`、`formationPosition`、有限numberの`maximumHp`、`combatStats`の6項目（`attack`、`defense`、`criticalRate`、`actionSpeed`、`affinityBonus`、`criticalDamageBonus`）がある
- `enhancedBaseStats` は**任意**とする。存在する場合だけ、`combatStats` と同じ6項目に加えて有限numberの `maximumHp` を持つことを検証する

契約違反は`RESPONSE_CONTRACT_MISMATCH`として扱うが、他のレスポンス検証と違い戦闘実行を止めない（§2.5）。プレビュー表示だけを取り下げる。

`enhancedBaseStats`（`UI-AC-034` の補正前ステータス）だけは不在を正常系として扱う。APIとUIは別々にデプロイされ、切替中は本フィールドを持たないサーバーの応答も届き得るためである（[10_API設計.md](../ddd/10_API設計.md)「ローリングデプロイ中の可用性」）。不在で応答全体を契約違反にすると、補正後のプレビューまで巻き添えで消える。

一方、**存在するのに壊れている**場合は契約違反とする。欠けた項目だけが抜けた表示になり、利用者からは補正前の値として正しく見えてしまうためである。不在時の表示は補正後の値へ差し替えず、取得できない旨を示す（§5.8）。

shape検証に加えて、応答の各`units[]`がリクエストへ載せた枠と`side`・`formationPosition`・`unitDefinitionId`で一致することも確かめる。1件でも食い違えば、対応づかない枠だけを落とさずプレビュー全体を失敗扱いにする — どの枠の値が信用できるのか画面から区別できないため。

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
4. 最終HP・戦闘状態は`unitSummaries`をbattleUnitIdでindex化して結合する（`finalState`は読まない。`SUMMARY`実行では届かないため）。
5. `unitSummaries`に存在しないunitは契約不一致とする（§9）。
6. `finalState`が届いた場合、そこに存在しないunitも契約不一致とする（§9）。詳細タブだけがこの状態を読む。

## 11. サマリ集計

UIはイベントを畳み込まない。集計はサーバーが確定させた `unitSummaries`
（[10_API設計.md](../ddd/10_API設計.md)「UnitBattleSummaryResponse」）をそのまま読む。

クライアント集計をやめた理由は2つある。継続ダメージ（`CONTINUOUS_DAMAGE_APPLIED`）を経路ごと取りこぼし、DoT主体のユニット・メモリーの貢献が0に見えていたこと。そして `SUMMARY` ではダメージ・回復イベント自体が公開されないため、ログレベルを下げた瞬間に全ユニットが警告なく0表示になっていたことである。どちらもアダプタを足しても塞げない — 集計の正本はサーバー側にしかない。

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

### 11.2 生成手順

1. §10の表示用Rosterを`initialState.units`の順で作る。
2. `unitSummaries`を`battleUnitId`でindex化する。
3. Roster1件につき1行を、対応する`unitSummaries`の行から作る。
4. 陣営の振り分け（ALLY表／ENEMY表）はRoster側の`side`で決める。`unitSummaries[].side`と同じ値だが、行の並びと表の左右はRosterが正本である。

- 対応する行が無いRosterユニットは0埋めし、`combatStatus`を`UNKNOWN`として警告フラグを立てる。この状態は§9の検証が成功レスポンス自体を拒否するため通常は到達しない。0埋め＋警告にしておくのは、検証を通らない経路で欠落行だけが正しい値のように見えるのを防ぐ防御である。
- 表示時に整数へ勝手に丸めない。集計3項目の現契約はintegerだが、将来の型変更を検出できるよう§9のvalidatorで守る。

### 11.3 集計セマンティクスの正本

「ダメージはHPへ向かった量（クランプで破棄された超過分を含み、シールド・サブユニット吸収は含まない）を数える」「継続ダメージを合算する」「回復は実HP増加量を数える」「回復リンクの転送分を回復者へ計上する」といった規則は、すべて[10_API設計.md](../ddd/10_API設計.md)「集計セマンティクス」が正本である。UIはその定義を再実装せず、値をそのまま表示する。

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

formatter本体はイベントカテゴリ別のファイルが持ち、それぞれ `Readonly<Record<string, EventFormatter>>` をexportする。

| ファイル                          | 担当するイベント                                   |
| --------------------------------- | -------------------------------------------------- |
| `battle-flow-event-formatters.ts` | 戦闘・ターン・行動順・行動・戦闘不能・戦闘終了     |
| `skill-event-formatters.ts`       | クールタイム・チャージ・パッシブ                   |
| `resource-event-formatters.ts`    | リソース増減・EXゲージ                             |
| `effect-event-formatters.ts`      | 回復・効果ライフサイクル・状態異常・命中判定（M7） |
| `damage-event-formatters.ts`      | ダメージ内訳（M8、§12.1）                          |

`event-formatters.ts` はこれらを合成して `formatEvent` を公開するだけを担う。共通の型・helper（`EventPresentation`／`RosterIndex`／`resolveDisplayName`）は`event-presentation.ts`にあり、formatter群の各ファイル間の循環importを避ける。

カテゴリ間でtypeは重複させない。単純なspreadでは後勝ちで片方のformatterが黙って死に、そのイベントだけgeneric fallback相当の表示へ落ちるため、合成は `mergeDisjointFormatters`（`event-presentation.ts`）を通し、重複を検出したら衝突したtypeとカテゴリ名を挙げてthrowする。カテゴリを追加するときは必ずこの合成へ渡す（渡されないregistryは検出対象にならない）。

### 12.1 M8 ダメージイベントの内訳（DMG-010、Issue #191）

`DAMAGE_APPLIED`は`08_ドメインイベント.md`の不変条件#6を読み手が突き合わせられる形で並べる。

```text
{攻撃者} → {対象} {ヒットN|反射ダメージ|リンクダメージ}:
  計算ダメージ{calculatedDamage}
  （タイプありシールド吸収{typedShieldAbsorbed}、タイプなしシールド吸収{untypedShieldAbsorbed}、
    サブユニット吸収{subUnitAbsorbed}、シールド迂回直撃{hpDirectDamage}、破棄{discardedDamage}）
  → HPダメージ{hitPointDamage}。HP {hpBefore} → {hpAfter}
```

- 内訳項目はすべて任意として扱う。M4〜M7に録取したfixtureは持たないため、欠落を「吸収0」と断定しない。
- 値が0の項目は出さない。通常ヒットの1行を短く保つため。
- 複数hitは`hitIndex + 1`を「ヒットN」として出す。`isReflectedDamage`／`isLinkedDamage`のダメージは命中判定を通らず`hitIndex`が常に0のため、ヒット番号ではなく由来ラベルを出す。
- `shieldType: null`はタイプなしプールであり、`null`をそのまま見せない。`reason: DECAY`は吸収ではなく時間減衰のため動詞を分ける。
- `reason`／`damageType`／`continuousDamageKind`／`mode`などの列挙値は翻訳せずそのまま出す。UI側で列挙値の部分集合を持つとDomainの分類と黙って乖離するため。
- `confusionDamageMultiplier`（R-CFS-02）は与ダメージ倍率と別の語で出す。`APPLY_DAMAGE_MOD`由来ではない減少をR-DMG-04の集計へ混ぜないというDomain側の分離をそのまま保つ。
- summary adapter（§11.4）は変更しない。`CONTINUOUS_DAMAGE_APPLIED`もDAMAGE/DEFENSE列へ足さない。shield absorbedをDEFENSE列へ混ぜないのと同じ理由で、別指標を追加する場合は名称と集計規則を新規ADRで定義する。

### 12.1.1 `DAMAGE_CALCULATED`の計算過程（DMG-012、Issue #488）

`DAMAGE_CALCULATED`はダメージ量の調査に使う監査イベントであり、`08_ドメインイベント.md`「payload単体での再現可能性」の恒等式を読み手が電卓で追える形で並べる。

```text
{攻撃者} → {対象} ヒットN: 計算ダメージ{finalDamage}
  （{damageType}、攻撃力{attackerAttack}、実効防御{effectiveDefense}、
    防御貫通{defenseIgnoreRate}、シールド貫通{shieldIgnoreRate}、軽減貫通{damageReductionIgnoreRate}、
    基礎ダメージ{baseDamage}、スキル威力{skillPower}、Formula {skillPowerFormulaKind}、
    属性倍率{attributeMultiplier}、有利属性ダメージ{attackerAffinityBonus} {攻撃側}→{防御側}、
    会心倍率、与/被ダメージ倍率、Action内追加倍率、混乱倍率、
    倍率適用後{rawPreTruncationDamage}、凍結増幅、攻撃時追加ダメージ、肩代わり軽減、
    切り捨て前{preTruncationDamage}、閾値軽減倍率、ダメージ無効あり|なし）
```

- **§12.1 の「値が0の項目は出さない」を、この計算過程の項目には適用しない。** 等倍・ゼロを隠すと「スキル威力1」「属性倍率1」「防御貫通0%」「攻撃力0」のような、計算を疑うときに一番確かめたい状態ほど文から消える。値を落とすのはpayloadがその項目自体を持たないときだけで、`DAMAGE_WILL_BE_APPLIED`の貫通率を0%でも出すのと同じ規約である。**この規約は貫通3割合・攻撃力を含む枠内の全項目に等しく適用する** — 一部の項目にだけ0隠しのhelper（`rateTerm`／`positiveTerm`）を残すと、同じ1文の中で表示規約が二重になる。
- boolean項目（`damageImmunityNullified`）は成立・不成立の両方を語で出す。`true`のときだけ語を出す実装では、不成立とDMG-012以前の「項目なし」を要約の上で区別できない。
- 並びはR-DMG-01の乗算順に固定する。UI側で内訳を再計算・按分しないのは§12.1と同じ。
- 属性倍率1が「有利属性なし」なのか「有利属性ダメージ0%」なのかを、`isFavorableAttribute`を根拠に語で分ける。R-SUB-02のサブユニット追加ヒットは属性相性4欄を持たないため、その場合はこの語自体を出さない（`false`と断定しない）。
- M4〜M7に録取したfixtureは新項目を持たない。§12.1と同じく欠落を0と断定せず、その項目だけを文から消す（generic fallbackへは落とさない）。

### 12.2 状態遷移deltaの展開（DMG-010、Issue #191）

`EntityCollectionDelta`は件数（`+n / ~n / -n`）に加えて、`added`／`updated`／`removed`ごとに1行を出す。

- エンティティ名は`10_API設計.md`が定義するID項目（`effectInstanceId`／`subUnitInstanceId`／`markerInstanceId`／`id`と、`effectDefinitionId`／`subUnitDefinitionId`／`markerId`／`skillDefinitionId`）から取る。定義IDの命名規則を解析しない。`effectKindKey`は`R-STA-03`の同種グループ鍵であって定義識別子ではなく、Catalogが`kindKey`を宣言した定義群では複数の定義が同じ値を共有する（Issue #519）ため、定義側の名前としては使わない。
- `updated`は`before`/`after`を再帰比較し、変わったleafだけを`path before → after`として出す。
- IDが読めない未知shapeはcompact JSONへ退避する。件数へ黙って畳まないことで、将来のエンティティ種別も可視のまま残る。
- 差分が公開projectionに現れない`updated`は「表示可能な変更項目なし」と明示する。`EffectStateResponse.value`はDMG-004/005時点で`{ magnitude }`だけを持ち、シールド残量・サブユニット耐久の増減を運ばないため、この文言が実際に出うる。

## 13. エラー正規化

```ts
type UiApiErrorKind =
  | "VALIDATION"
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
- `/allyFormation/enhancement/academyLevels/...`（M11）
- `/allyFormation/units/{n}/enhancement/level`／`/allyFormation/units/{n}/enhancement/gears/{m}`（M11）
- `/enemyFormation/...`
- `/turnLimit`
- `/options/logLevel`

送信DTOの `units[n]` と元の `slotKey` の対応表をrequest生成時に保持する。sort後の配列indexから画面slotを逆引きし、誤った枠を強調しない。M11のギアも同様に、空枠を除外した送信配列の `gears[m]` から元のギア枠indexへの対応表を保持する。

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
- `UI-API-006`: HEAL列を要求量ではなく実HP回復量（`appliedAmount`）で集計し、回復イベントを持たないレスポンスでは0表示する。
- `UI-API-007`: 未知イベントを詳細に残し、サマリ集計では安全に無視する。
- `UI-API-008`: Request ID、diagnosticId、Retry-After、ETagを取得でき、必要な値を表示できる。
- `UI-API-009`: 自動retryを行わない。
- `UI-API-010`: GitHub Pages originからpreflightとPOSTが成功する。
- `UI-API-011`: 一覧APIからUnit・Memory、選択可否、Catalog revisionを取得する。
- `UI-API-012`: 一覧APIのETagを使った条件付きGETと304を扱える。
- `UI-API-013`: 一覧API契約違反時に編成・戦闘送信を有効化しない。
- `UI-API-014`: 戦術演習リクエストへ`turnLimit`を含めず、敵1体・敵メモリー0件を送信前に強制する。
- `UI-API-015`: 戦術演習レスポンスの`result`（総スコア、ブレイク回数、ブレイク履歴）を実行時shape検証し、契約違反を`RESPONSE_CONTRACT_MISMATCH`として扱う。
- `UI-API-016`: 演習イベント（スコア加算、ブレイク、復活）を詳細表示に残し、未知イベントと同じ許容規則で扱う。
- `UI-API-017`: 強化トグルOFFの陣営では`enhancement`プロパティを出力せず、既存契約と同一のリクエストを送る。
- `UI-API-018`: 強化トグルONの陣営で学園レベル9キーを`enhancement.academyLevels`へ変換し、ユニットのギアを空枠を除外した0～9件の配列として送る。
- `UI-API-019`: `enhancement`配下の422 JSON Pointer（学園レベル・レベル・ギア）を該当入力へ対応づける。成長値を持たないユニットのレベル違反を含む。
- `UI-API-020`: 編成ステータスプレビューへ、戦闘POSTと同じ編成・強化指定（`turnLimit`・`options`を除く）を送り、応答の`units`を陣営ごとの並び順で編成枠へ対応づける。
- `UI-API-021`: プレビューの失敗（ネットワーク・HTTPエラー・契約違反）を戦闘実行の可否と送信前検証へ波及させない。
- `UI-API-022`: 一覧応答の`gearEffects`をそのままギア選択肢の表示へ渡し、不在時はランク名だけの表示へフォールバックする。UIは効果表を持たない。
- `UI-API-023`: レベルリンクONの陣営で、各ユニットの`enhancement.level`へ解決済みレベル（リンクレベル、または「リンクから外す」枠の個別レベル）を載せる。`levelLink`・`linkExcluded`をリクエストへ出力せず、`FormationEnhancementRequest`・`UnitEnhancementRequest`の形を変えない。
- `UI-API-024`: 強化入力を一度も開いていない枠（`enhancement === undefined`）もリンク対象とし、リンクONなら解決済みレベルとギア0件の`enhancement`を出力する。解決済みレベルが200かつギア0件の枠は従来どおり出力しない。
- `UI-API-025`: リンクレベルが1以上の整数でない場合に`LEVEL_LINK_INVALID`で送信を止め、その間はリンクを適用せず枠の値へフォールバックする（プレビューを陣営ごと落とさない）。リンク中の枠へは`UNIT_LEVEL_INVALID`を出さず、強化トグルOFFの陣営ではリンクを検証しない。
- `UI-API-026`: 編成ステータスプレビューへも戦闘POSTと同じ解決済みレベルを送る（`UI-API-020`の対応づけを維持する）。
