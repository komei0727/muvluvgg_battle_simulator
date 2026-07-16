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

const formationUnitRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitDefinitionId", "position"],
  properties: {
    unitDefinitionId: { type: "string", minLength: 1, maxLength: 256 },
    position: formationPositionRequestSchema,
  },
} as const;

const formationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units", "memoryDefinitionIds"],
  properties: {
    units: { type: "array", items: formationUnitRequestSchema },
    memoryDefinitionIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
  },
} as const;

const simulationOptionsRequestSchema = {
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

const formationUnitRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitDefinitionId", "position"],
  properties: {
    unitDefinitionId: { type: "string", minLength: 1, maxLength: 256 },
    position: formationPositionRequestDocSchema,
  },
} as const;

const formationRequestDocSchema = {
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
  },
} as const;

const simulationOptionsRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    logLevel: { type: "string", enum: ["SUMMARY", "DETAILED", "DIAGNOSTIC"] },
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

const valueChangeNumberSchema = {
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

const formationPositionResponseSchema = {
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

const combatStatsResponseSchema = {
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
const effectStateResponseSchema = {
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
    category: { type: "string", enum: ["BUFF", "DEBUFF", "STATUS_ABNORMALITY"] },
    effectKindKey: { type: "string" },
    stackMode: { type: "string", enum: ["STACKABLE", "NON_STACKING"] },
    isEffective: { type: "boolean" },
    value: {},
    duration: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "remaining"],
      properties: {
        unit: { type: "string", enum: ["ACTION", "TURN"] },
        remaining: { type: "integer", minimum: 0 },
      },
    },
    appliedTurnNumber: { type: "integer", minimum: 0 },
    appliedActionId: { type: "string" },
  },
} as const;

/** `10_API設計.md`「CooldownStateResponse」。 */
const cooldownStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "unit", "remaining", "setAtTurnNumber"],
  properties: {
    skillDefinitionId: { type: "string" },
    unit: { type: "string", enum: ["ACTION", "TURN"] },
    remaining: { type: "integer", minimum: 0 },
    setAtActionId: { type: "string" },
    setAtTurnNumber: { type: "integer", minimum: 0 },
  },
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

const battleStateResponseSchema = {
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

const battleLogEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sequence",
    "type",
    "category",
    "turnNumber",
    "cycleNumber",
    "rootSequence",
    "targetUnitIds",
    "details",
    "stateVersionBefore",
    "stateVersionAfter",
  ],
  properties: {
    sequence: { type: "integer", minimum: 1 },
    type: { type: "string" },
    category: { type: "string", enum: ["FACT", "TIMING", "DIAGNOSTIC"] },
    turnNumber: { type: "integer", minimum: 0, maximum: 99 },
    cycleNumber: { type: "integer", minimum: 0 },
    actionId: { type: "string" },
    skillUseId: { type: "string" },
    parentSequence: { type: "integer", minimum: 1 },
    rootSequence: { type: "integer", minimum: 1 },
    sourceUnitId: { type: "string" },
    targetUnitIds: { type: "array", items: { type: "string" } },
    details: {},
    stateVersionBefore: { type: "integer", minimum: 0 },
    stateVersionAfter: { type: "integer", minimum: 0 },
    stateTransitionIndex: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * `08_ドメインイベント.md`の`BattleDomainEventPayloadMap`（M3の19種別に
 * `ActionWaited`/`ActionReservationRemoved`（M5/issue #20）を加えた21種別）を
 * 外部`details`形へ写した、OpenAPI公開専用のschema群。
 * `type`（イベント種別）は`details`の兄弟プロパティであり、OpenAPI 3.0.3の
 * `discriminator`は対象schema内部のプロパティしか判別に使えないため、ここでは
 * `oneOf`ではなく`anyOf`で列挙する（`ActionCompleting`/`ActionCompleted`、
 * `TurnStarted`/`TurnCompleting`/`TurnCompleted`は構造上同一payloadを持ち、
 * `oneOf`だと「複数一致で失敗」になってしまうため）。
 *
 * 実行時の`route.schema.response`はこの詳細schemaを使わず`details: {}`の
 * ままにする（`build-server.ts`の`transform`で公開文書だけこちらへ差し替える）。
 * `details`は実データがそのまま流れる出力であり、モデル化を誤ると実際の
 * レスポンスを壊しかねないため、実行時の直列化を安全側（無制約）に保ったまま
 * 文書だけを正本へ近づける。
 */
const resourceRecoveryEntryDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "apBefore", "apAfter", "ppBefore", "ppAfter"],
  properties: {
    battleUnitId: { type: "string" },
    apBefore: { type: "integer", minimum: 0 },
    apAfter: { type: "integer", minimum: 0 },
    ppBefore: { type: "integer", minimum: 0 },
    ppAfter: { type: "integer", minimum: 0 },
  },
} as const;

const actionReservationEntryDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "reservedActionKind", "actionSpeed"],
  properties: {
    battleUnitId: { type: "string" },
    reservedActionKind: { type: "string", enum: ["AS", "EX"] },
    actionSpeed: { type: "number" },
  },
} as const;

const targetBindingSelectionDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetBindingId", "selectedTargetUnitIds"],
  properties: {
    targetBindingId: { type: "string" },
    selectedTargetUnitIds: { type: "array", items: { type: "string" } },
  },
} as const;

const EFFECTIVE_ACTION_TYPE_ENUM = ["AS", "EX", "WAIT", "CHARGE_RELEASE"] as const;

const battleStartedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["turnLimit", "allySlotCount", "enemySlotCount"],
  properties: {
    turnLimit: { type: "integer", minimum: 1, maximum: 99 },
    allySlotCount: { type: "integer", minimum: 1, maximum: 5 },
    enemySlotCount: { type: "integer", minimum: 1, maximum: 5 },
  },
} as const;

/** `TurnStarted`/`TurnCompleting`/`TurnCompleted`は同一payload形。 */
const turnNumberOnlyDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["turnNumber"],
  properties: { turnNumber: { type: "integer", minimum: 1, maximum: 99 } },
} as const;

const resourcesRecoveredDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: { units: { type: "array", items: resourceRecoveryEntryDetailsSchema } },
} as const;

const actionQueueCreatedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cycleNumber", "reservations"],
  properties: {
    cycleNumber: { type: "integer", minimum: 1 },
    reservations: { type: "array", items: actionReservationEntryDetailsSchema },
  },
} as const;

const actionReservationRemovedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "reason"],
  properties: {
    battleUnitId: { type: "string" },
    reason: { type: "string", enum: ["DEFEATED"] },
  },
} as const;

const actionStartedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actorUnitId",
    "reservedActionType",
    "effectiveActionType",
    "apBefore",
    "apAfter",
    "exBefore",
    "exAfter",
  ],
  properties: {
    actorUnitId: { type: "string" },
    reservedActionType: { type: "string", enum: ["AS", "EX"] },
    effectiveActionType: { type: "string", enum: EFFECTIVE_ACTION_TYPE_ENUM },
    apBefore: { type: "integer", minimum: 0 },
    apAfter: { type: "integer", minimum: 0 },
    exBefore: { type: "integer", minimum: 0 },
    exAfter: { type: "integer", minimum: 0 },
    waitReason: { type: "string" },
  },
} as const;

const actionWaitedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "waitReason", "consumedResource", "consumedAmount"],
  properties: {
    actorUnitId: { type: "string" },
    waitReason: { type: "string" },
    consumedResource: { type: "string", enum: ["AP", "PP", "EX_GAUGE"] },
    consumedAmount: { type: "integer", minimum: 0 },
  },
} as const;

const targetsSelectedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "bindings"],
  properties: {
    skillDefinitionId: { type: "string" },
    bindings: { type: "array", items: targetBindingSelectionDetailsSchema },
  },
} as const;

const RESOURCE_KIND_ENUM = ["AP", "PP", "EX_GAUGE"] as const;

const skillUseStartingDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "actorUnitId", "targetUnitIds", "costResource", "costAmount"],
  properties: {
    skillDefinitionId: { type: "string" },
    actorUnitId: { type: "string" },
    targetUnitIds: { type: "array", items: { type: "string" } },
    costResource: { type: "string", enum: RESOURCE_KIND_ENUM },
    costAmount: { type: "integer", minimum: 0 },
  },
} as const;

const skillUseStartedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "costResource", "costAmount"],
  properties: {
    skillDefinitionId: { type: "string" },
    costResource: { type: "string", enum: RESOURCE_KIND_ENUM },
    costAmount: { type: "integer", minimum: 0 },
  },
} as const;

const skillUseCompletedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "resolvedStepCount", "targetUnitIds"],
  properties: {
    skillDefinitionId: { type: "string" },
    resolvedStepCount: { type: "integer", minimum: 0 },
    targetUnitIds: { type: "array", items: { type: "string" } },
  },
} as const;

const hitConfirmedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "effectActionDefinitionId", "hitIndex", "targetUnitId"],
  properties: {
    skillDefinitionId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    targetUnitId: { type: "string" },
  },
} as const;

const criticalCheckResolvedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "baseCriticalRate", "effectiveCriticalRate", "result"],
  properties: {
    mode: { type: "string", enum: ["NORMAL", "GUARANTEED", "PREVENTED"] },
    // R-CRT-01: クランプ前の値のため0-100へは制限しない（`percentage.ts`）。
    baseCriticalRate: { type: "number" },
    effectiveCriticalRate: { type: "number" },
    result: { type: "boolean" },
  },
} as const;

const DAMAGE_TYPE_ENUM = ["PHYSICAL", "EN"] as const;

const damageCalculatedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "skillDefinitionId",
    "effectActionDefinitionId",
    "hitIndex",
    "targetUnitId",
    "attackerAttack",
    "defenderDefense",
    "effectiveDefense",
    "defenseIgnoreRate",
    "skillPower",
    "attributeMultiplier",
    "criticalMultiplier",
    "actionDamageMultiplier",
    "preTruncationDamage",
    "finalDamage",
    "damageType",
  ],
  properties: {
    skillDefinitionId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    targetUnitId: { type: "string" },
    attackerAttack: { type: "number" },
    defenderDefense: { type: "number" },
    effectiveDefense: { type: "number" },
    defenseIgnoreRate: { type: "number" },
    skillPower: { type: "number" },
    attributeMultiplier: { type: "number" },
    criticalMultiplier: { type: "number" },
    actionDamageMultiplier: { type: "number" },
    preTruncationDamage: { type: "number" },
    finalDamage: { type: "integer", minimum: 0 },
    damageType: { type: "string", enum: DAMAGE_TYPE_ENUM },
  },
} as const;

const damageAppliedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectActionDefinitionId",
    "hitIndex",
    "targetUnitId",
    "calculatedDamage",
    "hitPointDamage",
    "hpBefore",
    "hpAfter",
    "defeated",
  ],
  properties: {
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    targetUnitId: { type: "string" },
    calculatedDamage: { type: "integer", minimum: 0 },
    hitPointDamage: { type: "integer", minimum: 0 },
    hpBefore: { type: "integer", minimum: 0 },
    hpAfter: { type: "integer", minimum: 0 },
    defeated: { type: "boolean" },
  },
} as const;

const unitDefeatedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitId", "causeEventId"],
  properties: {
    unitId: { type: "string" },
    causeEventId: { type: "string" },
  },
} as const;

/** `ActionCompleting`/`ActionCompleted`は同一payload形。 */
const actorEffectiveActionDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "effectiveActionType"],
  properties: {
    actorUnitId: { type: "string" },
    effectiveActionType: { type: "string", enum: EFFECTIVE_ACTION_TYPE_ENUM },
  },
} as const;

const battleCompletedDetailsSchema = {
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
 * `type`（大文字スネークケースのイベント種別、`toUpperSnakeCase`の変換結果）
 * から、対応する`details`schemaへのlookup。`ActionCompleting`/
 * `ActionCompleted`、`TurnStarted`/`TurnCompleting`/`TurnCompleted`は
 * 構造上同一payloadだが、`type`ごとに別エントリを持つ（`oneOf`側で`type`を
 * `const`固定するための discriminator は`type`自身であり、`details`の形が
 * 同じでも判別に問題はない）。
 */
const EVENT_DETAILS_SCHEMA_BY_TYPE: Readonly<Record<string, object>> = {
  BATTLE_STARTED: battleStartedDetailsSchema,
  TURN_STARTED: turnNumberOnlyDetailsSchema,
  RESOURCES_RECOVERED: resourcesRecoveredDetailsSchema,
  ACTION_QUEUE_CREATED: actionQueueCreatedDetailsSchema,
  ACTION_RESERVATION_REMOVED: actionReservationRemovedDetailsSchema,
  ACTION_STARTED: actionStartedDetailsSchema,
  ACTION_WAITED: actionWaitedDetailsSchema,
  TARGETS_SELECTED: targetsSelectedDetailsSchema,
  SKILL_USE_STARTING: skillUseStartingDetailsSchema,
  SKILL_USE_STARTED: skillUseStartedDetailsSchema,
  SKILL_USE_COMPLETED: skillUseCompletedDetailsSchema,
  HIT_CONFIRMED: hitConfirmedDetailsSchema,
  CRITICAL_CHECK_RESOLVED: criticalCheckResolvedDetailsSchema,
  DAMAGE_CALCULATED: damageCalculatedDetailsSchema,
  DAMAGE_APPLIED: damageAppliedDetailsSchema,
  UNIT_DEFEATED: unitDefeatedDetailsSchema,
  ACTION_COMPLETING: actorEffectiveActionDetailsSchema,
  ACTION_COMPLETED: actorEffectiveActionDetailsSchema,
  TURN_COMPLETING: turnNumberOnlyDetailsSchema,
  TURN_COMPLETED: turnNumberOnlyDetailsSchema,
  BATTLE_COMPLETED: battleCompletedDetailsSchema,
} as const;

/**
 * `events[].type`と`details`の対応をOpenAPI公開文書へ固定する。`details`だけを
 * `anyOf`で列挙すると、`type`とは無関係にどれか一つの形へ一致すればよくなり、
 * 実際には存在しない組み合わせ（例: `type: "DAMAGE_APPLIED"`に
 * `TurnStarted`の`details`）を検証が通してしまう。ここではイベント全体
 * （`type`を`const`で固定した各variant）を`oneOf`にすることで、`type`と
 * `details`の組み合わせ自体を検証対象にする。各variantは`type`の値で
 * 一意に排他となるため（`details`の形が複数variant間で重複していても）、
 * `oneOf`が「複数一致で失敗」になることはない。
 */
export const battleLogEventResponseDocSchema = {
  oneOf: Object.entries(EVENT_DETAILS_SCHEMA_BY_TYPE).map(([type, detailsSchema]) => ({
    ...battleLogEventResponseSchema,
    properties: {
      ...battleLogEventResponseSchema.properties,
      type: { const: type },
      details: detailsSchema,
    },
  })),
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

const unitStateDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    combatStatus: valueChangeStringSchema,
    hp: valueChangeNumberSchema,
    resources: {
      type: "object",
      additionalProperties: false,
      properties: {
        ap: valueChangeNumberSchema,
        pp: valueChangeNumberSchema,
        extraGauge: valueChangeNumberSchema,
      },
    },
    combatStats: { type: "object", additionalProperties: valueChangeNumberSchema },
    shields: { type: "object", additionalProperties: valueChangeNumberSchema },
    subUnits: entityCollectionDeltaResponseSchema,
    effects: entityCollectionDeltaResponseSchema,
    cooldowns: entityCollectionDeltaResponseSchema,
    charge: {
      type: "object",
      additionalProperties: false,
      required: ["before", "after"],
      properties: { before: {}, after: {} },
    },
  },
} as const;

const battleStateDeltaResponseSchema = {
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

const stateTransitionResponseSchema = {
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
    "finalState",
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

/** `10_API設計.md`「CatalogUnitSummaryResponse」。`attribute`/`unitType`/`role`は将来値を許容するため`enum`を持たない。 */
const catalogUnitSummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "unitDefinitionId",
    "displayName",
    "characterName",
    "attribute",
    "unitType",
    "role",
    "positionAptitudes",
    "selectable",
    "unavailableCapabilities",
  ],
  properties: {
    unitDefinitionId: { type: "string" },
    displayName: { type: "string" },
    characterName: { type: "string" },
    attribute: { type: "string" },
    unitType: { type: "string" },
    role: { type: "string" },
    positionAptitudes: {
      type: "array",
      items: { type: "string", enum: ["FRONT", "BACK"] },
      minItems: 1,
    },
    selectable: { type: "boolean" },
    unavailableCapabilities: { type: "array", items: { type: "string" } },
  },
} as const;

/** `10_API設計.md`「CatalogMemorySummaryResponse」。 */
const catalogMemorySummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memoryDefinitionId", "displayName", "selectable", "unavailableCapabilities"],
  properties: {
    memoryDefinitionId: { type: "string" },
    displayName: { type: "string" },
    selectable: { type: "boolean" },
    unavailableCapabilities: { type: "array", items: { type: "string" } },
  },
} as const;

/** `GET /api/v1/battle-simulation-catalog`の`200 OK`成功レスポンスbody schema。 */
export const battleSimulationCatalogResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "catalogRevision", "units", "memories"],
  properties: {
    schemaVersion: { type: "integer" },
    catalogRevision: { type: "string" },
    units: { type: "array", items: catalogUnitSummaryResponseSchema },
    memories: { type: "array", items: catalogMemorySummaryResponseSchema },
  },
} as const;

const violationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    path: { type: "string" },
    definitionId: { type: "string" },
    ruleId: { type: "string" },
    message: { type: "string" },
  },
} as const;

/**
 * `11_インフラストラクチャ設計.md`「ヘルスレスポンスへCatalogの中身、環境変数、
 * エラーのスタックを含めない」ため、bodyは状態を示す1フィールドだけにする。
 * `12_テスト戦略.md`「全ルートと全ステータスにSchemaがある」を満たすため、
 * `/health/live`・`/health/ready`の各ステータスごとに個別のconst schemaを持つ。
 */
export const healthLiveResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "live" },
  },
} as const;

export const healthReadyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ready" },
  },
} as const;

export const healthNotReadyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "not_ready" },
  },
} as const;

/** エラーレスポンスbody schema（`ErrorResponse`）。全エラーステータスで共通。 */
export const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "error"],
  properties: {
    schemaVersion: { type: "integer" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "violations"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        violations: { type: "array", items: violationResponseSchema },
        diagnosticId: { type: "string" },
      },
    },
  },
} as const;
