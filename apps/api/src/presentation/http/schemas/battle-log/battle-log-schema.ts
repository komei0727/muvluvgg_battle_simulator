export const battleLogEventResponseSchema = {
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
 * `08_ドメインイベント.md`の`BattleDomainEventPayloadMap`（M3の19種別に、M5
 * （`13_実装計画.md`「M5 行動ライフサイクル」）が追加する`ActionWaited`/
 * `ActionReservationRemoved`/`ActionQueueReordered`/`CooldownStarted`/
 * `CooldownReduced`/`CooldownCompleted`/`ChargeStarted`/`ChargeReleased`の
 * 8種別を加えた27種別）を外部`details`形へ写した、OpenAPI公開専用のschema群。
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
  required: [
    "skillDefinitionId",
    "skillType",
    "actorUnitId",
    "targetUnitIds",
    "costResource",
    "costAmount",
  ],
  properties: {
    skillDefinitionId: { type: "string" },
    /**
     * Issue #144 follow-up: `EVENT_PAYLOAD field: "skillType"`をこのeventType
     * へ条件付けるproduction Catalog行（SKL_SUIRAN_CHAOS_PS3等）のため、
     * `SkillUseCompleted`（Issue #143）と同じ理由で追加した。`SkillUseStarting`
     * はAS/EXの使用開始時にのみ発行される（PSはこのeventTypeを発行しない）。
     */
    skillType: { type: "string", enum: ["AS", "EX"] },
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
  required: ["skillDefinitionId", "skillType", "resolvedStepCount", "targetUnitIds"],
  properties: {
    skillDefinitionId: { type: "string" },
    /** Issue #143: `SkillUseCompleted`はAS/EXの使用完了時にのみ発行される（PSはこのeventTypeを発行しない）。 */
    skillType: { type: "string", enum: ["AS", "EX"] },
    resolvedStepCount: { type: "integer", minimum: 0 },
    targetUnitIds: { type: "array", items: { type: "string" } },
  },
} as const;

const EFFECT_STEP_KIND_ENUM = ["ACTION", "BRANCH", "RANDOM_BRANCH", "REPEAT"] as const;
const CONDITION_KIND_ENUM = [
  "TRUE",
  "AND",
  "OR",
  "NOT",
  "TARGET_STATE",
  "TARGET_HAS_MARKER",
  "EVENT_PAYLOAD",
  "LAST_RESULT",
  "RUNTIME_COUNTER",
  "TURN_NUMBER",
  "ALIVE_UNIT_COUNT",
] as const;
const EFFECT_ACTION_KIND_ENUM = [
  "DAMAGE",
  "HEAL",
  "APPLY_CONTINUOUS_HEAL",
  "APPLY_CONTINUOUS_DAMAGE",
  "APPLY_STAT_MOD",
  "APPLY_DAMAGE_MOD",
  "APPLY_HEALING_MOD",
  "MODIFY_RESOURCE",
  "MODIFY_RESOURCE_CAPACITY",
  "APPLY_STATUS",
  "APPLY_SHIELD",
  "REMOVE_EFFECTS",
  "EFFECT_IMMUNITY",
  "APPLY_MARKER",
  "REMOVE_MARKER",
  "APPLY_DEATH_SURVIVAL",
  "APPLY_TARGET_REDIRECT",
  "APPLY_COVER",
  "APPLY_REFLECT",
  "APPLY_SUBUNIT",
  "COOLDOWN_MANIPULATION",
] as const;
const EFFECT_ACTION_RESULT_KIND_ENUM = [
  "APPLIED",
  "SKIPPED",
  "MISSED",
  "REJECTED",
  "INTERRUPTED",
] as const;

const effectStepStartingDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stepIndex", "stepKind", "conditionKind"],
  properties: {
    stepIndex: { type: "integer", minimum: 0 },
    stepKind: { type: "string", enum: EFFECT_STEP_KIND_ENUM },
    conditionKind: { type: "string", enum: CONDITION_KIND_ENUM },
  },
} as const;

const effectStepSkippedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stepIndex", "conditionKind", "result"],
  properties: {
    stepIndex: { type: "integer", minimum: 0 },
    conditionKind: { type: "string", enum: CONDITION_KIND_ENUM },
    result: { type: "boolean", enum: [false] },
  },
} as const;

const effectStepCompletedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stepIndex", "resolvedActionCount"],
  properties: {
    stepIndex: { type: "integer", minimum: 0 },
    resolvedActionCount: { type: "integer", minimum: 0 },
  },
} as const;

const effectActionStartingDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectActionDefinitionId", "kind", "targetUnitIds"],
  properties: {
    effectActionDefinitionId: { type: "string" },
    kind: { type: "string", enum: EFFECT_ACTION_KIND_ENUM },
    targetUnitIds: { type: "array", items: { type: "string" } },
  },
} as const;

const effectActionCompletedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectActionDefinitionId", "effectActionKind", "targetUnitIds", "resultKind"],
  properties: {
    effectActionDefinitionId: { type: "string" },
    effectActionKind: { type: "string", enum: EFFECT_ACTION_KIND_ENUM },
    targetUnitIds: { type: "array", items: { type: "string" } },
    resultKind: { type: "string", enum: EFFECT_ACTION_RESULT_KIND_ENUM },
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

const COOLDOWN_UNIT_ENUM = ["ACTION", "TURN"] as const;

const cooldownStartedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "unit", "initialRemaining"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    unit: { type: "string", enum: COOLDOWN_UNIT_ENUM },
    initialRemaining: { type: "integer", minimum: 1 },
  },
} as const;

const cooldownReducedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "unit", "before", "after"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    unit: { type: "string", enum: COOLDOWN_UNIT_ENUM },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
  },
} as const;

const cooldownCompletedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "unit"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    unit: { type: "string", enum: COOLDOWN_UNIT_ENUM },
  },
} as const;

const chargeStartedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "startedActionId"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    startedActionId: { type: "string" },
  },
} as const;

const chargeReleasedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "chargeStartActionId", "releaseActionId"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    chargeStartActionId: { type: "string" },
    releaseActionId: { type: "string" },
  },
} as const;

const actionOrderEntryDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "actionSpeed"],
  properties: {
    battleUnitId: { type: "string" },
    actionSpeed: { type: "number" },
  },
} as const;

/** R-ORD-04: `ActionQueueReordered`。未実装で欠落していた(EVENT_DETAILS_SCHEMA_BY_TYPEレビュー指摘に付随して発見)。 */
const actionQueueReorderedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["before", "after"],
  properties: {
    before: { type: "array", items: actionOrderEntryDetailsSchema },
    after: { type: "array", items: actionOrderEntryDetailsSchema },
  },
} as const;

const RESOURCE_CHANGE_REASON_ENUM = [
  "SKILL_COST",
  "WAIT_COST",
  "EX_GAIN",
  "EFFECT_ACTION",
  "TURN_RECOVERY",
] as const;

const resourceChangedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "resource", "before", "after", "delta", "reason", "causeEventId"],
  properties: {
    battleUnitId: { type: "string" },
    resource: { type: "string", enum: RESOURCE_KIND_ENUM },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
    delta: { type: "integer" },
    reason: { type: "string", enum: RESOURCE_CHANGE_REASON_ENUM },
    causeEventId: { type: "string" },
  },
} as const;

const passivePointConsumedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "before", "after", "consumedAmount"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
    consumedAmount: { type: "integer", minimum: 0 },
  },
} as const;

const extraGaugeIncreasedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "causeResource", "before", "after", "increasedAmount"],
  properties: {
    battleUnitId: { type: "string" },
    causeResource: { type: "string", enum: ["AP", "PP"] },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
    increasedAmount: { type: "integer", minimum: 0 },
  },
} as const;

const extraGaugeOverflowDiscardedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "requestedAmount", "actualAmount", "discardedAmount"],
  properties: {
    battleUnitId: { type: "string" },
    requestedAmount: { type: "integer", minimum: 0 },
    actualAmount: { type: "integer", minimum: 0 },
    discardedAmount: { type: "integer", minimum: 0 },
  },
} as const;

const passiveActivatedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actorUnitId",
    "skillDefinitionId",
    "ppBefore",
    "ppAfter",
    "exBefore",
    "exAfter",
    "triggerEventId",
  ],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    ppBefore: { type: "integer", minimum: 0 },
    ppAfter: { type: "integer", minimum: 0 },
    exBefore: { type: "integer", minimum: 0 },
    exAfter: { type: "integer", minimum: 0 },
    triggerEventId: { type: "string" },
  },
} as const;

const passiveResolvedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "resolvedStepCount"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    resolvedStepCount: { type: "integer", minimum: 0 },
  },
} as const;

const passiveInterruptedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "reason", "unresolvedEffectCount"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    reason: { type: "string", enum: ["OWNER_DEFEATED"] },
    unresolvedEffectCount: { type: "integer", minimum: 0 },
  },
} as const;

const skillUseInterruptedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actorUnitId",
    "skillDefinitionId",
    "reason",
    "resolvedEffectCount",
    "unresolvedEffectCount",
  ],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    reason: { type: "string", enum: ["ACTOR_DEFEATED"] },
    resolvedEffectCount: { type: "integer", minimum: 0 },
    unresolvedEffectCount: { type: "integer", minimum: 0 },
  },
} as const;

const RUNTIME_COUNTER_SCOPE_ENUM = ["BATTLE", "BATTLE_UNIT", "SKILL_RUNTIME"] as const;

/**
 * `RuntimeCounterChanged`（M6最小実装、Issue #143）。`carry`は観測用の繰り越し
 * 端数。`valueChanged`（`before !== after`）は、carryのみの変化でもこの
 * イベント自体は発行される（追跡性のため）ことと区別するためのフィールド
 * （レビュー再々々レビュー[P1]、Issue #143）。
 */
const runtimeCounterChangedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "ownerUnitId",
    "scope",
    "counter",
    "skillDefinitionId",
    "before",
    "after",
    "carry",
    "valueChanged",
  ],
  properties: {
    ownerUnitId: { type: "string" },
    scope: { type: "string", enum: RUNTIME_COUNTER_SCOPE_ENUM },
    counter: { type: "string" },
    skillDefinitionId: { type: "string" },
    before: { type: "number" },
    after: { type: "number" },
    carry: { type: "number" },
    valueChanged: { type: "boolean" },
  },
} as const;

/** `RuntimeCounterReset`（M6最小実装、Issue #143）。解決スコープ終了後にcounterを破棄した時。 */
const runtimeCounterResetDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ownerUnitId", "scope", "counter", "skillDefinitionId", "before"],
  properties: {
    ownerUnitId: { type: "string" },
    scope: { type: "string", enum: RUNTIME_COUNTER_SCOPE_ENUM },
    counter: { type: "string" },
    skillDefinitionId: { type: "string" },
    before: { type: "number" },
  },
} as const;

const DURATION_TIME_UNIT_ENUM = ["ACTION", "TURN", "BATTLE", "HIT", "SKILL_USE"] as const;
const DURATION_OWNER_ENUM = ["EFFECT_TARGET", "EFFECT_SOURCE", "BATTLE"] as const;
const CONSUMPTION_KIND_ENUM = [
  "NEXT_OUTGOING_ATTACK",
  "NEXT_INCOMING_ATTACK",
  "INCOMING_HIT",
  "OUTGOING_HIT",
  "STATUS_BLOCKED",
  "LETHAL_DAMAGE",
] as const;

const COMPARISON_OPERATOR_ENUM = ["GT", "GTE", "LT", "LTE", "EQ", "NEQ", "IN", "CONTAINS"] as const;
const jsonPrimitiveSchema = { type: ["string", "number", "boolean"] } as const;
/**
 * `references.ts`の`createTargetReference`と1:1対応する制約（PR #207再レビュー
 * [P2]）: `BINDING`は`targetBindingId`必須、それ以外のkindは同fieldを禁止する
 * （ドメイン側「must not be set when kind is ... (only valid when kind is
 * BINDING)」）。`targetBindingId`を常にoptionalとする単一schemaでは、
 * ドメインが拒否する組み合わせ（例: `SELF`に`targetBindingId`を付与）も
 * 有効と判定してしまうため、`oneOf`でBINDING形と非BINDING形を分ける。
 */
const targetReferenceDetailsSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "targetBindingId"],
      properties: {
        kind: { const: "BINDING" },
        targetBindingId: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: [
            "SELF",
            "TRIGGER_SOURCE",
            "TRIGGER_TARGET",
            "LAST_ACTION_TARGETS",
            "LAST_DAMAGED_TARGETS",
          ],
        },
      },
    },
  ],
} as const;

/**
 * `condition-definition.ts`の`ConditionDefinition`と1:1対応するOpenAPI schema
 * （PR #207レビュー[P2]: `{ type: "object" }`のような任意許容ではなく、
 * `kind`を判別子にした実際の構造を検証する）。`AND`/`OR`/`NOT`は自身を再帰的に
 * 参照するため、`$id`を持つ独立schemaとして定義し`$ref`で自己参照する
 * （fastify/@fastify/swaggerを含むこのリポジトリで初めての`$id`/`$ref`使用 —
 * `ConditionDefinition`が唯一循環構造を持つCatalog型のため）。AJVは
 * `ajv.compile()`実行時にschemaツリー内の`$id`を自動的に索引するため、
 * 個別の`addSchema`登録は不要。
 */
export const CONDITION_DEFINITION_SCHEMA_ID =
  "https://muvluvgg-battle-simulator/schemas/ConditionDefinition";
export const conditionDefinitionDetailsSchema = {
  $id: CONDITION_DEFINITION_SCHEMA_ID,
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "TRUE" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "conditions"],
      properties: {
        kind: { const: "AND" },
        conditions: {
          type: "array",
          minItems: 1,
          items: { $ref: CONDITION_DEFINITION_SCHEMA_ID },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "conditions"],
      properties: {
        kind: { const: "OR" },
        conditions: {
          type: "array",
          minItems: 1,
          items: { $ref: CONDITION_DEFINITION_SCHEMA_ID },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "condition"],
      properties: {
        kind: { const: "NOT" },
        condition: { $ref: CONDITION_DEFINITION_SCHEMA_ID },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "field", "op", "value"],
      properties: {
        kind: { const: "TARGET_STATE" },
        target: targetReferenceDetailsSchema,
        field: {
          type: "string",
          enum: [
            "IS_ALIVE",
            "HP_RATIO",
            "ATTRIBUTE",
            "UNIT_TYPE",
            "ROLE",
            "POSITION_ROW",
            "POSITION_COLUMN",
            "HAS_STATUS",
            "RESOURCE_AP",
            "RESOURCE_PP",
            "RESOURCE_EX_GAUGE",
          ],
        },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: jsonPrimitiveSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "markerId"],
      properties: {
        kind: { const: "TARGET_HAS_MARKER" },
        target: targetReferenceDetailsSchema,
        markerId: { type: "string" },
        countCondition: {
          type: "object",
          additionalProperties: false,
          required: ["op", "value"],
          properties: {
            op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
            value: { type: "number" },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "field", "op", "value"],
      properties: {
        kind: { const: "EVENT_PAYLOAD" },
        field: { type: "string" },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: jsonPrimitiveSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "field", "op", "value"],
      properties: {
        kind: { const: "LAST_RESULT" },
        field: { type: "string" },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: jsonPrimitiveSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "counter", "op", "value"],
      properties: {
        kind: { const: "RUNTIME_COUNTER" },
        counter: { type: "string" },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: { type: "number" },
        modulo: { type: "number" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "op", "value"],
      properties: {
        kind: { const: "TURN_NUMBER" },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: { type: "number" },
        modulo: { type: "number" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "side", "excludeSelf", "op", "value"],
      properties: {
        kind: { const: "ALIVE_UNIT_COUNT" },
        side: { type: "string", enum: ["ALLY", "ENEMY", "ALL"] },
        excludeSelf: { type: "boolean" },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: { type: "number" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "relation"],
      properties: {
        kind: { const: "POSITION_RELATION" },
        target: targetReferenceDetailsSchema,
        relation: { type: "string", enum: ["IN_FRONT_OF"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "phase", "negate"],
      properties: {
        kind: { const: "RESOLUTION_PHASE" },
        phase: { type: "string", enum: ["BATTLE_START", "TURN_START", "TURN_END"] },
        negate: { type: "boolean" },
      },
    },
  ],
} as const;

/**
 * `EffectApplied`（R-EFF-01）。新しい効果インスタンス追加後に発行する。
 * `durationUnit`/`initialRemaining`は`timeLimit`を持つ場合、`consumptionKind`/
 * `consumptionMaxCount`は`consumption`を持つ場合だけ存在する。
 */
const effectAppliedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "effectActionDefinitionId",
    "sourceUnitId",
    "targetUnitId",
    "duplicate",
    "kindKey",
    "magnitude",
    "linkedEffectGroupId",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    targetUnitId: { type: "string" },
    duplicate: { type: "boolean" },
    kindKey: { type: "string" },
    magnitude: { type: "number" },
    durationUnit: { type: "string", enum: DURATION_TIME_UNIT_ENUM },
    durationOwner: { type: "string", enum: DURATION_OWNER_ENUM },
    initialRemaining: { type: "integer", minimum: 1 },
    remainingCount: { type: "integer", minimum: 0 },
    consumptionKind: { type: "string", enum: CONSUMPTION_KIND_ENUM },
    consumptionMaxCount: { type: "integer", minimum: 1 },
    consumptionRemaining: { type: "integer", minimum: 0 },
    expirationConditions: { type: "array", items: conditionDefinitionDetailsSchema },
    linkedEffectGroupId: { type: ["string", "null"] },
    grantedActionId: { type: "string" },
    grantedTurnNumber: { type: "integer", minimum: 1 },
    snapshot: { type: "object", additionalProperties: { type: "number" } },
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
  ACTION_QUEUE_REORDERED: actionQueueReorderedDetailsSchema,
  ACTION_STARTED: actionStartedDetailsSchema,
  ACTION_WAITED: actionWaitedDetailsSchema,
  TARGETS_SELECTED: targetsSelectedDetailsSchema,
  SKILL_USE_STARTING: skillUseStartingDetailsSchema,
  SKILL_USE_STARTED: skillUseStartedDetailsSchema,
  SKILL_USE_COMPLETED: skillUseCompletedDetailsSchema,
  EFFECT_STEP_STARTING: effectStepStartingDetailsSchema,
  EFFECT_STEP_SKIPPED: effectStepSkippedDetailsSchema,
  EFFECT_STEP_COMPLETED: effectStepCompletedDetailsSchema,
  EFFECT_ACTION_STARTING: effectActionStartingDetailsSchema,
  EFFECT_ACTION_COMPLETED: effectActionCompletedDetailsSchema,
  HIT_CONFIRMED: hitConfirmedDetailsSchema,
  CRITICAL_CHECK_RESOLVED: criticalCheckResolvedDetailsSchema,
  DAMAGE_CALCULATED: damageCalculatedDetailsSchema,
  DAMAGE_APPLIED: damageAppliedDetailsSchema,
  UNIT_DEFEATED: unitDefeatedDetailsSchema,
  ACTION_COMPLETING: actorEffectiveActionDetailsSchema,
  ACTION_COMPLETED: actorEffectiveActionDetailsSchema,
  COOLDOWN_STARTED: cooldownStartedDetailsSchema,
  COOLDOWN_REDUCED: cooldownReducedDetailsSchema,
  COOLDOWN_COMPLETED: cooldownCompletedDetailsSchema,
  CHARGE_STARTED: chargeStartedDetailsSchema,
  CHARGE_RELEASED: chargeReleasedDetailsSchema,
  TURN_COMPLETING: turnNumberOnlyDetailsSchema,
  TURN_COMPLETED: turnNumberOnlyDetailsSchema,
  BATTLE_COMPLETED: battleCompletedDetailsSchema,
  RESOURCE_CHANGED: resourceChangedDetailsSchema,
  PASSIVE_POINT_CONSUMED: passivePointConsumedDetailsSchema,
  EXTRA_GAUGE_INCREASED: extraGaugeIncreasedDetailsSchema,
  EXTRA_GAUGE_OVERFLOW_DISCARDED: extraGaugeOverflowDiscardedDetailsSchema,
  PASSIVE_ACTIVATED: passiveActivatedDetailsSchema,
  PASSIVE_RESOLVED: passiveResolvedDetailsSchema,
  PASSIVE_INTERRUPTED: passiveInterruptedDetailsSchema,
  SKILL_USE_INTERRUPTED: skillUseInterruptedDetailsSchema,
  RUNTIME_COUNTER_CHANGED: runtimeCounterChangedDetailsSchema,
  RUNTIME_COUNTER_RESET: runtimeCounterResetDetailsSchema,
  EFFECT_APPLIED: effectAppliedDetailsSchema,
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
