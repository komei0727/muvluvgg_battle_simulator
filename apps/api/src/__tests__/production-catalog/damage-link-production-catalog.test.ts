import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { AppliedEffect } from "../../domain/battle/model/applied-effect.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { decrementActionEffectDurations } from "../../domain/battle/model/applied-effect-duration.js";
import { expireEffects } from "../../domain/battle/effects/duration-expiry-service.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * DMG-007（Issue #187、R-INT-01 #3／R-LNK-01〜03、`CAP_DAMAGE_LINK_STATE`）:
 * production Catalogのリンクダメージ定義を実カタログから無改変で読み込み、実
 * ライフサイクル（`resolveSkillUse`→`effect-action-group-resolver.ts`の付与→
 * `damage-application-service.ts`のリンク解決）で近似なしに解決できることを検証する。
 *
 * - `ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`（`linkTo: SELF`、50%、解除不可）
 * - `ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`（`linkTo: BINDING`、35%）
 *
 * production定義元のスキル（`SKL_SUIRAN_CASINO_AS1`等）は同じ解決の中で他Taskが
 * 担当する効果（シールド・DAMAGE）も解決するため、
 * `defensive-intervention-production-catalog.test.ts`と同じ方針で、実カタログの
 * EffectActionDefinitionそのものだけを持つ最小限の合成ASで包んで検証する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const SUIRAN_UNIT_ID = "UNIT_SUIRAN_CASINO";
const CHIZURU_UNIT_ID = "UNIT_CHIZURU_DOMESTIC";
const TEST_UNIT_ID = "UNIT_TEST_DAMAGE_LINK";

const SUIRAN_LINK_ID = "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK";
const CHIZURU_LINK_ID = "ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK";
const ATTACK_EFFECT_ID = "ACT_TEST_DAMAGE_LINK_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
// 攻撃力50・防御力0で「素通し50ダメージ」を基準にリンク転送率を観測する。
const COMBAT_STATS = { maximumHp: 1000, attack: 50, defense: 0 };

/** APを満タンにし、合成ASを即時使用できる状態で組む。 */
function readyUnit(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  combatStats: Partial<CombatStats> = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position,
    combatStats: { ...COMBAT_STATS, ...combatStats },
    limits: LIMITS,
    overrides: { currentAp: LIMITS.maximumAp },
  });
}

function baseSkill(skillId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(skillId),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: skillId, tags: [] },
  };
}

/**
 * 実production定義を味方全体へ付与する最小限の合成AS
 * （`ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`の`linkTo: SELF`は使用者へ解決される）。
 */
function allyLinkGrantSkill(skillId: string, effectActionId: string): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ALLY",
    count: "ALL",
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    ...baseSkill(skillId),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_ALLIES"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ALLIES") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
  };
}

/**
 * `ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`は`linkTo: BINDING(TGT_LOWEST_MAXHP)`を持つ。
 * production `SKL_CHIZURU_DOMESTIC_PS1`と同じbinding IDを宣言した合成ASで包む
 * （`DAMAGE_LINK_UNBOUNDED_BINDING`が要求するとおり、bindingは使う側が宣言する）。
 */
function selfLinkToBindingSkill(skillId: string, effectActionId: string): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["LOWEST_MAX_HP"],
    includeDefeated: false,
  };
  return {
    ...baseSkill(skillId),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_LOWEST_MAXHP"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
  };
}

/** 前列の敵単体を1ヒットで殴る合成AS。攻撃側（敵陣営）が使う。 */
function frontRowAttackSkill(): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    ...baseSkill("SKL_TEST_DAMAGE_LINK_ATTACK"),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID) }],
        },
      ],
    },
  };
}

function singleHitAttack(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

interface Fixture {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
}

function fixture(unitIds: readonly string[], skills: readonly SkillDefinition[]): Fixture {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, unitIds);
  const attack = singleHitAttack();
  return {
    definitions: definitionsWith(snapshot, {
      units: [testUnitDefinition(TEST_UNIT_ID, { baseStats: COMBAT_STATS })],
      skills,
      overrides: {
        effectActions: new Map([
          ...snapshot.effectActions,
          [attack.effectActionDefinitionId, attack],
        ]),
      },
    }),
    recorder: new EventRecorder(createBattleId("B_1")),
  };
}

function useSkill(
  actor: BattleUnit,
  skill: SkillDefinition,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  actionSequence: number,
): readonly BattleUnit[] {
  return resolveSkillUse(
    actor,
    skill,
    "AS",
    "AS",
    units,
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId(`B_1:action:${actionSequence}`),
    recorder.nextResolutionScopeId(),
  ).units;
}

describe("production Catalog damage links (DMG-007, Issue #187, R-INT-01 #3 / R-LNK-01〜03)", () => {
  it("IT-CAP-DAMAGE-LINK-STATE-PROD-001 (R-LNK-01/02, real lifecycle wiring): the real ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK links an ally's incoming damage to the granter, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = allyLinkGrantSkill("SKL_TEST_GRANT_DAMAGE_LINK", SUIRAN_LINK_ID);
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([SUIRAN_UNIT_ID], [grantSkill, attackSkill]);
    const suiran = readyUnit("ally:suiran", SUIRAN_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "BACK",
    });
    const ally = readyUnit("ally:front", TEST_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" });
    const attacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const granted = useSkill(
      suiran,
      grantSkill,
      [suiran, ally, attacker],
      definitions,
      recorder,
      1,
    );

    // 付与時点で`linkTo: SELF`は使用者（劉翠蘭）へ解決して焼き込む。
    const holder = granted.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(1);
    const link = holder.appliedEffects[0]!;
    expect(link).toMatchObject({
      effectActionDefinitionId: SUIRAN_LINK_ID,
      duplicate: true,
      magnitude: 0.5,
    });
    expect(link.damageLink).toEqual({ linkToUnitId: suiran.battleUnitId, linkRate: 0.5 });
    // 味方へ付与する自陣向けのリンクは`polarity: BUFF`であり、
    // デバフ解除・デバフ無効の対象にならない。
    expect([...link.categories]).toEqual(["BUFF"]);
    // raw原文「（解除不可）」。
    expect(link.duration.definition).toMatchObject({ dispellable: false });

    // raw原文「自身と自身以外の味方全体にダメージリンクを付与し」のとおり、劉翠蘭自身も
    // リンクを受け取る（自己リンクは恒等でありダメージを発生させない）。ここで検証するのは
    // 転送が実際に起きる味方側のインスタンスである。
    const applied = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "EffectApplied" &&
          (e.payload as { targetUnitId: string }).targetUnitId === ally.battleUnitId,
      ) as Extract<BattleDomainEvent, { eventType: "EffectApplied" }>;
    expect(applied.payload).toMatchObject({ effectKind: "APPLY_DAMAGE_LINK" });
    const reduced = applyStateDelta(
      initialSnapshotFor([ally, suiran], { status: "READY" }),
      applied.stateDelta!,
    );
    expect(reduced.units[ally.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: SUIRAN_LINK_ID,
      damageLink: { linkToUnitId: suiran.battleUnitId, linkRate: 0.5 },
    });

    // R-LNK-01/02: 前列の味方が受けた50ダメージの50%が、リンク先（劉翠蘭）へ
    // **追加で**発生する（元ダメージは減らない）。
    const eventsBeforeAttack = recorder.getEvents().length;
    const attacked = useSkill(
      granted.find((u) => u.battleUnitId === attacker.battleUnitId)!,
      attackSkill,
      granted,
      definitions,
      recorder,
      2,
    );

    const afterAttack = recorder.getEvents().slice(eventsBeforeAttack);
    const generated = afterAttack.find((e) => e.eventType === "LinkedDamageGenerated")!;
    expect(generated.payload).toMatchObject({
      effectActionDefinitionId: SUIRAN_LINK_ID,
      linkedFromUnitId: ally.battleUnitId,
      linkToUnitId: suiran.battleUnitId,
      sourceDamage: 50,
      linkRate: 0.5,
      linkedDamage: 25,
      damageType: "PHYSICAL",
      shieldApplicable: true,
    });
    // R-LNK-03第1項: リンクで生じた適用だけが`isLinkedDamage`を持つ。
    const linkedApplied = afterAttack.find(
      (e) =>
        e.eventType === "DamageApplied" &&
        (e.payload as { isLinkedDamage?: true }).isLinkedDamage === true,
    )!;
    expect(linkedApplied.payload).toMatchObject({
      targetUnitId: suiran.battleUnitId,
      calculatedDamage: 25,
      hitPointDamage: 25,
    });
    expect(attacked.find((u) => u.battleUnitId === ally.battleUnitId)!.currentHp).toBe(1000 - 50);
    expect(attacked.find((u) => u.battleUnitId === suiran.battleUnitId)!.currentHp).toBe(1000 - 25);
  });

  it("IT-CAP-DAMAGE-LINK-STATE-PROD-003: the ally-held link and the granter-held parent shield share 劉翠蘭's clock, so a fast ally acting twice does not expire its link before the shield", () => {
    const grantSkill = allyLinkGrantSkill("SKL_TEST_GRANT_DAMAGE_LINK", SUIRAN_LINK_ID);
    const { definitions, recorder } = fixture([SUIRAN_UNIT_ID], [grantSkill]);
    const suiran = readyUnit("ally:suiran", SUIRAN_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "BACK",
    });
    const ally = readyUnit("ally:front", TEST_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" });

    let units = useSkill(suiran, grantSkill, [suiran, ally], definitions, recorder, 1);
    const linkOf = (all: readonly BattleUnit[]): AppliedEffect | undefined =>
      all
        .find((u) => u.battleUnitId === ally.battleUnitId)!
        .appliedEffects.find((e) => e.effectActionDefinitionId === SUIRAN_LINK_ID);
    expect(linkOf(units)?.duration.definition.timeLimit).toMatchObject({
      unit: "ACTION",
      count: 2,
      // raw原文「2枚目の消滅と同時にダメージリンクも消滅する」: 親の2枚目シールドは
      // 劉翠蘭が保持し既定の`EFFECT_TARGET`で減るため、味方が保持するリンクも
      // 付与者（劉翠蘭）の時計に揃える。
      owner: "EFFECT_SOURCE",
    });
    expect(linkOf(units)?.duration.timeLimitRemaining).toBe(2);

    // 素早い味方が2回行動してもリンクは減らない（減算主体は劉翠蘭である）。
    for (const sequence of [2, 3]) {
      const decrement = decrementActionEffectDurations(
        units,
        ally.battleUnitId,
        createActionId(`B_1:action:${sequence}`),
      );
      units = decrement.units;
      expect(decrement.changes).toEqual([]);
    }
    expect(linkOf(units)?.duration.timeLimitRemaining).toBe(2);

    // 劉翠蘭が2回行動して初めて、親シールドと同時に0へ落ちる。
    let expiredInstanceIds: readonly string[] = [];
    for (const sequence of [4, 5]) {
      const currentActionId = createActionId(`B_1:action:${sequence}`);
      const decrement = decrementActionEffectDurations(units, suiran.battleUnitId, currentActionId);
      units = decrement.units;
      const seeds = decrement.changes
        .filter((change) => change.after === 0)
        .map((change) => ({
          battleUnitId: change.battleUnitId,
          effectInstanceId: change.effectInstanceId,
          reason: "TIME_LIMIT" as const,
        }));
      if (seeds.length > 0) {
        const expiry = expireEffects(
          {
            recorder,
            turnNumber: 1,
            cycleNumber: 1,
            actionId: currentActionId,
            resolutionScopeId: recorder.nextResolutionScopeId(),
            rootEventId: recorder.getEvents()[0]!.eventId,
          },
          units,
          seeds,
          definitions.effectActions,
          recorder.getEvents()[recorder.getEvents().length - 1]!.eventId,
        );
        units = expiry.units;
        expiredInstanceIds = seeds.map((seed) => seed.effectInstanceId);
      }
    }

    // この合成ASは劉翠蘭自身にも（自己リンクとして）付与するため、2件が同時に失効する。
    // 重要なのは「劉翠蘭の2行動目まで1件も失効しない」ことと、そこで味方側も一緒に
    // 失効することである。
    expect(expiredInstanceIds).toHaveLength(2);
    expect(linkOf(units)).toBeUndefined();
  });

  it("IT-CAP-DAMAGE-LINK-STATE-PROD-002 (R-LNK-01, linkTo BINDING): the real ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK burns the binding-selected enemy as its destination and sends 35% of the holder's own incoming damage there", () => {
    const grantSkill = selfLinkToBindingSkill("SKL_TEST_GRANT_LINK_BINDING", CHIZURU_LINK_ID);
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([CHIZURU_UNIT_ID], [grantSkill, attackSkill]);
    const chizuru = readyUnit("ally:chizuru", CHIZURU_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "FRONT",
    });
    // 最大HPが最も低い敵がリンク先になる。
    const frail = readyUnit(
      "enemy:frail",
      TEST_UNIT_ID,
      "ENEMY",
      { column: "LEFT", row: "BACK" },
      { maximumHp: 400 },
    );
    const attacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const granted = useSkill(
      chizuru,
      grantSkill,
      [chizuru, frail, attacker],
      definitions,
      recorder,
      1,
    );

    const holder = granted.find((u) => u.battleUnitId === chizuru.battleUnitId)!;
    expect(holder.appliedEffects[0]!.damageLink).toEqual({
      linkToUnitId: frail.battleUnitId,
      linkRate: 0.35,
    });
    // 自身の被ダメージを敵へ送るこのリンクは保持者を利するため
    // `polarity: BUFF`であり、デバフ無効に拒否されずデバフ解除でも消えない。
    expect([...holder.appliedEffects[0]!.categories]).toEqual(["BUFF"]);

    const eventsBeforeAttack = recorder.getEvents().length;
    const attacked = useSkill(
      granted.find((u) => u.battleUnitId === attacker.battleUnitId)!,
      attackSkill,
      granted,
      definitions,
      recorder,
      2,
    );

    const generated = recorder
      .getEvents()
      .slice(eventsBeforeAttack)
      .find((e) => e.eventType === "LinkedDamageGenerated")!;
    expect(generated.payload).toMatchObject({
      linkedFromUnitId: chizuru.battleUnitId,
      linkToUnitId: frail.battleUnitId,
      sourceDamage: 50,
      linkRate: 0.35,
      // 50 × 35% = 17.5 → R-DMG-02の切り捨てで17。
      linkedDamage: 17,
    });
    expect(attacked.find((u) => u.battleUnitId === frail.battleUnitId)!.currentHp).toBe(400 - 17);
  });
});
