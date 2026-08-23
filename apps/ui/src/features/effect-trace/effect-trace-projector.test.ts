import { describe, expect, it } from "vitest";
import { projectEffectTrace } from "./effect-trace-projector.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

const HOLDER = "bu-enemy-1";
const ATTACKER = "bu-ally-1";
const BUFF_HOLDER = "bu-ally-2";

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly turnNumber?: number;
  readonly parentSequence?: number;
  readonly skillUseId?: string;
  readonly sourceUnitId?: string;
  readonly sourceSide?: string;
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  return {
    schemaVersion: 1,
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: seed.turnNumber ?? 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: [],
    stateVersionBefore: seed.sequence,
    stateVersionAfter: seed.sequence + 1,
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    ...(seed.sourceSide !== undefined ? { sourceSide: seed.sourceSide } : {}),
    details: seed.details ?? {},
  };
}

/** `EFFECT_APPLIED`のdetailsのうち、projectorが読む必須項目だけを埋める。 */
function applied(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    effectInstanceId: "ei-1",
    effectActionDefinitionId: "ACT_X",
    targetUnitId: HOLDER,
    duplicate: false,
    kindKey: "ACT_X",
    effectKind: "APPLY_STAT_MOD",
    categories: ["DEBUFF"],
    magnitude: 70,
    linkedEffectGroupId: null,
    ...overrides,
  };
}

function lifecycleEnd(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    effectInstanceId: "ei-1",
    battleUnitId: HOLDER,
    effectActionDefinitionId: "ACT_X",
    kindKey: "ACT_X",
    linkedEffectGroupId: null,
    cascaded: false,
    ...overrides,
  };
}

describe("projectEffectTrace", () => {
  it("follows one instance from grant through consumption to expiry, attributing the consumer to the skill user (UI-UT-TRC-001)", () => {
    const events = [
      event({
        sequence: 10,
        type: "SKILL_USE_STARTED",
        turnNumber: 1,
        skillUseId: "su-suiran",
        sourceUnitId: "bu-ally-3",
      }),
      event({
        sequence: 11,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        skillUseId: "su-suiran",
        sourceUnitId: "bu-ally-3",
        parentSequence: 10,
        details: applied({}),
      }),
      event({
        sequence: 20,
        type: "SKILL_USE_STARTED",
        turnNumber: 2,
        skillUseId: "su-attack",
        sourceUnitId: ATTACKER,
      }),
      event({
        sequence: 21,
        type: "DAMAGE_APPLIED",
        turnNumber: 2,
        skillUseId: "su-attack",
        sourceUnitId: ATTACKER,
        parentSequence: 20,
      }),
      event({
        sequence: 22,
        type: "EFFECT_CONSUMPTION_CHANGED",
        turnNumber: 2,
        skillUseId: "su-attack",
        // 消費イベントの`sourceUnitId`は保持ユニット。消費者はここから読めない。
        sourceUnitId: HOLDER,
        parentSequence: 21,
        details: {
          effectInstanceId: "ei-1",
          battleUnitId: HOLDER,
          kind: "NEXT_INCOMING_ATTACK",
          before: 1,
          after: 0,
        },
      }),
      event({
        sequence: 23,
        type: "EFFECT_EXPIRED",
        turnNumber: 2,
        skillUseId: "su-attack",
        sourceUnitId: HOLDER,
        parentSequence: 22,
        details: lifecycleEnd({ reason: "CONSUMPTION" }),
      }),
    ];

    const trace = projectEffectTrace(events);

    expect(trace.instances).toHaveLength(1);
    const instance = trace.instances[0]!;
    expect(instance).toMatchObject({
      effectInstanceId: "ei-1",
      effectActionDefinitionId: "ACT_X",
      holderUnitId: HOLDER,
      originUnitId: "bu-ally-3",
      appliedTurnNumber: 1,
      endedTurnNumber: 2,
      outcome: "CONSUMED",
      endReason: "CONSUMPTION",
    });
    expect(instance.consumptions).toEqual([
      {
        sequence: 22,
        turnNumber: 2,
        kind: "NEXT_INCOMING_ATTACK",
        before: 1,
        after: 0,
        consumerUnitId: ATTACKER,
      },
    ]);
  });

  it("reports an instance removed under a UNIT_BROKEN ancestor as a break removal even when the reason vocabulary cannot say so (UI-UT-TRC-002)", () => {
    const events = [
      event({ sequence: 5, type: "EFFECT_APPLIED", turnNumber: 1, details: applied({}) }),
      event({ sequence: 30, type: "DAMAGE_APPLIED", turnNumber: 3, sourceUnitId: ATTACKER }),
      event({ sequence: 31, type: "UNIT_BROKEN", turnNumber: 3, parentSequence: 30 }),
      // 解除は`UnitBroken`から直列に連なる（`linked-group-cascade.ts`）ため、
      // 2件目以降の親は直前の解除であり`UNIT_BROKEN`ではない。
      event({
        sequence: 32,
        type: "EFFECT_REMOVED",
        turnNumber: 3,
        parentSequence: 31,
        details: lifecycleEnd({ effectInstanceId: "ei-other", reason: "REMOVED" }),
      }),
      event({
        sequence: 33,
        type: "EFFECT_REMOVED",
        turnNumber: 3,
        parentSequence: 32,
        details: lifecycleEnd({ reason: "REMOVED" }),
      }),
    ];

    const instance = projectEffectTrace(events).instances.find(
      (candidate) => candidate.effectInstanceId === "ei-1",
    );

    expect(instance).toMatchObject({
      outcome: "BREAK_REMOVED",
      endReason: "REMOVED",
      endedTurnNumber: 3,
    });
  });

  it("separates an unused expiry of a consumable effect from the ordinary end of an effect that never had a consumption condition (UI-UT-TRC-003)", () => {
    const events = [
      event({
        sequence: 5,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        details: applied({ consumptionKind: "NEXT_INCOMING_ATTACK", consumptionMaxCount: 1 }),
      }),
      event({
        sequence: 6,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        details: applied({
          effectInstanceId: "ei-buff",
          effectActionDefinitionId: "ACT_BUFF",
          kindKey: "ACT_BUFF",
          targetUnitId: BUFF_HOLDER,
          durationUnit: "TURN",
          initialRemaining: 2,
        }),
      }),
      event({
        sequence: 40,
        type: "EFFECT_EXPIRED",
        turnNumber: 3,
        details: lifecycleEnd({ reason: "TIME_LIMIT" }),
      }),
      event({
        sequence: 41,
        type: "EFFECT_EXPIRED",
        turnNumber: 3,
        details: lifecycleEnd({
          effectInstanceId: "ei-buff",
          effectActionDefinitionId: "ACT_BUFF",
          kindKey: "ACT_BUFF",
          battleUnitId: BUFF_HOLDER,
          reason: "TIME_LIMIT",
        }),
      }),
    ];

    const byId = new Map(
      projectEffectTrace(events).instances.map((instance) => [instance.effectInstanceId, instance]),
    );

    expect(byId.get("ei-1")).toMatchObject({ outcome: "UNUSED_EXPIRED", endReason: "TIME_LIMIT" });
    expect(byId.get("ei-1")?.consumptionMaxCount).toBe(1);
    expect(byId.get("ei-buff")).toMatchObject({ outcome: "ENDED", endReason: "TIME_LIMIT" });
  });

  // R-EFF-07は消費条件と時間制限を別に持たせ、同じイベントで両方が成立する場合だけ消費を
  // 先に評価する。`consumptionMaxCount`が2以上の効果は、使い切る前に時間制限が先に効いて
  // `TIME_LIMIT`で終わり得る（本番Catalogでは`ACT_KATE_PALADIN_AS2_SELF_EVASION`が
  // `INCOMING_HIT maxCount:2`に対し寿命`ACTION 1`であり、これが普通の終わり方になる）。
  // 消費回数の有無だけで「消費された」と判定すると、この残量ロスが成功扱いに隠れる。
  it("distinguishes running out of consumption from timing out with consumption left (UI-UT-TRC-009)", () => {
    const events = [
      event({
        sequence: 5,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        details: applied({ consumptionKind: "INCOMING_HIT", consumptionMaxCount: 2 }),
      }),
      event({
        sequence: 6,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        details: applied({
          effectInstanceId: "ei-spent",
          targetUnitId: "bu-enemy-2",
          consumptionKind: "INCOMING_HIT",
          consumptionMaxCount: 2,
        }),
      }),
      event({
        sequence: 10,
        type: "EFFECT_CONSUMPTION_CHANGED",
        turnNumber: 1,
        sourceUnitId: HOLDER,
        details: {
          effectInstanceId: "ei-1",
          battleUnitId: HOLDER,
          kind: "INCOMING_HIT",
          before: 2,
          after: 1,
        },
      }),
      event({
        sequence: 11,
        type: "EFFECT_CONSUMPTION_CHANGED",
        turnNumber: 1,
        details: {
          effectInstanceId: "ei-spent",
          battleUnitId: "bu-enemy-2",
          kind: "INCOMING_HIT",
          before: 2,
          after: 0,
        },
      }),
      // 使い切った側は`CONSUMPTION`で失効する。
      event({
        sequence: 12,
        type: "EFFECT_EXPIRED",
        turnNumber: 1,
        details: lifecycleEnd({
          effectInstanceId: "ei-spent",
          battleUnitId: "bu-enemy-2",
          reason: "CONSUMPTION",
        }),
      }),
      // 残1のまま寿命が尽きた側は`TIME_LIMIT`で失効する。
      event({
        sequence: 20,
        type: "EFFECT_EXPIRED",
        turnNumber: 2,
        details: lifecycleEnd({ reason: "TIME_LIMIT" }),
      }),
    ];

    const byId = new Map(
      projectEffectTrace(events).instances.map((instance) => [instance.effectInstanceId, instance]),
    );

    expect(byId.get("ei-spent")).toMatchObject({ outcome: "CONSUMED", endReason: "CONSUMPTION" });
    expect(byId.get("ei-1")).toMatchObject({
      outcome: "PARTIALLY_CONSUMED_EXPIRED",
      endReason: "TIME_LIMIT",
      consumptionMaxCount: 2,
    });
  });

  // 消費イベントが公開レベルで間引かれても、`EffectExpired.reason`が使い切りの正本である。
  it("trusts the CONSUMPTION expiry reason even when no consumption event is visible (UI-UT-TRC-010)", () => {
    const events = [
      event({
        sequence: 5,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        details: applied({ consumptionKind: "INCOMING_HIT", consumptionMaxCount: 1 }),
      }),
      event({
        sequence: 20,
        type: "EFFECT_EXPIRED",
        turnNumber: 2,
        details: lifecycleEnd({ reason: "CONSUMPTION" }),
      }),
    ];

    expect(projectEffectTrace(events).instances[0]).toMatchObject({ outcome: "CONSUMED" });
  });

  it("leaves an instance still held at the end of the battle open instead of inventing an end (UI-UT-TRC-004)", () => {
    const events = [
      event({ sequence: 5, type: "EFFECT_APPLIED", turnNumber: 2, details: applied({}) }),
      event({ sequence: 60, type: "BATTLE_COMPLETED", turnNumber: 5 }),
    ];

    const trace = projectEffectTrace(events);

    expect(trace.instances[0]).toMatchObject({ outcome: "ONGOING", appliedTurnNumber: 2 });
    expect(trace.instances[0]?.endedTurnNumber).toBeUndefined();
    expect(trace.instances[0]?.endReason).toBeUndefined();
    // 継続中のバーは最後に観測したターンまで伸ばせるよう、列の範囲は全イベントで取る。
    expect(trace.turnNumbers).toEqual([2, 3, 4, 5]);
  });

  it("leaves the consumer unattributed when the consuming chain has no source unit (R-MEM-04, UI-UT-TRC-005)", () => {
    const events = [
      event({ sequence: 5, type: "EFFECT_APPLIED", turnNumber: 1, details: applied({}) }),
      event({ sequence: 20, type: "MEMORY_TRIGGERED", turnNumber: 2, sourceSide: "ALLY" }),
      event({
        sequence: 21,
        type: "EFFECT_CONSUMPTION_CHANGED",
        turnNumber: 2,
        sourceUnitId: HOLDER,
        parentSequence: 20,
        details: {
          effectInstanceId: "ei-1",
          battleUnitId: HOLDER,
          kind: "INCOMING_HIT",
          before: 1,
          after: 0,
        },
      }),
    ];

    const instance = projectEffectTrace(events).instances[0]!;

    expect(instance.consumptions[0]?.consumerUnitId).toBeUndefined();
  });

  it("tracks two instances of the same effectActionDefinitionId independently (UI-UT-TRC-006)", () => {
    const events = [
      event({
        sequence: 5,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        sourceUnitId: "bu-ally-3",
        details: applied({}),
      }),
      event({
        sequence: 6,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        sourceUnitId: "bu-ally-3",
        details: applied({ effectInstanceId: "ei-2", targetUnitId: "bu-enemy-2" }),
      }),
      event({
        sequence: 20,
        type: "EFFECT_EXPIRED",
        turnNumber: 2,
        details: lifecycleEnd({ reason: "TIME_LIMIT" }),
      }),
    ];

    const trace = projectEffectTrace(events);

    expect(trace.instances.map((instance) => instance.outcome)).toEqual(["ENDED", "ONGOING"]);
    expect(trace.instances.map((instance) => instance.holderUnitId)).toEqual([
      HOLDER,
      "bu-enemy-2",
    ]);
  });

  it("lists every effectActionDefinitionId that appeared, so the selection layer never needs a hard-coded table (UI-UT-TRC-007)", () => {
    const events = [
      event({ sequence: 5, type: "EFFECT_APPLIED", turnNumber: 1, details: applied({}) }),
      event({
        sequence: 6,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        details: applied({ effectInstanceId: "ei-2", effectActionDefinitionId: "ACT_A" }),
      }),
      event({
        sequence: 7,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        details: applied({ effectInstanceId: "ei-3", effectActionDefinitionId: "ACT_X" }),
      }),
    ];

    expect(projectEffectTrace(events).effectActionDefinitionIds).toEqual(["ACT_A", "ACT_X"]);
  });

  it("keeps a grant whose end event arrives before it in sequence order out of the way, and ignores malformed details (UI-UT-TRC-008)", () => {
    const events = [
      event({ sequence: 9, type: "EFFECT_APPLIED", turnNumber: 1, details: { broken: true } }),
      event({
        sequence: 10,
        type: "EFFECT_EXPIRED",
        turnNumber: 1,
        details: lifecycleEnd({ effectInstanceId: "ei-unknown", reason: "TIME_LIMIT" }),
      }),
      event({ sequence: 11, type: "EFFECT_APPLIED", turnNumber: 1, details: applied({}) }),
    ];

    const trace = projectEffectTrace(events);

    expect(trace.instances).toHaveLength(1);
    expect(trace.instances[0]).toMatchObject({ effectInstanceId: "ei-1", outcome: "ONGOING" });
  });
});

describe("projectEffectTrace resolution start", () => {
  // 順位セレクタの対象決定はスキル解決の**起点**で1度だけ行われ、以降のstepは同じbindingを
  // 使い回す。付与ごとの時点で候補を比べると、同じ解決の前段が起こしたバフを織り込んで
  // しまい、実際とは違う順位になる（実測: エレーナEXのDMGUP_LOWが6件中0件しか一致しない）。
  it("carries the first sequence of the skill use that applied the effect (UI-UT-TRC-011)", () => {
    const events = [
      event({
        sequence: 10,
        type: "SKILL_USE_STARTED",
        turnNumber: 1,
        skillUseId: "su-elena",
        sourceUnitId: "bu-ally-2",
      }),
      event({
        sequence: 11,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        skillUseId: "su-elena",
        parentSequence: 10,
        details: applied({ effectInstanceId: "ei-first" }),
      }),
      event({
        sequence: 18,
        type: "EFFECT_APPLIED",
        turnNumber: 1,
        skillUseId: "su-elena",
        parentSequence: 11,
        details: applied({ effectInstanceId: "ei-later" }),
      }),
      // 同じスキル解決に属さない付与は自分の付与sequenceが起点になる。
      event({
        sequence: 30,
        type: "EFFECT_APPLIED",
        turnNumber: 2,
        details: applied({ effectInstanceId: "ei-standalone" }),
      }),
    ];

    const byId = new Map(
      projectEffectTrace(events).instances.map((instance) => [instance.effectInstanceId, instance]),
    );

    expect(byId.get("ei-first")?.resolutionStartSequence).toBe(10);
    expect(byId.get("ei-later")?.resolutionStartSequence).toBe(10);
    expect(byId.get("ei-standalone")?.resolutionStartSequence).toBe(30);
  });
});
