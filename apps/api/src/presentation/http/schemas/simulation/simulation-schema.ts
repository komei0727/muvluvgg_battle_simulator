import {
  battleLogEventResponseSchema,
  battleLogEventResponseDocSchema,
  STATUS_KIND_ENUM,
} from "../battle-log/battle-log-schema.js";

/**
 * `10_API設計.md`のJSON契約をFastify/AJV向けのJSON Schemaへ落としたもの。
 *
 * 意図的にJSON Schemaへ入れない検証:
 * - `turnLimit`の1〜99、各`units`の1〜5件、`memoryDefinitionIds`の0〜6件、
 *   `column`/`row`/`logLevel`の許容値— これらは「人数、配置、値域などの
 *   Command違反」として`422 INVALID_COMMAND`（Application層の
 *   `validateCommandShape`）が担当する（`10_API設計.md`「ステータスコード
 *   対応」）。JSON Schemaへ`minItems`/`enum`等で重複させると、境界値が
 *   `400`と`422`のどちらで拒否されるかが契約と一致しなくなる。
 *
 * JSON Schemaが担当するのはあくまで構造・型（`400 MALFORMED_REQUEST`）だけ:
 * 必須項目の欠落、型不正（数値文字列や小数を含む）、未知プロパティ。
 */

const formationPositionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["column", "row"],
  properties: {
    column: { type: "integer" },
    row: { type: "string" },
  },
} as const;

/**
 * 学園レベルの系統キー（R-ENH-02 #1のタイプ3系統・属性6系統）。キー名の綴りは
 * 構造の一部として`additionalProperties: false`で固定する — 未知の系統を黙って
 * 無視すると「指定したのに効かない」になるため。レベルの値域（1以上）は
 * 他の値域と同じく`422 INVALID_COMMAND`が担当する。
 */
const academyLevelMapSchema = (systems: readonly string[]) =>
  ({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(systems.map((system) => [system, { type: "integer" }])),
  }) as const;

const UNIT_TYPE_SYSTEMS = ["PHYSICAL", "ENERGY", "AGILE"] as const;
const ATTRIBUTE_SYSTEMS = ["AGGRESSIVE", "SHY", "CUTE", "SMART", "COMICAL", "CLEVER"] as const;

const academyLevelsRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    unitTypes: academyLevelMapSchema(UNIT_TYPE_SYSTEMS),
    attributes: academyLevelMapSchema(ATTRIBUTE_SYSTEMS),
  },
} as const;

/** `10_API設計.md`「FormationEnhancementRequest」（M11）。 */
const formationEnhancementRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    academyLevels: academyLevelsRequestSchema,
  },
} as const;

/** `10_API設計.md`「GearRequest」。列挙値は公開文書側だけが持つ（値域と同じ理由）。 */
const gearRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stat", "tier", "grade"],
  properties: {
    stat: { type: "string" },
    tier: { type: "string" },
    grade: { type: "string" },
  },
} as const;

const unitEnhancementRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    level: { type: "integer" },
    rank: { type: "integer" },
    gears: { type: "array", items: gearRequestSchema },
  },
} as const;

const formationUnitRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitDefinitionId", "position"],
  properties: {
    unitDefinitionId: { type: "string", minLength: 1, maxLength: 256 },
    position: formationPositionRequestSchema,
    enhancement: unitEnhancementRequestSchema,
  },
} as const;

export const formationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units", "memoryDefinitionIds"],
  properties: {
    units: { type: "array", items: formationUnitRequestSchema },
    memoryDefinitionIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
    enhancement: formationEnhancementRequestSchema,
  },
} as const;

export const simulationOptionsRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    logLevel: { type: "string" },
  },
} as const;

/**
 * `POST /api/v1/battle-simulations`のrequest body schema（実行時validation用）。
 * 値域・列挙値をあえて持たない（ファイル冒頭の注記を参照）。
 */
export const battleSimulationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation", "turnLimit"],
  properties: {
    allyFormation: formationRequestSchema,
    enemyFormation: formationRequestSchema,
    turnLimit: { type: "integer" },
    options: simulationOptionsRequestSchema,
  },
} as const;

const formationPositionRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["column", "row"],
  properties: {
    column: { type: "integer", enum: [0, 1, 2] },
    row: { type: "string", enum: ["FRONT", "REAR"] },
  },
} as const;

/** R-ENH-02 #1: 各系統は1以上の整数で、上限を設けない。 */
const academyLevelMapDocSchema = (systems: readonly string[]) =>
  ({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      systems.map((system) => [system, { type: "integer", minimum: 1 }]),
    ),
  }) as const;

const academyLevelsRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    unitTypes: academyLevelMapDocSchema(UNIT_TYPE_SYSTEMS),
    attributes: academyLevelMapDocSchema(ATTRIBUTE_SYSTEMS),
  },
} as const;

const formationEnhancementRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    academyLevels: academyLevelsRequestDocSchema,
  },
} as const;

/** R-ENH-04 #2の効果表が定める対象ステータス7種・種別2種・ランク5種。 */
const gearRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stat", "tier", "grade"],
  properties: {
    stat: {
      type: "string",
      enum: [
        "MAXIMUM_HP",
        "ATTACK",
        "DEFENSE",
        "ACTION_SPEED",
        "CRITICAL_RATE",
        "CRITICAL_DAMAGE_BONUS",
        "AFFINITY_BONUS",
      ],
    },
    tier: { type: "string", enum: ["II", "III"] },
    grade: { type: "string", enum: ["D", "C", "B", "A", "S"] },
  },
} as const;

/**
 * R-ENH-04 #1: 最大9個。R-ENH-04 #6: 同一の対象ステータスは最大3個。R-ENH-05 #4:
 * 現在レベルは1以上の整数で上限なし。R-ENH-07 #4: ユニットランクは0以上5以下の整数。
 *
 * #6はJSON Schemaでは表せない（「配列要素の特定プロパティごとの出現回数上限」に
 * 対応する語彙が無い）ため、`description`で示しアプリケーション検証が422で拒否する
 * — 候補数上限（`candidates`）と同じ扱い。
 */
const unitEnhancementRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    level: { type: "integer", minimum: 1 },
    rank: { type: "integer", minimum: 0, maximum: 5 },
    gears: {
      type: "array",
      items: gearRequestDocSchema,
      maxItems: 9,
      description:
        "At most 3 gears may share the same stat (R-ENH-04 #6). Violations come back as 422 INVALID_COMMAND with the stat in the path.",
    },
  },
} as const;

const formationUnitRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitDefinitionId", "position"],
  properties: {
    unitDefinitionId: { type: "string", minLength: 1, maxLength: 256 },
    position: formationPositionRequestDocSchema,
    enhancement: unitEnhancementRequestDocSchema,
  },
} as const;

export const formationRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units", "memoryDefinitionIds"],
  properties: {
    units: { type: "array", items: formationUnitRequestDocSchema, minItems: 1, maxItems: 5 },
    memoryDefinitionIds: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 256 },
      maxItems: 6,
    },
    enhancement: formationEnhancementRequestDocSchema,
  },
} as const;

export const simulationOptionsRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    logLevel: { type: "string", enum: ["SUMMARY", "DETAILED"] },
  },
} as const;

/**
 * `POST /api/v1/battle-simulations`のOpenAPI公開用request body schema。
 * `10_API設計.md`が明記する値域・列挙値（`turnLimit`の1〜99、`units`の
 * 1〜5件、`memoryDefinitionIds`の0〜6件、`column`/`row`/`logLevel`の許容値）
 * を文書へ反映するが、実行時validationには使わない
 * （`build-server.ts`の`@fastify/swagger`用`transform`でこのschemaへ差し替え、
 * `422 INVALID_COMMAND`として集約検証したい値域違反が`400`へ先取りされる
 * ことを避ける）。
 */
export const battleSimulationRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation", "turnLimit"],
  properties: {
    allyFormation: formationRequestDocSchema,
    enemyFormation: formationRequestDocSchema,
    turnLimit: { type: "integer", minimum: 1, maximum: 99 },
    options: simulationOptionsRequestDocSchema,
  },
} as const;

/** `10_API設計.md`「HP・リソース」: HPは「0以上の有限number」（integer制約なし）。 */
const currentMaximumValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["current", "maximum"],
  properties: {
    current: { type: "number", minimum: 0 },
    maximum: { type: "number", minimum: 0 },
  },
} as const;

/** `10_API設計.md`「HP・リソース」: AP・PP・EXゲージは「0以上のinteger」。 */
const currentMaximumIntegerValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["current", "maximum"],
  properties: {
    current: { type: "integer", minimum: 0 },
    maximum: { type: "integer", minimum: 0 },
  },
} as const;

export const valueChangeNumberSchema = {
  type: "object",
  additionalProperties: false,
  required: ["before", "after"],
  properties: {
    before: { type: "number" },
    after: { type: "number" },
  },
} as const;

const valueChangeStringSchema = {
  type: "object",
  additionalProperties: false,
  required: ["before", "after"],
  properties: {
    before: { type: "string" },
    after: { type: "string" },
  },
} as const;

export const formationPositionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["column", "row"],
  properties: {
    column: { type: "integer", enum: [0, 1, 2] },
    row: { type: "string", enum: ["FRONT", "REAR"] },
  },
} as const;

/** `10_API設計.md`「FormationPositionResponse」共通座標表: `x`0-2、`y`0-3の3×4固定格子。 */
const globalCoordinateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "integer", minimum: 0, maximum: 2 },
    y: { type: "integer", minimum: 0, maximum: 3 },
  },
} as const;

const resourceStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ap", "pp", "extraGauge"],
  properties: {
    ap: currentMaximumIntegerValueSchema,
    pp: currentMaximumIntegerValueSchema,
    extraGauge: currentMaximumIntegerValueSchema,
  },
} as const;

export const combatStatsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "attack",
    "defense",
    "criticalRate",
    "actionSpeed",
    "affinityBonus",
    "criticalDamageBonus",
  ],
  properties: {
    attack: { type: "number" },
    defense: { type: "number" },
    criticalRate: { type: "number" },
    actionSpeed: { type: "number" },
    affinityBonus: { type: "number" },
    criticalDamageBonus: { type: "number" },
  },
} as const;

const shieldStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["physical", "energy", "untyped"],
  properties: {
    physical: { type: "number", minimum: 0 },
    energy: { type: "number", minimum: 0 },
    untyped: { type: "number", minimum: 0 },
  },
} as const;

/** `10_API設計.md`「SubUnitStateResponse」。 */
const subUnitStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subUnitInstanceId", "subUnitDefinitionId", "durability", "appliedTurnNumber"],
  properties: {
    subUnitInstanceId: { type: "string" },
    subUnitDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    durability: currentMaximumValueSchema,
    appliedTurnNumber: { type: "integer", minimum: 0 },
    appliedActionId: { type: "string" },
  },
} as const;

/**
 * `10_API設計.md`「EffectStateResponse」。`value`は`effectKindKey`ごとの
 * 構造化された値で、M7で具体Schemaが定まるまでは開いたまま(`{}`)にする
 * （`10_API設計.md`「`effectKindKey`を`value`の判別子として使用し、
 * 効果種別ごとの`value`SchemaはOpenAPIのoneOfで定義する」はM7時点の完成形）。
 */
export const effectStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "effectDefinitionId",
    "category",
    "effectKindKey",
    "stackMode",
    "isEffective",
    "value",
    "appliedTurnNumber",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    effectDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    // R-MEM-04（M7-006、Issue #179）: Memory由来の効果は付与者ユニットの代わりに付与元陣営を持つ。
    sourceSide: { type: "string", enum: ["ALLY", "ENEMY"] },
    category: { type: "string", enum: ["BUFF", "DEBUFF", "STATUS_ABNORMALITY"] },
    effectKindKey: { type: "string" },
    // M7-009（Issue #182）: `APPLY_STATUS`由来の効果だけが持つ状態の種別。
    // `effectDefinitionId`の命名規則を解析させずに、気絶・凍結・暗闇・隠密などを
    // 表示できるようにする任意プロパティ。状態異常かどうかは`category`が表す
    // （`statusKind`はSTEALTH等の有利な状態にも設定されるため、有無だけでは
    // 状態異常を判別できない）。`effectKindKey`はR-STA-03の同種グループ鍵
    // （Issue #519）であって定義識別子でも分類軸でもなく、Catalogが`kindKey`を
    // 宣言した定義群では複数の定義が同じ値を共有する。
    statusKind: { type: "string", enum: STATUS_KIND_ENUM },
    stackMode: { type: "string", enum: ["STACKABLE", "NON_STACKING"] },
    isEffective: { type: "boolean" },
    value: {},
    duration: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "remaining"],
      properties: {
        unit: { type: "string", enum: ["ACTION", "TURN", "SKILL_USE"] },
        remaining: { type: "integer", minimum: 0 },
      },
    },
    appliedTurnNumber: { type: "integer", minimum: 0 },
    appliedActionId: { type: "string" },
  },
} as const;

/**
 * `10_API設計.md`「MarkerStateResponse」(R-EFF-10、EFF-004)。
 * `EffectStateResponse`と異なり`category`/`stackMode`/`isEffective`/`value`を
 * 持たず、代わりに`stackCount`/`stackMax`を持つ（Markerは重複解決の対象外、
 * 対象ごとに常に1インスタンス）。
 */
const markerStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["markerInstanceId", "markerId", "stackCount", "stackMax"],
  properties: {
    markerInstanceId: { type: "string" },
    markerId: { type: "string" },
    sourceUnitId: { type: "string" },
    // R-MEM-04（REL-008、Issue #263）: Memory由来Markerは付与者ユニットを持たず
    // 付与元陣営を持つ（`effectStateResponseSchema`と同じexactly-one union）。
    sourceSide: { type: "string", enum: ["ALLY", "ENEMY"] },
    stackCount: { type: "integer", minimum: 0 },
    stackMax: { type: ["integer", "null"], minimum: 1 },
    duration: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "remaining"],
      properties: {
        unit: { type: "string", enum: ["ACTION", "TURN"] },
        remaining: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

/**
 * `10_API設計.md`「CooldownStateResponse」。`setAtActionId`/`setAtTurnNumber`は
 * `unit`に応じてどちらか一方だけを必須にするXOR制約を`oneOf`で強制する
 * （両方欠落・両方存在は不正）。`remaining`は残数がある
 * スキルだけを返す契約のため`minimum: 1`。
 */
/**
 * 設定scopeフィールドは`unit`に対応する側だけを持ち、反対側は持たない
 * （`10_API設計.md`「CooldownStateResponse」）。
 *
 * 一方で、対応する側すら持たないエントリが実在する。R-SKL-04のクールタイムは
 * PSがターン開始・終了など**行動外のトップレベルイベント**から発動した場合に
 * 設定scopeを持たず（`cooldown-state.ts`の`startCooldown`、`scope === undefined`）、
 * 「不在そのもの」が『どの行動でも設定scopeに一致しない＝次の行動終了で減る』の
 * 正本になる（`08_ドメインイベント.md`「差分がフィールドを持たないこと」）。
 * `setAtActionId`を無条件必須にしていたため、この状態を持つ実在Unit
 * （`UNIT_LUCIE_MAID`の`SKL_LUCIE_MAID_PS1`）のレスポンスはserialize時に落ち、
 * 実HTTP経路が`500 INTERNAL_INVARIANT_VIOLATION`を返していた（REL-004で検出）。
 *
 * 必須から任意への緩和は`10_API設計.md`「バージョニング」の後方互換な追加に当たる。
 * この変種は一度も公開されたことがなく（常に500だった）、従来公開されていた
 * 「行動内で設定されたクールタイム」は今も必ず`setAtActionId`を持つため、
 * 既存クライアントが受け取れたレスポンスの形は変わらない。
 */
export const cooldownStateResponseSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["skillDefinitionId", "unit", "remaining"],
      properties: {
        skillDefinitionId: { type: "string" },
        unit: { const: "ACTION" },
        remaining: { type: "integer", minimum: 1 },
        setAtActionId: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["skillDefinitionId", "unit", "remaining"],
      properties: {
        skillDefinitionId: { type: "string" },
        unit: { const: "TURN" },
        remaining: { type: "integer", minimum: 1 },
        setAtTurnNumber: { type: "integer", minimum: 0 },
      },
    },
  ],
} as const;

/** `10_API設計.md`「ChargeStateResponse」。 */
const chargeStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "startedActionId", "status"],
  properties: {
    skillDefinitionId: { type: "string" },
    startedActionId: { type: "string" },
    status: { type: "string", enum: ["CHARGING", "RELEASE_READY", "HELD_BY_FREEZE"] },
  },
} as const;

const battleUnitStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "battleUnitId",
    "unitDefinitionId",
    "side",
    "formationPosition",
    "coordinate",
    "combatStatus",
    "hp",
    "resources",
    "combatStats",
    "shields",
    "subUnits",
    "effects",
    "cooldowns",
  ],
  properties: {
    battleUnitId: { type: "string" },
    unitDefinitionId: { type: "string" },
    side: { type: "string", enum: ["ALLY", "ENEMY"] },
    formationPosition: formationPositionResponseSchema,
    coordinate: globalCoordinateResponseSchema,
    combatStatus: { type: "string", enum: ["ACTIVE", "DEFEATED"] },
    hp: currentMaximumValueSchema,
    resources: resourceStateResponseSchema,
    combatStats: combatStatsResponseSchema,
    shields: shieldStateResponseSchema,
    subUnits: { type: "array", items: subUnitStateResponseSchema },
    effects: { type: "array", items: effectStateResponseSchema },
    markers: { type: "array", items: markerStateResponseSchema },
    cooldowns: { type: "array", items: cooldownStateResponseSchema },
    charge: chargeStateResponseSchema,
  },
} as const;

const actionReservationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["order", "battleUnitId", "actionSpeedAtOrdering", "reservedActionType"],
  properties: {
    order: { type: "integer", minimum: 1 },
    battleUnitId: { type: "string" },
    actionSpeedAtOrdering: { type: "number" },
    reservedActionType: { type: "string", enum: ["ACTIVE_SKILL", "EXTRA_SKILL"] },
  },
} as const;

export const battleStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stateVersion", "battleStatus", "turnNumber", "cycleNumber", "units", "actionQueue"],
  properties: {
    stateVersion: { type: "integer", minimum: 0 },
    battleStatus: { type: "string", enum: ["READY", "RUNNING", "COMPLETED"] },
    turnNumber: { type: "integer", minimum: 0, maximum: 99 },
    cycleNumber: { type: "integer", minimum: 0 },
    units: { type: "array", items: battleUnitStateResponseSchema },
    actionQueue: { type: "array", items: actionReservationResponseSchema },
  },
} as const;

const battleResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "completionReason", "completedTurn"],
  properties: {
    outcome: { type: "string", enum: ["ALLY_WIN", "ALLY_LOSE"] },
    completionReason: {
      type: "string",
      enum: ["ENEMY_DEFEATED", "ALLY_DEFEATED", "SIMULTANEOUS_DEFEAT", "TURN_LIMIT_REACHED"],
    },
    completedTurn: { type: "integer", minimum: 1, maximum: 99 },
  },
} as const;

/**
 * `10_API設計.md`「BattleStateDeltaResponse」の`EntityCollectionDelta`。
 * `subUnits`/`effects`/`cooldowns`のM5〜M8実装まではResponse Mapperが
 * 値を設定することはないが、`additionalProperties: false`のv1契約が
 * 将来これらのフィールドを拒否しないよう先に定義しておく。
 */
const entityCollectionDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["added", "updated", "removed"],
  properties: {
    added: { type: "array", items: {} },
    updated: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "before", "after"],
        properties: { id: { type: "string" }, before: {}, after: {} },
      },
    },
    removed: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "before"],
        properties: { id: { type: "string" }, before: {} },
      },
    },
  },
} as const;

export const unitStateDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    combatStatus: valueChangeStringSchema,
    hp: valueChangeNumberSchema,
    // R-STA-04: HP上限（`MAXIMUM_HP` CombatStat）の差分。公開レスポンスはHP上限を
    // `combatStats`ではなく`hp.maximum`として持つため、差分も分けて運ぶ。
    hpMaximum: valueChangeNumberSchema,
    resources: {
      type: "object",
      additionalProperties: false,
      properties: {
        ap: valueChangeNumberSchema,
        pp: valueChangeNumberSchema,
        extraGauge: valueChangeNumberSchema,
      },
    },
    // G-09（M7-002A／Issue #255）: `resources.*.maximum`側の差分（`ResourceCapacityChanged`）。
    resourceMaximums: {
      type: "object",
      additionalProperties: false,
      properties: {
        ap: valueChangeNumberSchema,
        pp: valueChangeNumberSchema,
        extraGauge: valueChangeNumberSchema,
      },
    },
    // `BattleUnitStateResponse.combatStats`と同じキー集合だけを許す。`maximumHp`は
    // `CombatStatsResponse`に無く`hpMaximum`が運ぶため、ここへ紛れ込ませない
    // （`additionalProperties`を開けていると、適用先の無いキーを黙って通してしまう）。
    combatStats: {
      type: "object",
      additionalProperties: false,
      properties: {
        attack: valueChangeNumberSchema,
        defense: valueChangeNumberSchema,
        criticalRate: valueChangeNumberSchema,
        actionSpeed: valueChangeNumberSchema,
        affinityBonus: valueChangeNumberSchema,
        criticalDamageBonus: valueChangeNumberSchema,
      },
    },
    shields: { type: "object", additionalProperties: valueChangeNumberSchema },
    subUnits: entityCollectionDeltaResponseSchema,
    effects: entityCollectionDeltaResponseSchema,
    markers: entityCollectionDeltaResponseSchema,
    cooldowns: entityCollectionDeltaResponseSchema,
    charge: {
      type: "object",
      additionalProperties: false,
      required: ["before", "after"],
      properties: { before: {}, after: {} },
    },
  },
} as const;

export const battleStateDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    battle: {
      type: "object",
      additionalProperties: false,
      properties: {
        battleStatus: valueChangeStringSchema,
        turnNumber: valueChangeNumberSchema,
        cycleNumber: valueChangeNumberSchema,
      },
    },
    units: { type: "object", additionalProperties: unitStateDeltaResponseSchema },
    actionQueue: {
      type: "object",
      additionalProperties: false,
      required: ["before", "after"],
      properties: {
        before: { type: "array", items: actionReservationResponseSchema },
        after: { type: "array", items: actionReservationResponseSchema },
      },
    },
  },
} as const;

export const stateTransitionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["causedBySequence", "stateVersionBefore", "stateVersionAfter", "delta"],
  properties: {
    causedBySequence: { type: "integer", minimum: 1 },
    stateVersionBefore: { type: "integer", minimum: 0 },
    stateVersionAfter: { type: "integer", minimum: 0 },
    delta: battleStateDeltaResponseSchema,
  },
} as const;

/**
 * `10_API設計.md`「UnitBattleSummaryResponse」。両エンドポイントが同じ形で返すため
 * ここに置き、演習側schemaはこれを参照する。
 *
 * `finalHp`/`maximumHp`は`BattleUnitStateResponse.hp`と同じ値であり、同じ型で返す
 * （「HPの`current`と`maximum`は0以上の有限numberとし、戦闘中ステータス計算の
 * 途中値を丸めない」）。ここだけ`integer`へ絞ると、端数を持つHPでレスポンスの
 * serializeが落ちて`500`になる。
 *
 * 集計量（`damageDealt`/`damageTaken`/`healingDone`）は、集計元の
 * `DAMAGE_APPLIED.details.hitPointDamage`／`discardedDamage`・
 * `HEAL_APPLIED.details.appliedAmount`が既に公開契約上`integer`であるため
 * （`battle-log-schema.ts`）同じ型で返す。
 */
export const unitBattleSummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "battleUnitId",
    "side",
    "damageDealt",
    "damageTaken",
    "healingDone",
    "finalHp",
    "maximumHp",
    "combatStatus",
  ],
  properties: {
    battleUnitId: { type: "string" },
    side: { type: "string", enum: ["ALLY", "ENEMY"] },
    damageDealt: { type: "integer", minimum: 0 },
    damageTaken: { type: "integer", minimum: 0 },
    healingDone: { type: "integer", minimum: 0 },
    finalHp: { type: "number", minimum: 0 },
    maximumHp: { type: "number", minimum: 0 },
    combatStatus: { type: "string", enum: ["ACTIVE", "DEFEATED"] },
  },
} as const;

/** `200 OK`成功レスポンスbody schema（`BattleSimulationResponse`）。 */
export const battleSimulationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "battleId",
    "catalogRevision",
    "result",
    "initialState",
    "unitSummaries",
    "events",
    "stateTransitions",
  ],
  properties: {
    schemaVersion: { type: "integer" },
    battleId: { type: "string" },
    catalogRevision: { type: "string" },
    result: battleResultResponseSchema,
    initialState: battleStateResponseSchema,
    finalState: battleStateResponseSchema,
    unitSummaries: { type: "array", items: unitBattleSummaryResponseSchema },
    events: { type: "array", items: battleLogEventResponseSchema },
    stateTransitions: { type: "array", items: stateTransitionResponseSchema },
  },
} as const;

/**
 * OpenAPI公開専用の`200`成功レスポンスschema。実行時の
 * `battleSimulationResponseSchema`と唯一違うのは`events[].details`
 * （`battleLogEventDetailsDocSchema`でイベント種別ごとの構造を文書化する）。
 * `build-server.ts`の`transform`でこのルートの公開文書だけ差し替える。
 */
export const battleSimulationResponseDocSchema = {
  ...battleSimulationResponseSchema,
  properties: {
    ...battleSimulationResponseSchema.properties,
    events: { type: "array", items: battleLogEventResponseDocSchema },
  },
} as const;
