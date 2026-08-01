import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import type { EffectImmunityCategory } from "../../domain/catalog/definitions/catalog-enums.js";
import type { UnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import type { Side } from "../../domain/shared/side.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

/**
 * M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`、`CAP_TARGET_EFFECT_QUERY`）:
 * 変換台帳の対象5行を近似なしへ更新した`TARGET_HAS_EFFECT`条件を、実 `catalog/` から
 * ロードした未改変の定義に対して検証する。各テストは「照会条件を満たす対象にだけ
 * 条件付きの効果が適用される」ことを、実ライフサイクル（`applyEffectActionGroups`が
 * 発行する`EffectActionCompleted.targetUnitIds`）で確かめる。
 *
 * 対象が保持する効果の分類（`AppliedEffect.categories`）は`grantEffect`が
 * `effect-category-classifier.ts`から焼き込む値と同じ形で組み立てる — 照会側と
 * 付与側で分類元が1つであることがこのCapabilityの前提である。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const NO_MISS_NO_CRIT = new SequenceRandomSource(new Array(64).fill(0.99));

function unitOf(
  id: string,
  side: Side,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return {
    ...createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 }),
    ...overrides,
  };
}

/** `grantEffect`が実際に焼き込む形の最小`AppliedEffect`（`categories`は分類元と同じ値）。 */
function heldEffect(
  holder: BattleUnit,
  id: string,
  categories: readonly EffectImmunityCategory[],
  extra: Partial<AppliedEffect> = {},
): AppliedEffect {
  const effectActionDefinitionId = createEffectActionDefinitionId(`ACT_TEST_${id.toUpperCase()}`);
  return {
    effectInstanceId: createEffectInstanceId(`B_CAP_EFFQ:effect:${id}`),
    effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
    duplicate: true,
    targetId: holder.battleUnitId,
    magnitude: categories.includes("DEBUFF") ? -0.2 : 0.2,
    categories,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
    ...extra,
  };
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: string } {
  const recorder = new EventRecorder(createBattleId("B_CAP_EFFQ"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

function contextFor(
  actor: BattleUnit,
  skillId: string,
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  rootEventId: string,
  trigger?: {
    readonly triggerSourceUnitId: ReturnType<typeof createBattleUnitId>;
    readonly triggerTargetUnitIds: readonly ReturnType<typeof createBattleUnitId>[];
  },
): EffectActionGroupContext {
  return {
    definitions,
    actorId: actor.battleUnitId,
    random: NO_MISS_NO_CRIT,
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    actionScope: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    skillDefinitionId: createSkillDefinitionId(skillId),
    ...(trigger ?? {}),
  };
}

function completedTargetsFor(
  recorder: EventRecorder,
  effectActionDefinitionId: string,
): readonly string[] {
  return recorder
    .getEvents()
    .filter(
      (e) =>
        e.eventType === "EffectActionCompleted" &&
        (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
          effectActionDefinitionId,
    )
    .flatMap((e) => (e.payload as { targetUnitIds: readonly string[] }).targetUnitIds);
}

function loadSkill(unitDefinitionId: string, skillDefinitionId: string) {
  const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
    [unitDefinitionId as never],
    [],
  );
  const skill = snapshot.skills.get(skillDefinitionId as never);
  if (skill === undefined) {
    throw new Error(`production Catalog has no SkillDefinition "${skillDefinitionId}"`);
  }
  expect(skill.requiredCapabilities).toContain("CAP_TARGET_EFFECT_QUERY");
  return { skill, snapshot };
}

function definitionsOf(
  snapshot: ReturnType<ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]>,
  skillDefinitionId: string,
  skill: ReturnType<typeof loadSkill>["skill"],
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: snapshot.effectActions,
    unitDefinitions: new Map(),
    skillDefinitions: new Map([[skillDefinitionId as never, skill]]),
  };
}

describe("production Catalog TARGET_HAS_EFFECT (CAP_TARGET_EFFECT_QUERY, M7-001E Issue #248)", () => {
  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-001: SKL_CHIYURU_MAZE_AS1 lowers the base target's defense only while it actually holds POISON (raw「対象が毒状態だった場合一時的に防御力を20%低下させ」)", () => {
    const skillId = "SKL_CHIYURU_MAZE_AS1";
    const { skill, snapshot } = loadSkill("UNIT_CHIYURU_MAZE", skillId);
    const defDown = snapshot.effectActions.get("ACT_CHIYURU_MAZE_AS1_DEF_DOWN" as never);
    expect(defDown?.kind).toBe("APPLY_STAT_MOD");

    const actor = unitOf("actor", "ALLY", "UNIT_CHIYURU_MAZE" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const run = (poisoned: boolean): readonly string[] => {
      const base = unitOf("enemy-base", "ENEMY", "UNIT_TEST_ENEMY" as never, {
        column: "CENTER",
        row: "FRONT",
      });
      const target = poisoned
        ? {
            ...base,
            appliedEffects: [
              // R-DOT-04の再付与統合は既存インスタンスの定義をCatalogから引くため、
              // 実在の`APPLY_CONTINUOUS_DAMAGE`定義IDを持つインスタンスを置く。
              {
                ...heldEffect(base, "poison", ["DEBUFF"], {
                  continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
                  snapshot: { sourceAttack: 20 },
                }),
                effectActionDefinitionId: createEffectActionDefinitionId(
                  "ACT_CHIYURU_MAZE_AS1_POISON",
                ),
              },
            ],
          }
        : base;
      const allUnits = [actor, target];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId),
      );
      return completedTargetsFor(recorder, "ACT_CHIYURU_MAZE_AS1_DEF_DOWN");
    };

    expect(run(true)).toEqual(["enemy-base"]);
    expect(run(false)).toEqual([]);
  });

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-002: SKL_FLUTE_INFLUENCER_PS2 heals the boosted amount and cleanses only a debuffed trigger target (raw「対象の味方にデバフがかけられていた場合、回復量が100%増加し、デバフをすべて解除する」)", () => {
    const skillId = "SKL_FLUTE_INFLUENCER_PS2";
    const { skill, snapshot } = loadSkill("UNIT_FLUTE_INFLUENCER", skillId);
    const boosted = snapshot.effectActions.get("ACT_FLUTE_INFLUENCER_PS2_HEAL_BOOSTED" as never);
    const plain = snapshot.effectActions.get("ACT_FLUTE_INFLUENCER_PS2_HEAL" as never);
    // 「回復量が100%増加」= 威力55 → 110。近似ではなく倍の`SKILL_POWER`で表す。
    expect(boosted?.kind === "HEAL" && boosted.payload.formula).toMatchObject({
      kind: "SKILL_POWER",
      power: 1.1,
    });
    expect(plain?.kind === "HEAL" && plain.payload.formula).toMatchObject({
      kind: "SKILL_POWER",
      power: 0.55,
    });

    const actor = unitOf("actor", "ALLY", "UNIT_FLUTE_INFLUENCER" as never, {
      column: "LEFT",
      row: "BACK",
    });
    const run = (debuffed: boolean) => {
      const base = unitOf(
        "ally-hurt",
        "ALLY",
        "UNIT_TEST_ALLY" as never,
        { column: "CENTER", row: "FRONT" },
        { currentHp: 100 },
      );
      const wounded = debuffed
        ? { ...base, appliedEffects: [heldEffect(base, "atkdown", ["DEBUFF"])] }
        : base;
      const allUnits = [actor, wounded];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const trigger = {
        triggerSourceUnitId: createBattleUnitId("enemy-attacker"),
        triggerTargetUnitIds: [wounded.battleUnitId],
      };
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions, trigger);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId, trigger),
      );
      return recorder;
    };

    const withDebuff = run(true);
    expect(completedTargetsFor(withDebuff, "ACT_FLUTE_INFLUENCER_PS2_HEAL_BOOSTED")).toEqual([
      "ally-hurt",
    ]);
    expect(completedTargetsFor(withDebuff, "ACT_FLUTE_INFLUENCER_PS2_REMOVE_DEBUFF")).toEqual([
      "ally-hurt",
    ]);
    expect(completedTargetsFor(withDebuff, "ACT_FLUTE_INFLUENCER_PS2_HEAL")).toEqual([]);

    const withoutDebuff = run(false);
    expect(completedTargetsFor(withoutDebuff, "ACT_FLUTE_INFLUENCER_PS2_HEAL")).toEqual([
      "ally-hurt",
    ]);
    expect(completedTargetsFor(withoutDebuff, "ACT_FLUTE_INFLUENCER_PS2_HEAL_BOOSTED")).toEqual([]);
    expect(completedTargetsFor(withoutDebuff, "ACT_FLUTE_INFLUENCER_PS2_REMOVE_DEBUFF")).toEqual(
      [],
    );
  });

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-003: SKL_MAIA_LAZY_AS1 shields every ally except herself only when the struck enemy holds a buff (raw「対象がバフ状態にあった場合、自身を除く味方全体にシールドを付与する」)", () => {
    const skillId = "SKL_MAIA_LAZY_AS1";
    const { skill, snapshot } = loadSkill("UNIT_MAIA_LAZY", skillId);

    const actor = unitOf("actor", "ALLY", "UNIT_MAIA_LAZY" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const otherAlly = unitOf("ally-other", "ALLY", "UNIT_TEST_ALLY" as never, {
      column: "CENTER",
      row: "FRONT",
    });
    const run = (buffed: boolean): readonly string[] => {
      const base = unitOf("enemy-back", "ENEMY", "UNIT_TEST_ENEMY" as never, {
        column: "CENTER",
        row: "BACK",
      });
      const target = buffed
        ? { ...base, appliedEffects: [heldEffect(base, "atkup", ["BUFF"])] }
        : base;
      const allUnits = [actor, otherAlly, target];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId),
      );
      return completedTargetsFor(recorder, "ACT_MAIA_LAZY_AS1_SHIELD");
    };

    // 「自身を除く味方全体」: 使用者自身は EXCLUDE_RESOLVED_UNIT で外れる。
    expect(run(true)).toEqual(["ally-other"]);
    expect(run(false)).toEqual([]);
  });

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-004: SKL_NOEL_RUMBLE_AS1 uses the +50% damage action exactly when the target is burning (raw「対象が炎上状態だった場合、この攻撃ダメージは50%増加する」)", () => {
    const skillId = "SKL_NOEL_RUMBLE_AS1";
    const { skill, snapshot } = loadSkill("UNIT_NOEL_RUMBLE", skillId);
    const plain = snapshot.effectActions.get("ACT_NOEL_RUMBLE_AS1_DAMAGE" as never);
    const boosted = snapshot.effectActions.get("ACT_NOEL_RUMBLE_AS1_DAMAGE_VS_BURNING" as never);
    expect(plain?.kind === "DAMAGE" && plain.payload.formula).toMatchObject({ power: 1.6224 });
    // 162.24 × 1.5 = 243.36。近似ではなく厳密な+50%。
    expect(boosted?.kind === "DAMAGE" && boosted.payload.formula).toMatchObject({ power: 2.4336 });

    const actor = unitOf("actor", "ALLY", "UNIT_NOEL_RUMBLE" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const run = (burning: boolean) => {
      const base = unitOf("enemy", "ENEMY", "UNIT_TEST_ENEMY" as never, {
        column: "CENTER",
        row: "FRONT",
      });
      const target = burning
        ? {
            ...base,
            appliedEffects: [
              heldEffect(base, "burn", ["DEBUFF"], {
                continuousDamage: { continuousDamageKind: "BURN", damageType: "PHYSICAL" },
              }),
            ],
          }
        : base;
      const allUnits = [actor, target];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId),
      );
      return recorder;
    };

    const burning = run(true);
    expect(completedTargetsFor(burning, "ACT_NOEL_RUMBLE_AS1_DAMAGE_VS_BURNING")).toEqual([
      "enemy",
    ]);
    expect(completedTargetsFor(burning, "ACT_NOEL_RUMBLE_AS1_DAMAGE")).toEqual([]);

    // 毒（別の継続ダメージ種別）では増加しない — `continuousDamageKinds`の絞り込みが効く。
    const notBurning = run(false);
    expect(completedTargetsFor(notBurning, "ACT_NOEL_RUMBLE_AS1_DAMAGE")).toEqual(["enemy"]);
    expect(completedTargetsFor(notBurning, "ACT_NOEL_RUMBLE_AS1_DAMAGE_VS_BURNING")).toEqual([]);
  });

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-005: SKL_SHOUKA_SCHEMER_AS3's +40% applies only to an ATTACK-stat debuff, not to any other debuff (raw「対象の攻撃力がデバフがかけられていた場合、この攻撃によるダメージが40%増加する」)", () => {
    const skillId = "SKL_SHOUKA_SCHEMER_AS3";
    const { skill, snapshot } = loadSkill("UNIT_SHOUKA_SCHEMER", skillId);
    const boosted = snapshot.effectActions.get(
      "ACT_SHOUKA_SCHEMER_AS3_DAMAGE_VS_ATTACK_DEBUFF" as never,
    );
    // 124.8 × 1.4 = 174.72。
    expect(boosted?.kind === "DAMAGE" && boosted.payload.formula).toMatchObject({ power: 1.7472 });

    const actor = unitOf("actor", "ALLY", "UNIT_SHOUKA_SCHEMER" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const run = (statModStat: "ATTACK" | "DEFENSE" | undefined) => {
      const base = unitOf("enemy", "ENEMY", "UNIT_TEST_ENEMY" as never, {
        column: "CENTER",
        row: "FRONT",
      });
      const target =
        statModStat === undefined
          ? base
          : {
              ...base,
              appliedEffects: [heldEffect(base, "statdown", ["DEBUFF"], { statModStat })],
            };
      const allUnits = [actor, target];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId),
      );
      return recorder;
    };

    const attackDebuffed = run("ATTACK");
    expect(
      completedTargetsFor(attackDebuffed, "ACT_SHOUKA_SCHEMER_AS3_DAMAGE_VS_ATTACK_DEBUFF"),
    ).toEqual(["enemy"]);
    expect(completedTargetsFor(attackDebuffed, "ACT_SHOUKA_SCHEMER_AS3_DAMAGE")).toEqual([]);

    // 防御力デバフでは増加しない（`statKinds`の絞り込みが無ければここが近似になる）。
    for (const stat of ["DEFENSE", undefined] as const) {
      const other = run(stat);
      expect(completedTargetsFor(other, "ACT_SHOUKA_SCHEMER_AS3_DAMAGE")).toEqual(["enemy"]);
      expect(completedTargetsFor(other, "ACT_SHOUKA_SCHEMER_AS3_DAMAGE_VS_ATTACK_DEBUFF")).toEqual(
        [],
      );
    }

    // 「さらに対象にかけられているバフを1つ解除する」は条件に関わらず常に適用される。
    expect(completedTargetsFor(attackDebuffed, "ACT_SHOUKA_SCHEMER_AS3_REMOVE_BUFF")).toEqual([
      "enemy",
    ]);
  });
});
