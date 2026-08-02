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
    // `08_ドメインイベント.md`「Memory由来イベントは`sourceSide`を持ち、特定ユニットを
    // 発生源にしない」（M7-006、Issue #179）。
    sourceSide: { type: "string", enum: ["ALLY", "ENEMY"] },
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
    reason: { type: "string", enum: ["DEFEATED", "INELIGIBLE"] },
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
/** M7-002（Issue #185）: `MODIFY_RESOURCE(resource: HP)`（HP_DIRECT_COST）は`ResourceChanged.resource`に`HP`を持ちうる。スキルコスト（`costResource`）はAP/PP/EX_GAUGEのみのまま。 */
const RESOURCE_CHANGE_KIND_ENUM = ["AP", "PP", "EX_GAUGE", "HP"] as const;

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
  // Issue #230 PRレビュー[P2]: `stepCondition`（ACTIONの
  // CAP_EFFECT_STEP_SET_CONDITION、Issue #227）としてEffectStepStarting/
  // EffectStepSkippedの`conditionKind`に実際に現れうる。従来は
  // `runtimeStatus: PLANNED`（production定義なし）だったため、この
  // enumが実際にexerciseされたことがなく、抜けが検出されていなかった。
  "TARGET_SET_COUNT",
] as const;
const EFFECT_ACTION_KIND_ENUM = [
  "DAMAGE",
  "HEAL",
  "APPLY_CONTINUOUS_HEAL",
  "APPLY_CONTINUOUS_DAMAGE",
  "APPLY_STAT_MOD",
  "APPLY_DAMAGE_MOD",
  "APPLY_PIERCING_MOD",
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
  "APPLY_ATTACK_DAMAGE_BONUS",
  // M7-011（Issue #265）: `EffectApplied.effectKind`をこのenumで検証するように
  // なったため、`effect-action-definition.ts`の`EFFECT_ACTION_KINDS`に対して
  // 欠けていた2種（M7-005-HEAL-LINK／Issue #229、M7-002／Issue #185で実装済み）
  // を補う。欠けたままではHEALING_LINK等の実付与がschema検証で落ちる。
  "APPLY_HEALING_LINK",
  "APPLY_RESOURCE_GAIN_MOD",
] as const;
/**
 * `EffectApplied.categories`（M7-011、Issue #265）。`catalog-enums.ts`の
 * `EffectImmunityCategory`（`REMOVE_EFFECTS`/`EFFECT_IMMUNITY`と共有する分類軸）
 * と同じ値集合。`effect-category-classifier.ts`は`SPECIFIC_EFFECT`を返さないが、
 * 分類軸そのものの列挙としては同一の集合を公開する。
 */
const EFFECT_CATEGORY_ENUM = [
  "BUFF",
  "DEBUFF",
  "STATUS",
  "MARKER",
  "DAMAGE_MOD",
  "SHIELD",
  "SUBUNIT",
  "SPECIFIC_EFFECT",
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

const RANDOM_BRANCH_MODE_ENUM = ["WEIGHTED_ONE", "INDEPENDENT"] as const;

/** R-SKL-07（RES-003、Issue #173/#217）: `RandomBranchSelected`。 */
const randomBranchSelectedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stepIndex", "mode", "branchIndex"],
  properties: {
    stepIndex: { type: "integer", minimum: 0 },
    mode: { type: "string", enum: RANDOM_BRANCH_MODE_ENUM },
    branchIndex: { type: "integer", minimum: 0 },
    label: { type: "string" },
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

/** `UnitBeingAttacked`（R-EFF-07、EFF-003）。攻撃対象が確定した直後、命中判定より前に発行する。 */
const unitBeingAttackedDetailsSchema = {
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

/** `EvasionActivated`（R-HIT-02、Issue #183）。特別な回避効果が成功した後、命中判定に相当する位置で発行する。 */
const evasionActivatedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectActionDefinitionId", "effectInstanceId", "hitIndex", "targetUnitId"],
  properties: {
    effectActionDefinitionId: { type: "string" },
    effectInstanceId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    targetUnitId: { type: "string" },
  },
} as const;

/** `BlindnessCheckResolved`（R-HIT-03、Issue #183）。暗闇1件ごとのMISS判定結果。 */
const blindnessCheckResolvedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectActionDefinitionId", "effectInstanceId", "probability", "missed"],
  properties: {
    effectActionDefinitionId: { type: "string" },
    effectInstanceId: { type: "string" },
    probability: { type: "number" },
    missed: { type: "boolean" },
  },
} as const;

/** `SkillMissed`（R-HIT-03、Issue #183）。暗闇判定でスキル全体がMISSになった時。 */
const skillMissedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "missedByEffectInstanceIds"],
  properties: {
    skillDefinitionId: { type: "string" },
    missedByEffectInstanceIds: { type: "array", items: { type: "string" } },
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

/**
 * `DamageWillBeApplied`（R-DMG-05 #4、DMG-001／Issue #195）。命中・会心の確定後、
 * ダメージ計算より前に発行する`TIMING`イベント。R-DMG-04の集計済みDamageModifier
 * 倍率（`outgoingDamageMultiplier`/`incomingDamageMultiplier`）は`DMG-002`
 * （Issue #192）が追加した発行時点のsnapshotで、確定値は`DamageCalculated`が持つ。
 */
const damageWillBeAppliedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "skillDefinitionId",
    "effectActionDefinitionId",
    "hitIndex",
    "targetUnitId",
    "damageType",
    "isCritical",
    "criticalMultiplier",
    "defenseIgnoreRate",
    "shieldIgnoreRate",
    "damageReductionIgnoreRate",
    "outgoingDamageMultiplier",
    "incomingDamageMultiplier",
  ],
  properties: {
    skillDefinitionId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    targetUnitId: { type: "string" },
    damageType: { type: "string", enum: DAMAGE_TYPE_ENUM },
    isCritical: { type: "boolean" },
    criticalMultiplier: { type: "number" },
    defenseIgnoreRate: { type: "number" },
    shieldIgnoreRate: { type: "number" },
    damageReductionIgnoreRate: { type: "number" },
    outgoingDamageMultiplier: { type: "number" },
    incomingDamageMultiplier: { type: "number" },
  },
} as const;

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
    "shieldIgnoreRate",
    "damageReductionIgnoreRate",
    "skillPower",
    "attributeMultiplier",
    "criticalMultiplier",
    "outgoingDamageMultiplier",
    "incomingDamageMultiplier",
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
    shieldIgnoreRate: { type: "number" },
    damageReductionIgnoreRate: { type: "number" },
    skillPower: { type: "number" },
    attributeMultiplier: { type: "number" },
    criticalMultiplier: { type: "number" },
    outgoingDamageMultiplier: { type: "number" },
    incomingDamageMultiplier: { type: "number" },
    actionDamageMultiplier: { type: "number" },
    preTruncationDamage: { type: "number" },
    finalDamage: { type: "integer", minimum: 0 },
    damageType: { type: "string", enum: DAMAGE_TYPE_ENUM },
  },
} as const;

/**
 * `ShieldConsumed`（DMG-004、Issue #194、R-SHD-01〜03）。シールド値を減らした直後に、
 * 減らしたプール単位で発行する。`reason: DAMAGE_ABSORPTION`（R-SHD-02のダメージ吸収）
 * だけが`effectActionDefinitionId`/`hitIndex`を持ち、`DECAY`
 * （`SHIELD_DECAY_OVER_TIME`の行動ごとの漸減）は特定のヒットに属さないため持たない。
 * `shieldType`の`null`はタイプなしシールドプールを表す。
 */
const shieldConsumedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "reason", "shieldType", "before", "after", "absorbed"],
  properties: {
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    battleUnitId: { type: "string" },
    reason: {
      type: "string",
      enum: ["DAMAGE_ABSORPTION", "CONTINUOUS_DAMAGE_ABSORPTION", "DECAY"],
    },
    shieldType: { type: ["string", "null"], enum: [...DAMAGE_TYPE_ENUM, null] },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
    absorbed: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * `SubUnitDamaged`（DMG-005、Issue #190、R-SUB-01）。サブユニットの耐久力を減らした
 * 直後に、減らした**インスタンス単位**で発行する（`ShieldConsumed`のプール単位とは
 * 異なる — R-SUB-01第3項「内部状態は通常シールドと分ける」）。`reason:
 * DAMAGE_ABSORPTION`だけが`effectActionDefinitionId`/`hitIndex`を持つ。
 */
const subUnitDamagedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "battleUnitId",
    "effectInstanceId",
    "subUnitDefinitionId",
    "reason",
    "before",
    "after",
    "absorbed",
  ],
  properties: {
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    battleUnitId: { type: "string" },
    effectInstanceId: { type: "string" },
    subUnitDefinitionId: { type: "string" },
    reason: {
      type: "string",
      enum: ["DAMAGE_ABSORPTION", "CONTINUOUS_DAMAGE_ABSORPTION"],
    },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
    absorbed: { type: "integer", minimum: 0 },
  },
} as const;

/** `HitPointReduced`（RES-005、Issue #172）。HPを減らした後、`DamageCalculated`と`DamageApplied`の間に発行する。 */
const hitPointReducedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectActionDefinitionId",
    "hitIndex",
    "targetUnitId",
    "hitPointDamage",
    "hpBefore",
    "hpAfter",
  ],
  properties: {
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    targetUnitId: { type: "string" },
    hitPointDamage: { type: "integer", minimum: 0 },
    hpBefore: { type: "integer", minimum: 0 },
    hpAfter: { type: "integer", minimum: 0 },
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
    "hpDirectDamage",
    "typedShieldAbsorbed",
    "untypedShieldAbsorbed",
    "discardedDamage",
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
    // DMG-004（Issue #194、R-SHD-02/03）: 適用先ごとの内訳。
    hpDirectDamage: { type: "integer", minimum: 0 },
    typedShieldAbsorbed: { type: "integer", minimum: 0 },
    untypedShieldAbsorbed: { type: "integer", minimum: 0 },
    /*
     * DMG-005（Issue #190、R-SHD-02 #4／R-SUB-01）: サブユニット吸収量。
     *
     * PRレビュー[P1]（#289）: `required`へは入れない。`10_API設計.md`「バージョニング」が
     * 後方互換な追加として認めるのは**任意プロパティの追加**だけであり、`schemaVersion`が
     * 1のまま既存イベントのdetailsへ必須項目を足すと、`additionalProperties: false`の
     * v1 schemaを保持する厳密なデコーダを壊す（`markers`をv1のまま任意で足したのと
     * 同じ扱い、`response.ts`の`BattleUnitStateResponseBody.markers`参照）。
     * Domain側の`DamageApplied.payload`では必須であり、Response Mapperも常に値を
     * 設定するため、実際の応答から欠落することはない。
     */
    subUnitAbsorbed: { type: "integer", minimum: 0 },
    discardedDamage: { type: "integer", minimum: 0 },
    hitPointDamage: { type: "integer", minimum: 0 },
    hpBefore: { type: "integer", minimum: 0 },
    hpAfter: { type: "integer", minimum: 0 },
    defeated: { type: "boolean" },
    /**
     * DMG-006（Issue #188、R-INT-03第3項）: 反射で生じたダメージだけが`true`を持つ。
     * `subUnitAbsorbed`と同じ理由で`required`へは入れない（v1デコーダ互換）。
     */
    isReflectedDamage: { type: "boolean", enum: [true] },
    /**
     * DMG-007（Issue #187、R-LNK-03第1項）: リンクで生じたダメージだけが`true`を持つ。
     * `isReflectedDamage`と同じ理由で`required`へは入れない（v1デコーダ互換）。
     */
    isLinkedDamage: { type: "boolean", enum: [true] },
  },
} as const;

/**
 * `DamageRedirected`（DMG-006、Issue #188、R-INT-01 #1/#2・R-INT-02）。引き寄せ・
 * 肩代わりでこのヒットの防御側が変わった直後に発行する。`reason: COVER`だけが
 * `damageShareRate`/`guardRate`を持つ。
 */
const damageRedirectedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectActionDefinitionId",
    "hitIndex",
    "reason",
    "originalTargetUnitId",
    "newTargetUnitId",
    "effectInstanceId",
    "causeEffectActionDefinitionId",
  ],
  properties: {
    effectActionDefinitionId: { type: "string" },
    hitIndex: { type: "integer", minimum: 0 },
    reason: { type: "string", enum: ["TARGET_REDIRECT", "COVER"] },
    originalTargetUnitId: { type: "string" },
    newTargetUnitId: { type: "string" },
    effectInstanceId: { type: "string" },
    causeEffectActionDefinitionId: { type: "string" },
    damageShareRate: { type: "number", minimum: 0, maximum: 1 },
    guardRate: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

/**
 * `ReflectedDamageGenerated`（DMG-006、Issue #188、R-INT-01 #4・R-INT-03）。元ダメージの
 * `DamageApplied`の後に反射量を確定させた時点で発行する。
 */
const reflectedDamageGeneratedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceDamageEventId",
    "effectInstanceId",
    "effectActionDefinitionId",
    "reflectedByUnitId",
    "reflectToUnitId",
    "sourceDamage",
    "formulaResult",
    "reflectedDamage",
    "damageType",
  ],
  properties: {
    /** 元ダメージの`DAMAGE_APPLIED`イベントID（`UNIT_DEFEATED.causeEventId`と同じ規約）。 */
    sourceDamageEventId: { type: "string" },
    effectInstanceId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    reflectedByUnitId: { type: "string" },
    reflectToUnitId: { type: "string" },
    sourceDamage: { type: "integer", minimum: 0 },
    formulaResult: { type: "number" },
    reflectedDamage: { type: "integer", minimum: 0 },
    damageType: { type: "string", enum: [...DAMAGE_TYPE_ENUM] },
  },
} as const;

/**
 * `LinkedDamageGenerated`（DMG-007、Issue #187、R-INT-01 #3・R-LNK-01〜03）。元ダメージの
 * `DamageApplied`の後、反射より前にリンク量を確定させた時点で発行する。
 */
const linkedDamageGeneratedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceDamageEventId",
    "effectInstanceId",
    "effectActionDefinitionId",
    "linkedFromUnitId",
    "linkToUnitId",
    "sourceDamage",
    "linkRate",
    "linkedDamage",
    "damageType",
    "shieldApplicable",
  ],
  properties: {
    /** 元ダメージの`DAMAGE_APPLIED`イベントID（`REFLECTED_DAMAGE_GENERATED`と同じ規約）。 */
    sourceDamageEventId: { type: "string" },
    effectInstanceId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    linkedFromUnitId: { type: "string" },
    linkToUnitId: { type: "string" },
    sourceDamage: { type: "integer", minimum: 0 },
    linkRate: { type: "number", minimum: 0, maximum: 1 },
    linkedDamage: { type: "integer", minimum: 0 },
    damageType: { type: "string", enum: [...DAMAGE_TYPE_ENUM] },
    shieldApplicable: { type: "boolean" },
  },
} as const;

/**
 * `LethalDamageSurvived`（DMG-006、Issue #188、R-INT-01 #5）。致死耐えが成立し、
 * `UnitDefeated`の代わりに発行する。
 */
const lethalDamageSurvivedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "effectActionDefinitionId",
    "battleUnitId",
    "lethalDamage",
    "hpBefore",
    "survivalHp",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    battleUnitId: { type: "string" },
    lethalDamage: { type: "integer", minimum: 0 },
    hpBefore: { type: "integer", minimum: 0 },
    survivalHp: { type: "integer", minimum: 1 },
  },
} as const;

/** `HealApplied`（M7-005、Issue #184、R-HEAL-01〜03）。HP回復を適用した直後に発行する。 */
const healAppliedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectActionDefinitionId",
    "sourceUnitId",
    "targetUnitId",
    "formulaResult",
    "distributionShareCount",
    "healingModifierMultiplier",
    "healAmount",
    "appliedAmount",
    "discardedAmount",
    "hpBefore",
    "hpAfter",
  ],
  properties: {
    effectActionDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    targetUnitId: { type: "string" },
    formulaResult: { type: "number" },
    distributionShareCount: { type: "integer", minimum: 1 },
    healingModifierMultiplier: { type: "number", minimum: 0 },
    healAmount: { type: "integer", minimum: 0 },
    transferredAmount: { type: "integer", minimum: 0 },
    appliedAmount: { type: "integer", minimum: 0 },
    discardedAmount: { type: "integer", minimum: 0 },
    hpBefore: { type: "integer", minimum: 0 },
    hpAfter: { type: "integer", minimum: 0 },
  },
} as const;

/** `HealingTransferred`（M7-005-HEAL-LINK、Issue #229、R-HEAL-04）。回復リンクの転送を適用した直後に発行する。 */
const healingTransferredDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "effectActionDefinitionId",
    "fromUnitId",
    "toUnitId",
    "transferRate",
    "transferredAmount",
    "appliedAmount",
    "discardedAmount",
    "hpBefore",
    "hpAfter",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    fromUnitId: { type: "string" },
    toUnitId: { type: "string" },
    transferRate: { type: "number", minimum: 0, maximum: 1 },
    transferredAmount: { type: "integer", minimum: 0 },
    appliedAmount: { type: "integer", minimum: 0 },
    discardedAmount: { type: "integer", minimum: 0 },
    hpBefore: { type: "integer", minimum: 0 },
    hpAfter: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * `ContinuousDamageApplied`（DMG-008、Issue #189、R-DOT-01〜04）。継続ダメージ
 * 1インスタンスの発生を適用した直後に発行する。攻撃ダメージ（`DAMAGE_APPLIED`）とは
 * 別種別であり、会心・貫通・与被ダメージ補正のフィールドを持たない（R-DOT-01
 * 「ダメージ軽減・増加、属性相性の影響を受けない」）。
 */
const continuousDamageAppliedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "effectActionDefinitionId",
    "continuousDamageKind",
    "damageType",
    "targetUnitId",
    "snapshotAttack",
    "formulaResult",
    "burnStackMultiplier",
    "cappedBySnapshotAttack",
    "calculatedDamage",
    "typedShieldAbsorbed",
    "untypedShieldAbsorbed",
    "discardedDamage",
    "hitPointDamage",
    "hpBefore",
    "hpAfter",
    "defeated",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    continuousDamageKind: { type: "string", enum: ["FIXED", "BURN", "POISON"] },
    damageType: { type: "string", enum: ["PHYSICAL", "EN"] },
    targetUnitId: { type: "string" },
    snapshotAttack: { type: "number", minimum: 0 },
    formulaResult: { type: "number" },
    burnStackMultiplier: { type: "number", minimum: 1 },
    cappedBySnapshotAttack: { type: "boolean" },
    calculatedDamage: { type: "integer", minimum: 1 },
    typedShieldAbsorbed: { type: "integer", minimum: 0 },
    untypedShieldAbsorbed: { type: "integer", minimum: 0 },
    /*
     * DMG-005（Issue #190、R-SHD-02 #4／R-SUB-01）: サブユニット吸収量。
     *
     * PRレビュー[P1]（#289）: `required`へは入れない。`10_API設計.md`「バージョニング」が
     * 後方互換な追加として認めるのは**任意プロパティの追加**だけであり、`schemaVersion`が
     * 1のまま既存イベントのdetailsへ必須項目を足すと、`additionalProperties: false`の
     * v1 schemaを保持する厳密なデコーダを壊す（`markers`をv1のまま任意で足したのと
     * 同じ扱い、`response.ts`の`BattleUnitStateResponseBody.markers`参照）。
     * Domain側の`DamageApplied.payload`では必須であり、Response Mapperも常に値を
     * 設定するため、実際の応答から欠落することはない。
     */
    subUnitAbsorbed: { type: "integer", minimum: 0 },
    discardedDamage: { type: "integer", minimum: 0 },
    hitPointDamage: { type: "integer", minimum: 0 },
    hpBefore: { type: "integer", minimum: 0 },
    hpAfter: { type: "integer", minimum: 0 },
    defeated: { type: "boolean" },
  },
} as const;

/**
 * `EffectMerged`（DMG-008、Issue #189、R-DOT-04）。毒など固有規則で既存効果へ
 * 統合した直後に発行する。統合先インスタンスのIDは維持されるため、`EffectApplied`は
 * 発行されない。
 */
const effectMergedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "battleUnitId",
    "effectActionDefinitionId",
    "reason",
    "magnitudeBefore",
    "magnitudeAfter",
    "snapshotAttackBefore",
    "snapshotAttackAfter",
    "tickDamageBefore",
    "tickDamageAfter",
    "remainingBefore",
    "remainingAfter",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    battleUnitId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    reason: { type: "string", enum: ["POISON_REAPPLY"] },
    magnitudeBefore: { type: "number" },
    magnitudeAfter: { type: "number" },
    snapshotAttackBefore: { type: "number", minimum: 0 },
    snapshotAttackAfter: { type: "number", minimum: 0 },
    tickDamageBefore: { type: "number", minimum: 0 },
    tickDamageAfter: { type: "number", minimum: 0 },
    remainingBefore: { type: "integer", minimum: 0 },
    remainingAfter: { type: "integer", minimum: 0 },
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

/** `ChargeCancelled`（R-SKL-05/R-STS-02、Issue #180）。気絶付与時にチャージをキャンセルした後に発行する。 */
const chargeCancelledDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "startedActionId", "reason"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    startedActionId: { type: "string" },
    reason: { type: "string", enum: ["STUN"] },
  },
} as const;

/** `ChargeHeldByFreeze`（R-SKL-05/R-STS-03、Issue #180）。凍結中の行動機会でチャージを維持したまま待機した後に発行する。 */
const chargeHeldByFreezeDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "startedActionId", "freezeEffectInstanceId"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    startedActionId: { type: "string" },
    freezeEffectInstanceId: { type: "string" },
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
  required: [
    "battleUnitId",
    "resource",
    "before",
    "after",
    "delta",
    "baseDelta",
    "reason",
    "causeEventId",
  ],
  properties: {
    battleUnitId: { type: "string" },
    resource: { type: "string", enum: RESOURCE_CHANGE_KIND_ENUM },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
    delta: { type: "integer" },
    baseDelta: { type: "integer" },
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
  required: ["battleUnitId", "baseDelta", "requestedAmount", "actualAmount", "discardedAmount"],
  properties: {
    battleUnitId: { type: "string" },
    baseDelta: { type: "integer", minimum: 0 },
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

/**
 * Issue #217設計方針C（案1、厳密値のみを公開）／レビュー指摘[P2]（PR #218、
 * 2度目の再レビュー）: `unresolvedEffectCount`は、中断が起きた時点で実際に
 * 開いていたACTION適用一覧のうち未処理のまま残った「効果単位」数の厳密値で
 * あり、静的な見積もりや上限値ではない。計数単位は実装（`countHits`、
 * `application.hits.length`の合計）と一致させる: DAMAGEは残りヒットごとに1、
 * 非DAMAGE（`APPLY_STAT_MOD`等）は残りapplication（対象1件×EffectAction1件）
 * ごとに1として数える（DAMAGE以外は常にhits.length === 1のため、結果として
 * 「残りapplication数」と同じ値になる）。まだ開始していないstep・branch・
 * iterationは、その内容を一切見積もらず常に0として扱う（`RANDOM_BRANCH`が
 * 選択・判定前に中断した場合を含む）ため、`INTERRUPTED`かつこの値が0の
 * 組合せも正当。
 */
const UNRESOLVED_EFFECT_COUNT_DESCRIPTION =
  "Exact count of unprocessed effect units left within the ACTION step that was actually open at the moment of interruption. Each remaining hit of a DAMAGE EffectAction counts as 1; each remaining application (one target x one EffectAction) of a non-DAMAGE EffectAction also counts as 1 (non-DAMAGE EffectActions always resolve to exactly one hit per application). Steps, branches, or REPEAT iterations not yet entered (including an unresolved RANDOM_BRANCH selection) always contribute 0 rather than an estimate, so INTERRUPTED with unresolvedEffectCount: 0 is a valid combination.";

const passiveInterruptedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUnitId", "skillDefinitionId", "reason", "unresolvedEffectCount"],
  properties: {
    actorUnitId: { type: "string" },
    skillDefinitionId: { type: "string" },
    reason: { type: "string", enum: ["OWNER_DEFEATED"] },
    unresolvedEffectCount: {
      type: "integer",
      minimum: 0,
      description: UNRESOLVED_EFFECT_COUNT_DESCRIPTION,
    },
  },
} as const;

/** `08_ドメインイベント.md`「Memoryイベント」（M7-006、Issue #179）。 */
const memoryTriggeredDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memoryDefinitionId", "triggeredEffectIndex", "sourceSide", "triggerEventId"],
  properties: {
    memoryDefinitionId: { type: "string" },
    triggeredEffectIndex: { type: "integer", minimum: 0 },
    sourceSide: { type: "string", enum: ["ALLY", "ENEMY"] },
    triggerEventId: { type: "string" },
  },
} as const;

const memoryResolvedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memoryDefinitionId", "triggeredEffectIndex", "sourceSide", "resolvedStepCount"],
  properties: {
    memoryDefinitionId: { type: "string" },
    triggeredEffectIndex: { type: "integer", minimum: 0 },
    sourceSide: { type: "string", enum: ["ALLY", "ENEMY"] },
    resolvedStepCount: { type: "integer", minimum: 0 },
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
    unresolvedEffectCount: {
      type: "integer",
      minimum: 0,
      description: UNRESOLVED_EFFECT_COUNT_DESCRIPTION,
    },
  },
} as const;

const RUNTIME_COUNTER_SCOPE_ENUM = [
  "BATTLE",
  "BATTLE_UNIT",
  "SKILL_RUNTIME",
  "APPLIED_EFFECT",
  "EFFECT_SEQUENCE",
] as const;

const RUNTIME_COUNTER_CHANGED_COMMON_REQUIRED = [
  "ownerUnitId",
  "scope",
  "counter",
  "before",
  "after",
  "carry",
  "valueChanged",
] as const;

/**
 * `RuntimeCounterChanged`（M6最小実装、Issue #143。`APPLIED_EFFECT`スコープは
 * EFF-005/Issue #162で追加）。`carry`は観測用の繰り越し端数。`valueChanged`
 * （`before !== after`）は、carryのみの変化でもこのイベント自体は発行される
 * （追跡性のため）ことと区別するためのフィールド（レビュー再々々レビュー[P1]、
 * Issue #143）。`skillDefinitionId`/`effectInstanceId`は`scope`に応じて排他的に
 * 存在する（`domain-event.ts`の同名フィールドと同じ規約）。`cooldownStateResponseSchema`
 * （`10_API設計.md`「CooldownStateResponse」）と同じ理由（PR #211レビュー[P2]）で
 * `oneOf`によるXOR制約を強制する — 現在実際に発行されるscopeは`SKILL_RUNTIME`／
 * `APPLIED_EFFECT`のみ（`BATTLE`／`BATTLE_UNIT`／`EFFECT_SEQUENCE`はCatalogロード
 * 時点で拒否されるため発行されない）のため、`oneOf`はこの2 variantだけを列挙する。
 */
export const runtimeCounterChangedDetailsSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [...RUNTIME_COUNTER_CHANGED_COMMON_REQUIRED, "skillDefinitionId"],
      properties: {
        ownerUnitId: { type: "string" },
        scope: { const: "SKILL_RUNTIME" },
        counter: { type: "string" },
        skillDefinitionId: { type: "string" },
        before: { type: "number" },
        after: { type: "number" },
        carry: { type: "number" },
        valueChanged: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [...RUNTIME_COUNTER_CHANGED_COMMON_REQUIRED, "effectInstanceId"],
      properties: {
        ownerUnitId: { type: "string" },
        scope: { const: "APPLIED_EFFECT" },
        counter: { type: "string" },
        effectInstanceId: { type: "string" },
        before: { type: "number" },
        after: { type: "number" },
        carry: { type: "number" },
        valueChanged: { type: "boolean" },
      },
    },
  ],
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
const STAT_KIND_ENUM = [
  "MAXIMUM_HP",
  "ATTACK",
  "DEFENSE",
  "CRITICAL_RATE",
  "CRITICAL_DAMAGE_BONUS",
  "AFFINITY_BONUS",
  "ACTION_SPEED",
] as const;

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
    // `condition-definition.ts`の`TARGET_STATE_FIELD_TYPES`（PR #207再レビュー
    // [P2]）: fieldごとに`value`の型が固定されている（`IS_ALIVE`はboolean、
    // `HP_RATIO`/`RESOURCE_*`はnumber、それ以外はstringのみ）。単一の
    // `value: string | number | boolean`では、Domainが拒否する組み合わせ
    // （例: `IS_ALIVE`にstring値）も有効と判定してしまうため、fieldの型別に
    // 3つのvariantへ分ける。
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "field", "op", "value"],
      properties: {
        kind: { const: "TARGET_STATE" },
        target: targetReferenceDetailsSchema,
        field: { const: "IS_ALIVE" },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: { type: "boolean" },
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
          enum: ["HP_RATIO", "RESOURCE_AP", "RESOURCE_PP", "RESOURCE_EX_GAUGE"],
        },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: { type: "number" },
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
          enum: ["ATTRIBUTE", "UNIT_TYPE", "ROLE", "POSITION_ROW", "POSITION_COLUMN", "HAS_STATUS"],
        },
        op: { type: "string", enum: COMPARISON_OPERATOR_ENUM },
        value: { type: "string" },
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
        // `condition-definition.ts`: `assertInteger(input.modulo, ..., { min: 1 })`
        // （PR #207再レビュー[P2]）。`TURN_NUMBER.modulo`（下のvariant）もRES-004
        // （Issue #171、PR #222再レビュー[P2]）で同じ制約へ揃えた。
        modulo: { type: "integer", minimum: 1 },
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
        // `condition-definition.ts`: `assertInteger(input.modulo, ..., { min: 1 })`
        // （RES-004、Issue #171、PR #222再レビュー[P2]）。
        modulo: { type: "integer", minimum: 1 },
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
    // M7-001E（Issue #248、`CAP_TARGET_EFFECT_QUERY`）: `TARGET_HAS_EFFECT`。
    // `expiration.conditions`（`EffectApplied.details.expirationConditions`）で
    // 使われうるため、Domainの`ConditionDefinition`語彙と揃えて公開する。
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "categories"],
      properties: {
        kind: { const: "TARGET_HAS_EFFECT" },
        target: targetReferenceDetailsSchema,
        categories: {
          type: "array",
          minItems: 1,
          items: {
            type: "string",
            enum: ["BUFF", "DEBUFF", "STATUS", "DAMAGE_MOD", "SHIELD", "SUBUNIT"],
          },
        },
        continuousDamageKinds: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["FIXED", "BURN", "POISON"] },
        },
        statKinds: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: STAT_KIND_ENUM },
        },
      },
    },
  ],
} as const;

/**
 * `EffectApplied`（R-EFF-01）。新しい効果インスタンス追加後に発行する。
 * `durationUnit`/`initialRemaining`は`timeLimit`を持つ場合、`consumptionKind`/
 * `consumptionMaxCount`は`consumption`を持つ場合だけ存在する。
 */
/**
 * `AppliedEffect.statusKind`（`APPLY_STATUS`由来の効果だけが持つ状態異常の種別）。
 * `EffectApplied`/`EffectApplicationRejected`の`details`と、
 * `EffectStateResponse`（`simulation-schema.ts`）が共有する。
 */
export const STATUS_KIND_ENUM = [
  "STUN",
  "FREEZE",
  "BLIND",
  "STEALTH",
  "EVASION",
  "DAMAGE_IMMUNITY",
  "CRITICAL_GUARANTEE",
  "CRITICAL_PREVENTION",
  "GUARANTEED_HIT",
  "HIT_EVASION",
] as const;

const effectAppliedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  // R-MEM-04（Issue #179）: Memory由来の付与は`sourceUnitId`を持たず`sourceSide`を
  // 持つ（`08_ドメインイベント.md`「Memoryイベントは`sourceUnitId`を持たず、
  // `sourceSide`を持つ」）ため、`sourceUnitId`は必須にしない。
  required: [
    "effectInstanceId",
    "effectActionDefinitionId",
    "targetUnitId",
    "duplicate",
    "kindKey",
    "effectKind",
    "categories",
    "magnitude",
    "linkedEffectGroupId",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    sourceSide: { type: "string", enum: ["ALLY", "ENEMY"] },
    targetUnitId: { type: "string" },
    duplicate: { type: "boolean" },
    kindKey: { type: "string" },
    // M7-011（Issue #265、`EFFECT_APPLIED_CLASSIFICATION_PAYLOAD`）: 付与した効果の
    // 分類（`domain-event.ts`の`EffectApplied.effectKind`/`categories`）。
    // `TriggerDefinition`の`EVENT_PAYLOAD`が「デバフが付与された際」等を表現する
    // ために必須で、R-STS-01により状態異常は`STATUS`と`DEBUFF`の両方を持つ。
    effectKind: { type: "string", enum: EFFECT_ACTION_KIND_ENUM },
    categories: {
      type: "array",
      items: { type: "string", enum: EFFECT_CATEGORY_ENUM },
      minItems: 1,
    },
    magnitude: { type: "number" },
    // TGT-004フェーズ3（Issue #167、R-ACTN-03）: `APPLY_STATUS`由来の付与だけが持つ
    // （`domain-event.ts`の`EffectApplied.statusKind`。M7-009／Issue #182で公開文書へ追記）。
    statusKind: { type: "string", enum: STATUS_KIND_ENUM },
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

const EFFECT_APPLICATION_REJECTION_REASON_ENUM = ["IMMUNITY"] as const;

/**
 * `EffectApplicationRejected`（R-EFF-03、M7-001B、Issue #243）。`EFFECT_IMMUNITY`
 * 由来の有効な免疫が対象カテゴリの新規付与を拒否した直後に発行する。
 * `statusKind`は拒否対象が`APPLY_STATUS`由来の場合だけ持つ。
 */
const effectApplicationRejectedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  // R-MEM-04（Issue #179）: `EFFECT_APPLIED`と同じ理由で`sourceUnitId`は必須にしない。
  required: ["battleUnitId", "effectActionDefinitionId", "blockingEffectInstanceId", "reason"],
  properties: {
    battleUnitId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    sourceSide: { type: "string", enum: ["ALLY", "ENEMY"] },
    blockingEffectInstanceId: { type: "string" },
    reason: { type: "string", enum: EFFECT_APPLICATION_REJECTION_REASON_ENUM },
    statusKind: { type: "string", enum: STATUS_KIND_ENUM },
  },
} as const;

/** `EffectiveEffectChanged`（R-EFF-05）。`before`/`after`はグループに1件も採用中のインスタンスが無い場合だけ省略する。 */
const effectiveEffectChangedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "kindKey"],
  properties: {
    battleUnitId: { type: "string" },
    kindKey: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
  },
} as const;

const COMBAT_STAT_CHANGE_REASON_ENUM = [
  "EFFECT_APPLIED",
  "EFFECT_EXPIRED",
  "EFFECT_REMOVED",
] as const;

/** `CombatStatChanged`（R-STA-04）。実際に値が変わったstatごとに発行する。 */
const combatStatChangedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "stat", "before", "after", "reason"],
  properties: {
    battleUnitId: { type: "string" },
    stat: { type: "string", enum: STAT_KIND_ENUM },
    before: { type: "number" },
    after: { type: "number" },
    reason: { type: "string", enum: COMBAT_STAT_CHANGE_REASON_ENUM },
  },
} as const;

/**
 * `ResourceCapacityChanged`（G-09、M7-002A／Issue #255）。`MODIFY_RESOURCE_CAPACITY`
 * 由来のAppliedEffectの付与・失効・解除でAP/PP/EXゲージの最大値が実際に変わった時だけ
 * 発行する。`resource: HP`の上限は`MAXIMUM_HP` CombatStatであり`COMBAT_STAT_CHANGED`が
 * 表すため、この`resource`はゲージ3種（`RESOURCE_KIND_ENUM`）だけを取る。
 */
const resourceCapacityChangedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["battleUnitId", "resource", "before", "after", "reason"],
  properties: {
    battleUnitId: { type: "string" },
    resource: { type: "string", enum: RESOURCE_KIND_ENUM },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
    reason: { type: "string", enum: COMBAT_STAT_CHANGE_REASON_ENUM },
  },
} as const;

/** `EffectDurationReduced`（R-EFF-04/06、EFF-003。TGT-004フェーズ1/Issue #167でSKILL_USE単位を追加）。行動・ターン・スキル使用単位効果の残り回数を1減らすたびに発行する。 */
export const effectDurationReducedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectInstanceId", "battleUnitId", "unit", "before", "after"],
  properties: {
    effectInstanceId: { type: "string" },
    battleUnitId: { type: "string" },
    unit: { type: "string", enum: ["ACTION", "TURN", "SKILL_USE"] },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
  },
} as const;

/** `StunDurationChanged`（R-STS-02、Issue #180）。気絶の既存インスタンスへ、より長い残り回数の再付与が到達し差し替えた時に発行する。 */
const stunDurationChangedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectInstanceId", "battleUnitId", "remainingBefore", "remainingAfter", "reason"],
  properties: {
    effectInstanceId: { type: "string" },
    battleUnitId: { type: "string" },
    remainingBefore: { type: "integer", minimum: 0 },
    remainingAfter: { type: "integer", minimum: 0 },
    reason: { type: "string", enum: ["REGRANT_EXTENDED"] },
  },
} as const;

/** `FreezeRemoved`（R-STS-03、Issue #183）。対象の凍結中にDAMAGE EffectActionのヒットが確定した直後、増幅済み最終ダメージとともに発行する。 */
const freezeRemovedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectInstanceId", "battleUnitId", "triggeringDamage"],
  properties: {
    effectInstanceId: { type: "string" },
    battleUnitId: { type: "string" },
    triggeringDamage: { type: "integer", minimum: 0 },
  },
} as const;

/** `EffectConsumptionChanged`（R-EFF-07、EFF-003）。消費条件の成立ごとに消費残り回数の変化を発行する。 */
const effectConsumptionChangedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectInstanceId", "battleUnitId", "kind", "before", "after"],
  properties: {
    effectInstanceId: { type: "string" },
    battleUnitId: { type: "string" },
    kind: { type: "string", enum: CONSUMPTION_KIND_ENUM },
    before: { type: "integer", minimum: 0 },
    after: { type: "integer", minimum: 0 },
  },
} as const;

const EFFECT_EXPIRATION_REASON_ENUM = [
  "TIME_LIMIT",
  "CONSUMPTION",
  "EXPIRATION_CONDITION",
  // R-SHD-01第3項（DMG-004、Issue #194）／R-SUB-01（DMG-005、Issue #190）の個別
  // 消滅条件。`domain-event.ts`の`EffectExpirationReason`が持つ値をこの公開enumが
  // 落としていると、シールド枯渇・サブユニット枯渇による失効ログがschema検証で
  // 弾かれる（DMG-005で`SUBUNIT_DEPLETED`を追加するのに合わせ、DMG-004時点で
  // 追加漏れだった`SHIELD_DEPLETED`もここで揃える）。
  "SHIELD_DEPLETED",
  "SUBUNIT_DEPLETED",
  "LINKED_GROUP_CASCADE",
] as const;

/** `EffectExpired`（R-EFF-04/06/07/08/09、EFF-003）。効果インスタンスの失効直後に発行する。 */
const effectExpiredDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "battleUnitId",
    "effectActionDefinitionId",
    "kindKey",
    "reason",
    "linkedEffectGroupId",
    "cascaded",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    battleUnitId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    kindKey: { type: "string" },
    reason: { type: "string", enum: EFFECT_EXPIRATION_REASON_ENUM },
    linkedEffectGroupId: { type: ["string", "null"] },
    cascaded: { type: "boolean" },
  },
} as const;

const EFFECT_REMOVAL_REASON_ENUM = ["REMOVED", "LINKED_GROUP_CASCADE"] as const;

/** `EffectRemoved`（R-EFF-02/R-EFF-09、M7-001）。`REMOVE_EFFECTS`で`AppliedEffect`を解除した直後に発行する。`EffectExpired`と同じ形だが`reason`が解除固有。 */
const effectRemovedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "battleUnitId",
    "effectActionDefinitionId",
    "kindKey",
    "reason",
    "linkedEffectGroupId",
    "cascaded",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    battleUnitId: { type: "string" },
    effectActionDefinitionId: { type: "string" },
    kindKey: { type: "string" },
    reason: { type: "string", enum: EFFECT_REMOVAL_REASON_ENUM },
    linkedEffectGroupId: { type: ["string", "null"] },
    cascaded: { type: "boolean" },
  },
} as const;

const MARKER_STACK_POLICY_ENUM = ["ADD", "KEEP_EXISTING", "REFRESH", "REPLACE"] as const;

/** `MarkerApplied`（R-EFF-10）。新しい`MarkerState`インスタンス追加後に発行する。`EffectApplied`と同じ「持つ場合だけ対応フィールドを持つ」規約。 */
const markerAppliedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "markerInstanceId",
    "markerId",
    "sourceUnitId",
    "targetUnitId",
    "stackCount",
    "stackMax",
    "linkedEffectGroupId",
  ],
  properties: {
    markerInstanceId: { type: "string" },
    markerId: { type: "string" },
    sourceUnitId: { type: "string" },
    targetUnitId: { type: "string" },
    stackCount: { type: "integer", minimum: 0 },
    stackMax: { type: ["integer", "null"], minimum: 1 },
    durationUnit: { type: "string", enum: DURATION_TIME_UNIT_ENUM },
    durationOwner: { type: "string", enum: DURATION_OWNER_ENUM },
    initialRemaining: { type: "integer", minimum: 1 },
    remainingCount: { type: "integer", minimum: 0 },
    consumptionKind: { type: "string", enum: CONSUMPTION_KIND_ENUM },
    consumptionMaxCount: { type: "integer", minimum: 1 },
    consumptionRemaining: { type: "integer", minimum: 0 },
    expirationConditions: { type: "array", items: { $ref: CONDITION_DEFINITION_SCHEMA_ID } },
    linkedEffectGroupId: { type: ["string", "null"] },
  },
} as const;

/** `MarkerUpdated`（R-EFF-10）。既存`MarkerState`のスタック数・Duration変更後に発行する。`policy`はAPPLY_MARKER経由の更新だけ持つ（`domain-event.ts`の`MarkerUpdated`コメント参照）。 */
const markerUpdatedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "markerInstanceId",
    "markerId",
    "targetUnitId",
    "sourceUnitId",
    "stackBefore",
    "stackAfter",
    "linkedEffectGroupId",
  ],
  properties: {
    markerInstanceId: { type: "string" },
    markerId: { type: "string" },
    targetUnitId: { type: "string" },
    sourceUnitId: { type: "string" },
    policy: { type: "string", enum: MARKER_STACK_POLICY_ENUM },
    stackBefore: { type: "integer", minimum: 0 },
    stackAfter: { type: "integer", minimum: 0 },
    durationUnit: { type: "string", enum: ["ACTION", "TURN"] },
    remainingBefore: { type: "integer", minimum: 0 },
    remainingAfter: { type: "integer", minimum: 0 },
    linkedEffectGroupId: { type: ["string", "null"] },
  },
} as const;

/**
 * `SOURCE_DEFEATED`はMarker固有の解除契機（`duration.removeOnSourceDefeated`、
 * R-EFF-10／M7-020／Issue #279）で、`EFFECT_EXPIRATION_REASON_ENUM`には現れない。
 */
const MARKER_REMOVAL_REASON_ENUM = [
  "REMOVED",
  "TIME_LIMIT",
  "CONSUMPTION",
  "EXPIRATION_CONDITION",
  "SOURCE_DEFEATED",
  "SHIELD_DEPLETED",
  "SUBUNIT_DEPLETED",
  "LINKED_GROUP_CASCADE",
] as const;

/** `MarkerRemoved`（R-EFF-10/R-EFF-09）。`MarkerState`を除去した直後に発行する。`EffectExpired`と同じcascade表現。 */
const markerRemovedDetailsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "markerInstanceId",
    "markerId",
    "targetUnitId",
    "reason",
    "linkedEffectGroupId",
    "cascaded",
  ],
  properties: {
    markerInstanceId: { type: "string" },
    markerId: { type: "string" },
    targetUnitId: { type: "string" },
    reason: { type: "string", enum: MARKER_REMOVAL_REASON_ENUM },
    linkedEffectGroupId: { type: ["string", "null"] },
    cascaded: { type: "boolean" },
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
  RANDOM_BRANCH_SELECTED: randomBranchSelectedDetailsSchema,
  EFFECT_ACTION_STARTING: effectActionStartingDetailsSchema,
  EFFECT_ACTION_COMPLETED: effectActionCompletedDetailsSchema,
  UNIT_BEING_ATTACKED: unitBeingAttackedDetailsSchema,
  HIT_CONFIRMED: hitConfirmedDetailsSchema,
  EVASION_ACTIVATED: evasionActivatedDetailsSchema,
  BLINDNESS_CHECK_RESOLVED: blindnessCheckResolvedDetailsSchema,
  SKILL_MISSED: skillMissedDetailsSchema,
  CRITICAL_CHECK_RESOLVED: criticalCheckResolvedDetailsSchema,
  DAMAGE_WILL_BE_APPLIED: damageWillBeAppliedDetailsSchema,
  DAMAGE_CALCULATED: damageCalculatedDetailsSchema,
  SHIELD_CONSUMED: shieldConsumedDetailsSchema,
  SUB_UNIT_DAMAGED: subUnitDamagedDetailsSchema,
  HIT_POINT_REDUCED: hitPointReducedDetailsSchema,
  DAMAGE_APPLIED: damageAppliedDetailsSchema,
  LINKED_DAMAGE_GENERATED: linkedDamageGeneratedDetailsSchema,
  DAMAGE_REDIRECTED: damageRedirectedDetailsSchema,
  REFLECTED_DAMAGE_GENERATED: reflectedDamageGeneratedDetailsSchema,
  LETHAL_DAMAGE_SURVIVED: lethalDamageSurvivedDetailsSchema,
  HEAL_APPLIED: healAppliedDetailsSchema,
  HEALING_TRANSFERRED: healingTransferredDetailsSchema,
  CONTINUOUS_DAMAGE_APPLIED: continuousDamageAppliedDetailsSchema,
  UNIT_DEFEATED: unitDefeatedDetailsSchema,
  ACTION_COMPLETING: actorEffectiveActionDetailsSchema,
  ACTION_COMPLETED: actorEffectiveActionDetailsSchema,
  COOLDOWN_STARTED: cooldownStartedDetailsSchema,
  COOLDOWN_REDUCED: cooldownReducedDetailsSchema,
  COOLDOWN_COMPLETED: cooldownCompletedDetailsSchema,
  CHARGE_STARTED: chargeStartedDetailsSchema,
  CHARGE_RELEASED: chargeReleasedDetailsSchema,
  CHARGE_CANCELLED: chargeCancelledDetailsSchema,
  CHARGE_HELD_BY_FREEZE: chargeHeldByFreezeDetailsSchema,
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
  MEMORY_TRIGGERED: memoryTriggeredDetailsSchema,
  MEMORY_RESOLVED: memoryResolvedDetailsSchema,
  SKILL_USE_INTERRUPTED: skillUseInterruptedDetailsSchema,
  RUNTIME_COUNTER_CHANGED: runtimeCounterChangedDetailsSchema,
  RUNTIME_COUNTER_RESET: runtimeCounterResetDetailsSchema,
  EFFECT_APPLIED: effectAppliedDetailsSchema,
  EFFECT_MERGED: effectMergedDetailsSchema,
  EFFECT_APPLICATION_REJECTED: effectApplicationRejectedDetailsSchema,
  EFFECTIVE_EFFECT_CHANGED: effectiveEffectChangedDetailsSchema,
  COMBAT_STAT_CHANGED: combatStatChangedDetailsSchema,
  RESOURCE_CAPACITY_CHANGED: resourceCapacityChangedDetailsSchema,
  EFFECT_DURATION_REDUCED: effectDurationReducedDetailsSchema,
  STUN_DURATION_CHANGED: stunDurationChangedDetailsSchema,
  FREEZE_REMOVED: freezeRemovedDetailsSchema,
  EFFECT_CONSUMPTION_CHANGED: effectConsumptionChangedDetailsSchema,
  EFFECT_EXPIRED: effectExpiredDetailsSchema,
  EFFECT_REMOVED: effectRemovedDetailsSchema,
  MARKER_APPLIED: markerAppliedDetailsSchema,
  MARKER_UPDATED: markerUpdatedDetailsSchema,
  MARKER_REMOVED: markerRemovedDetailsSchema,
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
