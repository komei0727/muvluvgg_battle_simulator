import { CATALOG_REVISION } from "./catalog.js";

// M7-009 (Issue #182) regression fixture: a battle that actually exercises the
// M7 heal/effect/status contract, kept separate from battle-success.ts so the
// visual-regression baselines (which pin that fixture's rendering) stay valid.
//
// Shapes mirror apps/api/src/presentation/http/schemas/battle-log/
// battle-log-schema.ts (healAppliedDetailsSchema, healingTransferredDetailsSchema,
// effectAppliedDetailsSchema) and schemas/simulation/simulation-schema.ts
// (effectStateResponseSchema).
//
// REF-053 (Issue #598): none of apps/ui/src/test/fixtures/*.json target this
// M7 heal/effect/status contract, and this fixture's visual-regression pin
// (above) rules out sourcing it from a generated fixture anyway.
//
// HEAL expectations: of the 60 HP requested, 10 goes to the R-HEAL-04 healing
// link, 40 actually raises the healer's HP (60 → 100) and the remaining 10 is
// discarded as overheal; the transferred 10 then raises the link destination
// (70 → 80). The ALLY HEAL column is therefore 40 + 10 = 50 — the actually
// applied HP, never the requested healAmount.
export const battleHealEffectsFixture = {
  schemaVersion: 1,
  battleId: "battle-e2e-002",
  catalogRevision: CATALOG_REVISION,
  result: {
    outcome: "ALLY_WIN",
    completionReason: "ENEMY_DEFEATED",
    completedTurn: 2,
  },
  initialState: {
    stateVersion: 0,
    battleStatus: "READY",
    turnNumber: 0,
    cycleNumber: 0,
    units: [
      {
        battleUnitId: "bu-ally-1",
        unitDefinitionId: "UNIT_ALLY_A",
        side: "ALLY",
        combatStatus: "ACTIVE",
        hp: { current: 60, maximum: 100 },
        effects: [],
        cooldowns: [],
      },
      {
        battleUnitId: "bu-enemy-1",
        unitDefinitionId: "UNIT_ENEMY_A",
        side: "ENEMY",
        combatStatus: "ACTIVE",
        // 回復リンクの転送先が満タンだと転送分が適用されないため、負傷状態から始める。
        hp: { current: 70, maximum: 80 },
        effects: [],
        cooldowns: [],
      },
    ],
  },
  finalState: {
    stateVersion: 5,
    battleStatus: "COMPLETED",
    turnNumber: 2,
    cycleNumber: 0,
    units: [
      {
        battleUnitId: "bu-ally-1",
        unitDefinitionId: "UNIT_ALLY_A",
        side: "ALLY",
        combatStatus: "ACTIVE",
        hp: { current: 100, maximum: 100 },
        cooldowns: [],
        effects: [
          {
            effectInstanceId: "battle-e2e-002:effect:1",
            effectDefinitionId: "ACT_ALLY_ATTACK_UP",
            sourceUnitId: "bu-ally-1",
            category: "BUFF",
            effectKindKey: "ACT_ALLY_ATTACK_UP",
            stackMode: "NON_STACKING",
            isEffective: true,
            value: { magnitude: 0.1 },
            duration: { unit: "TURN", remaining: 2 },
            appliedTurnNumber: 1,
          },
        ],
      },
      {
        battleUnitId: "bu-enemy-1",
        unitDefinitionId: "UNIT_ENEMY_A",
        side: "ENEMY",
        combatStatus: "DEFEATED",
        hp: { current: 0, maximum: 80 },
        cooldowns: [],
        effects: [
          {
            effectInstanceId: "battle-e2e-002:effect:2",
            effectDefinitionId: "ACT_ENEMY_STUN",
            sourceUnitId: "bu-ally-1",
            category: "STATUS_ABNORMALITY",
            effectKindKey: "ACT_ENEMY_STUN",
            statusKind: "STUN",
            stackMode: "NON_STACKING",
            isEffective: true,
            value: { magnitude: 0 },
            duration: { unit: "ACTION", remaining: 1 },
            appliedTurnNumber: 1,
          },
        ],
      },
    ],
  },
  // サーバー集計（docs/ddd/10_API設計.md「UnitBattleSummaryResponse」）。
  // HEALは実回復量 40（自己回復）+ 10（回復リンクの転送先で実際に増えた分）= 50。
  // 要求量60でも破棄分を含む合計でもない。
  unitSummaries: [
    {
      battleUnitId: "bu-ally-1",
      side: "ALLY",
      damageDealt: 80,
      damageTaken: 0,
      healingDone: 50,
      finalHp: 100,
      maximumHp: 100,
      combatStatus: "ACTIVE",
    },
    {
      battleUnitId: "bu-enemy-1",
      side: "ENEMY",
      damageDealt: 0,
      damageTaken: 80,
      healingDone: 0,
      finalHp: 0,
      maximumHp: 80,
      combatStatus: "DEFEATED",
    },
  ],

  events: [
    {
      sequence: 1,
      type: "TURN_STARTED",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 1,
      rootSequence: 1,
      targetUnitIds: [],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
      details: { turnNumber: 1 },
    },
    {
      sequence: 2,
      type: "EFFECT_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      rootSequence: 2,
      sourceUnitId: "bu-ally-1",
      targetUnitIds: ["bu-enemy-1"],
      stateVersionBefore: 1,
      stateVersionAfter: 2,
      details: {
        effectInstanceId: "battle-e2e-002:effect:2",
        effectActionDefinitionId: "ACT_ENEMY_STUN",
        sourceUnitId: "bu-ally-1",
        targetUnitId: "bu-enemy-1",
        duplicate: false,
        kindKey: "ACT_ENEMY_STUN",
        magnitude: 0,
        statusKind: "STUN",
        durationUnit: "ACTION",
        initialRemaining: 1,
        linkedEffectGroupId: null,
      },
    },
    {
      sequence: 3,
      type: "HEAL_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      rootSequence: 3,
      sourceUnitId: "bu-ally-1",
      targetUnitIds: ["bu-ally-1"],
      stateVersionBefore: 2,
      stateVersionAfter: 3,
      details: {
        effectActionDefinitionId: "ACT_ALLY_HEAL",
        sourceUnitId: "bu-ally-1",
        targetUnitId: "bu-ally-1",
        formulaResult: 60,
        distributionShareCount: 1,
        healingModifierMultiplier: 1,
        healAmount: 60,
        transferredAmount: 10,
        appliedAmount: 40,
        discardedAmount: 10,
        hpBefore: 60,
        hpAfter: 100,
      },
    },
    {
      sequence: 4,
      type: "HEALING_TRANSFERRED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      parentSequence: 3,
      rootSequence: 3,
      sourceUnitId: "bu-ally-1",
      targetUnitIds: ["bu-enemy-1"],
      stateVersionBefore: 3,
      stateVersionAfter: 4,
      details: {
        effectInstanceId: "battle-e2e-002:effect:3",
        effectActionDefinitionId: "ACT_HEALING_LINK",
        fromUnitId: "bu-ally-1",
        toUnitId: "bu-enemy-1",
        transferRate: 0.25,
        transferredAmount: 10,
        appliedAmount: 10,
        discardedAmount: 0,
        hpBefore: 70,
        hpAfter: 80,
      },
    },
    {
      sequence: 5,
      type: "DAMAGE_APPLIED",
      category: "FACT",
      turnNumber: 2,
      cycleNumber: 1,
      rootSequence: 5,
      sourceUnitId: "bu-ally-1",
      targetUnitIds: ["bu-enemy-1"],
      stateVersionBefore: 4,
      stateVersionAfter: 5,
      stateTransitionIndex: 0,
      details: {
        effectActionDefinitionId: "ACT_ALLY_ATTACK",
        hitIndex: 0,
        targetUnitId: "bu-enemy-1",
        calculatedDamage: 120,
        hitPointDamage: 80,
        hpBefore: 80,
        hpAfter: 0,
        defeated: true,
      },
    },
  ],
  stateTransitions: [
    {
      stateVersionBefore: 4,
      stateVersionAfter: 5,
      causedBySequence: 5,
      delta: {
        units: {
          "bu-enemy-1": { hp: { current: 0 }, combatStatus: "DEFEATED" },
        },
      },
    },
  ],
};
