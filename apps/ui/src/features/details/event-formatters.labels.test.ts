import { describe, expect, it } from "vitest";
import { buildRosterIndex, formatEvent } from "./event-formatters.js";
import { createEffectLabeler } from "../../lib/effect-display-label.js";
import type { EffectLabelCatalog } from "../../lib/effect-display-label.js";
import type { RosterEntry } from "../../entities/roster.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

// docs/ui-design/01_UI要求・画面設計.md §8.1「スキル・効果の表示名」: 時系列イベントの文言は
// スキル・効果を表示名で表し、論理名は`logicalNames`（行のツールチップ）へ回す。

const roster = buildRosterIndex([
  {
    battleUnitId: "ally:1",
    unitDefinitionId: "UNIT_A",
    side: "ALLY",
    displayName: "【約束】エー",
  },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY", displayName: "ビー" },
] satisfies readonly RosterEntry[]);

const catalog: EffectLabelCatalog = {
  skills: [
    { skillDefinitionId: "SKL_A_AS1", slotLabel: "AS1" },
    { skillDefinitionId: "SKL_A_PS1", slotLabel: "PS1" },
  ],
  effects: [
    {
      effectActionDefinitionId: "ACT_ATK_UP",
      kind: "APPLY_STAT_MOD",
      stat: "ATTACK",
      valueType: "RATIO",
      constantMagnitude: 0.1,
    },
    { effectActionDefinitionId: "ACT_STUN", kind: "APPLY_STATUS", status: "STUN" },
    { effectActionDefinitionId: "ACT_COVER", kind: "APPLY_COVER" },
    { effectActionDefinitionId: "ACT_SURVIVE", kind: "APPLY_DEATH_SURVIVAL" },
    { effectActionDefinitionId: "ACT_POISON", kind: "APPLY_CONTINUOUS_DAMAGE" },
  ],
};

function event(
  overrides: Partial<BattleLogEventResponse> & { type: string; sequence: number },
): BattleLogEventResponse {
  return {
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    targetUnitIds: [],
    details: {},
    stateVersionBefore: 0,
    stateVersionAfter: 0,
    ...overrides,
  };
}

const skillStarted = event({
  sequence: 1,
  type: "SKILL_USE_STARTED",
  skillUseId: "su-1",
  sourceUnitId: "ally:1",
  details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_A_AS1" },
});

const applied = event({
  sequence: 2,
  type: "EFFECT_APPLIED",
  skillUseId: "su-1",
  sourceUnitId: "ally:1",
  details: {
    effectInstanceId: "ei-1",
    targetUnitId: "ally:1",
    sourceUnitId: "ally:1",
    effectActionDefinitionId: "ACT_ATK_UP",
    magnitude: 0.08,
    duplicate: false,
  },
});

const events = [skillStarted, applied];
const labeler = createEffectLabeler(catalog, roster, events);

function format(target: BattleLogEventResponse) {
  return formatEvent(target, roster, labeler);
}

function expectLabelled(
  target: BattleLogEventResponse,
  expected: { readonly label: string; readonly logicalNames: readonly string[] },
) {
  const presentation = format(target);
  expect(presentation.summary).toContain(expected.label);
  for (const logicalName of expected.logicalNames) {
    expect(presentation.summary).not.toContain(logicalName);
  }
  expect(presentation.logicalNames).toEqual(expected.logicalNames);
}

describe("時系列イベントの効果の表示名", () => {
  it("UI-UT-LBL-023: 効果の付与を付与元スキルと付与時点の量で表し、論理名をlogicalNamesへ回す", () => {
    expectLabelled(applied, {
      label: "効果「【約束】エー-AS1-攻撃力+8%」",
      logicalNames: ["ACT_ATK_UP"],
    });
  });

  it("UI-UT-LBL-024: 状態の付与は状態種別を本文に残さず、表示名の状態名で表す", () => {
    const presentation = format(
      event({
        sequence: 3,
        type: "EFFECT_APPLIED",
        skillUseId: "su-1",
        sourceUnitId: "ally:1",
        details: {
          effectInstanceId: "ei-stun",
          targetUnitId: "enemy:1",
          effectActionDefinitionId: "ACT_STUN",
          statusKind: "STUN",
          duplicate: false,
        },
      }),
    );
    expect(presentation.summary).toContain("ビーへ効果「【約束】エー-AS1-気絶」を付与しました");
    expect(presentation.logicalNames).toEqual(["ACT_STUN"]);
  });

  it("UI-UT-LBL-025: 付与拒否は拒否された付与の付与元スキルで表す", () => {
    expectLabelled(
      event({
        sequence: 3,
        type: "EFFECT_APPLICATION_REJECTED",
        skillUseId: "su-1",
        sourceUnitId: "ally:1",
        details: {
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "ACT_STUN",
          sourceUnitId: "ally:1",
          blockingEffectInstanceId: "ei-immune",
          reason: "IMMUNE",
          statusKind: "STUN",
        },
      }),
      { label: "効果「【約束】エー-AS1-気絶」", logicalNames: ["ACT_STUN"] },
    );
  });

  it.each(["EFFECT_EXPIRED", "EFFECT_REMOVED"])(
    "UI-UT-LBL-026: %s はインスタンスの付与で表す",
    (type) => {
      expectLabelled(
        event({
          sequence: 9,
          type,
          details: {
            effectInstanceId: "ei-1",
            battleUnitId: "ally:1",
            effectActionDefinitionId: "ACT_ATK_UP",
            kindKey: "ACT_ATK_UP",
            reason: "DURATION",
            linkedEffectGroupId: null,
            cascaded: false,
          },
        }),
        { label: "効果「【約束】エー-AS1-攻撃力+8%」", logicalNames: ["ACT_ATK_UP"] },
      );
    },
  );

  it.each([
    ["EFFECT_DURATION_REDUCED", "unit", "TURN"],
    ["EFFECT_CONSUMPTION_CHANGED", "kind", "HIT"],
  ])("UI-UT-LBL-027: %s はインスタンスIDではなく表示名で表す", (type, unitKey, unitValue) => {
    expectLabelled(
      event({
        sequence: 9,
        type,
        details: {
          battleUnitId: "ally:1",
          effectInstanceId: "ei-1",
          [unitKey]: unitValue,
          before: 2,
          after: 1,
        },
      }),
      { label: "効果「【約束】エー-AS1-攻撃力+8%」", logicalNames: ["ACT_ATK_UP"] },
    );
  });

  it("UI-UT-LBL-028: 採用中の効果の入れ替わりは前後のインスタンスを表示名で表し、同種グループ鍵を本文に出さない", () => {
    expectLabelled(
      event({
        sequence: 9,
        type: "EFFECTIVE_EFFECT_CHANGED",
        details: { battleUnitId: "ally:1", kindKey: "ACT_ATK_UP", after: "ei-1" },
      }),
      { label: "なし → 【約束】エー-AS1-攻撃力+8%", logicalNames: ["ACT_ATK_UP"] },
    );
  });

  it("UI-UT-LBL-029: 肩代わり・致死耐え・統合の要因効果を表示名で表す", () => {
    expectLabelled(
      event({
        sequence: 9,
        type: "DAMAGE_REDIRECTED",
        details: {
          effectActionDefinitionId: "ACT_HIT",
          hitIndex: 0,
          reason: "COVER",
          originalTargetUnitId: "ally:1",
          newTargetUnitId: "enemy:1",
          effectInstanceId: "ei-cover",
          causeEffectActionDefinitionId: "ACT_COVER",
        },
      }),
      { label: "要因: かばう", logicalNames: ["ACT_COVER"] },
    );
    expectLabelled(
      event({
        sequence: 10,
        type: "LETHAL_DAMAGE_SURVIVED",
        details: {
          effectInstanceId: "ei-survive",
          effectActionDefinitionId: "ACT_SURVIVE",
          battleUnitId: "ally:1",
          lethalDamage: 100,
          hpBefore: 50,
          survivalHp: 1,
        },
      }),
      { label: "（戦闘不能耐性）", logicalNames: ["ACT_SURVIVE"] },
    );
    expectLabelled(
      event({
        sequence: 11,
        type: "EFFECT_MERGED",
        details: {
          effectInstanceId: "ei-poison",
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "ACT_POISON",
          reason: "POISON_REAPPLY",
          magnitudeBefore: 1,
          magnitudeAfter: 2,
        },
      }),
      { label: "効果「継続ダメージ」", logicalNames: ["ACT_POISON"] },
    );
  });
});

describe("時系列イベントのスキルの表示名", () => {
  it.each([
    ["COOLDOWN_STARTED", { initialRemaining: 3 }],
    ["COOLDOWN_REDUCED", { before: 3, after: 2 }],
    ["COOLDOWN_COMPLETED", {}],
    ["CHARGE_STARTED", {}],
    ["CHARGE_RELEASED", {}],
    ["CHARGE_CANCELLED", { reason: "STUNNED" }],
    ["CHARGE_HELD_BY_FREEZE", {}],
  ])("UI-UT-LBL-030: %s のスキルをキャラ正式名-スキル種別番号で表す", (type, extra) => {
    expectLabelled(
      event({
        sequence: 9,
        type,
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_A_AS1", ...extra },
      }),
      { label: "「【約束】エー-AS1」", logicalNames: ["SKL_A_AS1"] },
    );
  });

  it.each([
    ["PASSIVE_ACTIVATED", { ppBefore: 2, ppAfter: 1, exBefore: 0, exAfter: 10 }],
    ["PASSIVE_RESOLVED", { resolvedStepCount: 2 }],
    ["PASSIVE_INTERRUPTED", { reason: "DEFEATED", unresolvedEffectCount: 1 }],
    ["PASSIVE_POINT_CONSUMED", { before: 2, after: 1, consumedAmount: 1 }],
  ])("UI-UT-LBL-031: %s のパッシブスキルをキャラ正式名-スキル種別番号で表す", (type, extra) => {
    expectLabelled(
      event({
        sequence: 9,
        type,
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_A_PS1", ...extra },
      }),
      { label: "パッシブスキル「【約束】エー-PS1」", logicalNames: ["SKL_A_PS1"] },
    );
  });

  it("UI-UT-LBL-032: 暗闇によるMISSのスキルを表示名で表す", () => {
    expectLabelled(
      event({
        sequence: 9,
        type: "SKILL_MISSED",
        sourceUnitId: "ally:1",
        details: { skillDefinitionId: "SKL_A_AS1", missedByEffectInstanceIds: ["ei-blind"] },
      }),
      { label: "スキル「【約束】エー-AS1」", logicalNames: ["SKL_A_AS1"] },
    );
  });

  it("UI-UT-LBL-033: 表示名の解決器を渡さなければ、スキル種別番号の位置に論理名を出す", () => {
    const presentation = formatEvent(
      event({
        sequence: 9,
        type: "COOLDOWN_COMPLETED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_A_AS1" },
      }),
      roster,
    );
    expect(presentation.summary).toContain("「【約束】エー-SKL_A_AS1」");
  });

  it("UI-UT-LBL-034: スキル・効果を名指ししないイベントはlogicalNamesを持たない", () => {
    expect(format(event({ sequence: 9, type: "TURN_STARTED" })).logicalNames).toBeUndefined();
  });
});
