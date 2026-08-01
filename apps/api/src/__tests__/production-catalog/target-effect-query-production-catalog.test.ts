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
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { toEffectSnapshot } from "../../domain/battle/events/state-delta.js";

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

/** 実行前の`BattleStateSnapshot`（独立Reducer復元の起点）。 */
function initialSnapshotFor(units: readonly BattleUnit[]): BattleStateSnapshot {
  return {
    status: "RUNNING",
    currentTurn: 1,
    units: Object.fromEntries(
      units.map((unit) => [
        unit.battleUnitId,
        {
          hp: unit.currentHp,
          ap: unit.currentAp,
          pp: unit.currentPp,
          extraGauge: unit.currentExtraGauge,
          combatStats: unit.combatStats,
          ...(unit.appliedEffects.length > 0
            ? { effects: unit.appliedEffects.map((effect) => toEffectSnapshot(effect, true)) }
            : {}),
        },
      ]),
    ),
  };
}

/** 記録された`stateDelta`だけを独立Reducerへ流し、最終状態を再構成する。 */
function reconstruct(initial: BattleStateSnapshot, recorder: EventRecorder): BattleStateSnapshot {
  return reduceStateDeltas(
    initial,
    recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
  );
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
  onFactEventForPassiveChain?: EffectActionGroupContext["onFactEventForPassiveChain"],
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
    ...(onFactEventForPassiveChain !== undefined ? { onFactEventForPassiveChain } : {}),
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

function loadSkill(
  unitDefinitionId: string,
  skillDefinitionId: string,
  alsoLoadUnitIds: readonly string[] = [],
) {
  const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
    [unitDefinitionId, ...alsoLoadUnitIds] as never,
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

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-002: SKL_FLUTE_INFLUENCER_PS2 always heals the base amount and adds the same amount again (＋100%) plus a cleanse only for a debuffed trigger target", () => {
    const skillId = "SKL_FLUTE_INFLUENCER_PS2";
    // 解除が実際に効くことまで見るため、実在のデバフ定義
    // （`ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN`）も同じsnapshotへ載せる —
    // `REMOVE_EFFECTS`はCatalog定義から分類を導くため、合成IDの効果は一致しない。
    const { skill, snapshot } = loadSkill("UNIT_FLUTE_INFLUENCER", skillId, [
      "UNIT_DOROTHEA_PIONEER",
    ]);
    const heal = snapshot.effectActions.get("ACT_FLUTE_INFLUENCER_PS2_HEAL" as never);
    expect(heal?.kind === "HEAL" && heal.payload.formula).toMatchObject({
      kind: "SKILL_POWER",
      power: 0.55,
    });
    // PR #287レビュー[P2]: 相補的な`targetCondition`を持つ2 stepにすると、先行stepの
    // PS/Memory連鎖が対象の状態を変えた場合に通常版と強化版の両方が実行されうる。
    // raw原文どおり「基本回復は無条件、増加分だけが条件付き」の加算形にして、
    // 条件付きstepを1つだけにする（分岐の選択が二重評価されえない構造）。
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    expect(
      steps.map((step) => (step.kind === "ACTION" ? step.targetCondition.kind : step.kind)),
    ).toEqual(["TRUE", "TARGET_HAS_EFFECT"]);

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
        ? {
            ...base,
            appliedEffects: [
              {
                ...heldEffect(base, "defdown", ["DEBUFF"], { statModStat: "DEFENSE" }),
                effectActionDefinitionId: createEffectActionDefinitionId(
                  "ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN",
                ),
              },
            ],
          }
        : base;
      const allUnits = [actor, wounded];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const trigger = {
        triggerSourceUnitId: createBattleUnitId("enemy-attacker"),
        triggerTargetUnitIds: [wounded.battleUnitId],
      };
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions, trigger);
      const { recorder, rootEventId } = seedRecorder();
      const result = applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId, trigger),
      );
      return { recorder, units: result.units };
    };

    // デバフ有り: 基本回復 + 増加分の2回（合計＝威力55の2倍）とデバフ解除。
    const withDebuff = run(true);
    expect(completedTargetsFor(withDebuff.recorder, "ACT_FLUTE_INFLUENCER_PS2_HEAL")).toEqual([
      "ally-hurt",
      "ally-hurt",
    ]);
    expect(
      completedTargetsFor(withDebuff.recorder, "ACT_FLUTE_INFLUENCER_PS2_REMOVE_DEBUFF"),
    ).toEqual(["ally-hurt"]);
    expect(
      withDebuff.units.find((unit) => unit.battleUnitId === "ally-hurt")?.appliedEffects,
    ).toEqual([]);

    // デバフ無し: 基本回復だけ。回復量はちょうど半分になる。
    const withoutDebuff = run(false);
    expect(completedTargetsFor(withoutDebuff.recorder, "ACT_FLUTE_INFLUENCER_PS2_HEAL")).toEqual([
      "ally-hurt",
    ]);
    expect(
      completedTargetsFor(withoutDebuff.recorder, "ACT_FLUTE_INFLUENCER_PS2_REMOVE_DEBUFF"),
    ).toEqual([]);

    const healedHp = (units: readonly BattleUnit[]): number =>
      (units.find((unit) => unit.battleUnitId === "ally-hurt")?.currentHp ?? 0) - 100;
    // 「回復量が100%増加」: 加算形でも合計は厳密に2倍になる。
    expect(healedHp(withoutDebuff.units)).toBeGreaterThan(0);
    expect(healedHp(withDebuff.units)).toBe(2 * healedHp(withoutDebuff.units));
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

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-006 (PR #287レビュー[P2]): a PS chain that strips the queried effect mid-resolution cannot make both the boosted and the plain damage run — the branch is decided once", () => {
    // 相補的な`targetCondition`を持つ2つのACTION stepにすると、それぞれのstepが
    // 自分の`EffectStepStarting`とそこから生じるPS/Memory連鎖の**後**に最新stateで
    // 評価されるため、強化版を適用した直後に連鎖が炎上を解除すると
    // `NOT(TARGET_HAS_EFFECT BURN)`も成立して通常版まで走ってしまう。単一BRANCHは
    // 分岐の選択を一度だけ確定するため、この経路が構造的に存在しない。
    const skillId = "SKL_NOEL_RUMBLE_AS1";
    const { skill, snapshot } = loadSkill("UNIT_NOEL_RUMBLE", skillId);
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    expect(steps.map((step) => step.kind)).toEqual(["BRANCH"]);

    const actor = unitOf("actor", "ALLY", "UNIT_NOEL_RUMBLE" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const base = unitOf("enemy", "ENEMY", "UNIT_TEST_ENEMY" as never, {
      column: "CENTER",
      row: "FRONT",
    });
    const burning = {
      ...base,
      appliedEffects: [
        heldEffect(base, "burn", ["DEBUFF"], {
          continuousDamage: { continuousDamageKind: "BURN", damageType: "PHYSICAL" },
        }),
      ],
    };
    const allUnits = [actor, burning];
    const definitions = definitionsOf(snapshot, skillId, skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder();

    // 強化ダメージが着弾した瞬間に、PS連鎖が炎上を解除した状況を模す。
    const stripBurnOnDamage = (
      event: { readonly eventType: string },
      units: readonly BattleUnit[],
    ): readonly BattleUnit[] =>
      event.eventType === "DamageApplied"
        ? units.map((unit) =>
            unit.battleUnitId === "enemy" ? { ...unit, appliedEffects: [] } : unit,
          )
        : units;

    applyEffectActionGroups(
      plan,
      allUnits,
      contextFor(actor, skillId, definitions, recorder, rootEventId, undefined, stripBurnOnDamage),
    );

    expect(completedTargetsFor(recorder, "ACT_NOEL_RUMBLE_AS1_DAMAGE_VS_BURNING")).toEqual([
      "enemy",
    ]);
    expect(completedTargetsFor(recorder, "ACT_NOEL_RUMBLE_AS1_DAMAGE")).toEqual([]);
  });

  /**
   * RES-004-STATUS-CONDITION（Issue #224、`AOE_PER_TARGET_CONDITION`）:
   * 「対象が状態異常にある場合」という総称の照会。`01_ユビキタス言語.md`「状態異常」
   * が定義する5種のうち炎上・毒は`APPLY_CONTINUOUS_DAMAGE`、気絶・凍結・暗闇は
   * `APPLY_STATUS`として保持されるが、Catalogは種別を列挙せず`categories: ["STATUS"]`
   * だけを書く — 分類は`effect-category-classifier.ts`ただ1つが担うためである。
   */
  const statusAilment = (
    holder: BattleUnit,
    id: string,
    extra: Partial<AppliedEffect>,
  ): AppliedEffect => heldEffect(holder, id, ["STATUS", "DEBUFF"], extra);

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-007: SKL_CHIYURU_MAZE_EX stuns and damage-amplifies exactly the AOE targets that hold a 状態異常, poison included (raw「敵全体に威力117で攻撃する。対象が状態異常にある場合、1行動分の気絶を付与し、一度だけ対象の受ける被ダメージを100%増加させるデバフを付与する」)", () => {
    const skillId = "SKL_CHIYURU_MAZE_EX";
    const { skill, snapshot } = loadSkill("UNIT_CHIYURU_MAZE", skillId);
    const stun = snapshot.effectActions.get("ACT_CHIYURU_MAZE_EX_STUN" as never);
    const damageTakenUp = snapshot.effectActions.get(
      "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP" as never,
    );
    expect(stun?.kind === "APPLY_STATUS" && stun.payload).toMatchObject({
      status: "STUN",
      duration: { timeLimit: { unit: "ACTION", count: 1 } },
    });
    // 「一度だけ…被ダメージを100%増加させる（重複可）」= 次の被攻撃1回で消費、重複可。
    expect(damageTakenUp?.kind === "APPLY_DAMAGE_MOD" && damageTakenUp.payload).toMatchObject({
      direction: "INCOMING",
      formula: { kind: "CONSTANT", value: 1 },
      stacking: { mode: "STACKABLE" },
      duration: { consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 } },
    });

    const actor = unitOf("actor", "ALLY", "UNIT_CHIYURU_MAZE" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    // 敵全体4体を、状態異常の保持形が異なる組み合わせで並べる（複数対象混在）。
    const poisonedBase = unitOf("enemy-poisoned", "ENEMY", "UNIT_TEST_ENEMY" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const stunnedBase = unitOf("enemy-stunned", "ENEMY", "UNIT_TEST_ENEMY" as never, {
      column: "CENTER",
      row: "FRONT",
    });
    const statDebuffedBase = unitOf("enemy-statdebuff", "ENEMY", "UNIT_TEST_ENEMY" as never, {
      column: "RIGHT",
      row: "FRONT",
    });
    const cleanEnemy = unitOf("enemy-clean", "ENEMY", "UNIT_TEST_ENEMY" as never, {
      column: "CENTER",
      row: "BACK",
    });
    const poisoned = {
      ...poisonedBase,
      appliedEffects: [
        {
          ...statusAilment(poisonedBase, "poison", {
            continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
            snapshot: { sourceAttack: 20 },
          }),
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_CHIYURU_MAZE_AS1_POISON"),
        },
      ],
    };
    const stunned = {
      ...stunnedBase,
      appliedEffects: [statusAilment(stunnedBase, "stun", { statusKind: "STUN" })],
    };
    // 状態異常ではない通常のデバフだけを持つ対象は不成立（`DEBUFF`への近似ではない）。
    const statDebuffed = {
      ...statDebuffedBase,
      appliedEffects: [
        heldEffect(statDebuffedBase, "defdown", ["DEBUFF"], { statModStat: "DEFENSE" }),
      ],
    };

    const allUnits = [actor, poisoned, stunned, statDebuffed, cleanEnemy];
    const definitions = definitionsOf(snapshot, skillId, skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder();
    const result = applyEffectActionGroups(
      plan,
      allUnits,
      contextFor(actor, skillId, definitions, recorder, rootEventId),
    );

    // 攻撃自体は敵全体へ入る。
    expect([...completedTargetsFor(recorder, "ACT_CHIYURU_MAZE_EX_DAMAGE")].sort()).toEqual([
      "enemy-clean",
      "enemy-poisoned",
      "enemy-statdebuff",
      "enemy-stunned",
    ]);
    // 条件付きの2効果は状態異常を持つ対象だけへ入る。
    for (const actionId of ["ACT_CHIYURU_MAZE_EX_STUN", "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP"]) {
      expect([...completedTargetsFor(recorder, actionId)].sort()).toEqual([
        "enemy-poisoned",
        "enemy-stunned",
      ]);
    }

    // Domain Event（`EffectApplied`）・StateDelta・独立Reducer復元:
    // `stateDelta`だけから再構成した最終状態が、集約側の`appliedEffects`と一致する。
    const reconstructed = reconstruct(initialSnapshotFor(allUnits), recorder);
    const grantedBy = (ids: readonly string[]): readonly string[] =>
      [...ids].filter((id) => id.startsWith("ACT_CHIYURU_MAZE_EX_")).sort();
    const restoredIds = (unitId: string): readonly string[] =>
      grantedBy(
        (reconstructed.units[unitId as never]?.effects ?? []).map(
          (effect) => effect.effectDefinitionId,
        ),
      );
    for (const enemy of [poisoned, stunned, statDebuffed, cleanEnemy]) {
      const aggregate = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      expect(restoredIds(enemy.battleUnitId)).toEqual(
        grantedBy(aggregate.appliedEffects.map((effect) => effect.effectActionDefinitionId)),
      );
      expect(reconstructed.units[enemy.battleUnitId]?.hp).toBe(aggregate.currentHp);
    }
    expect(restoredIds(poisoned.battleUnitId)).toEqual([
      "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP",
      "ACT_CHIYURU_MAZE_EX_STUN",
    ]);
    expect(restoredIds(cleanEnemy.battleUnitId)).toEqual([]);
  });

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-008: SKL_MERU_FLATSPIN_AS2's 状態異常 branch fires for a poisoned target too, not only for STUN/FREEZE/BLIND (raw「対象が状態異常だった場合、さらに威力62.4で追加攻撃する」)", () => {
    const skillId = "SKL_MERU_FLATSPIN_AS2";
    const { skill, snapshot } = loadSkill("UNIT_MERU_FLATSPIN", skillId);

    const actor = unitOf("actor", "ALLY", "UNIT_MERU_FLATSPIN" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const run = (held: "poison" | "stun" | "statDebuff" | "none"): readonly string[] => {
      const base = unitOf("enemy", "ENEMY", "UNIT_TEST_ENEMY" as never, {
        column: "CENTER",
        row: "FRONT",
      });
      const appliedEffects: readonly AppliedEffect[] =
        held === "poison"
          ? [
              statusAilment(base, "poison", {
                continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
              }),
            ]
          : held === "stun"
            ? [statusAilment(base, "stun", { statusKind: "STUN" })]
            : held === "statDebuff"
              ? [heldEffect(base, "atkdown", ["DEBUFF"], { statModStat: "ATTACK" })]
              : [];
      const target = { ...base, appliedEffects };
      const allUnits = [actor, target];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId),
      );
      return completedTargetsFor(recorder, "ACT_MERU_FLATSPIN_AS2_DAMAGE_EXTRA");
    };

    // M7-001Eの3項OR（気絶・凍結・暗闇）では毒が漏れていた。ここが本Issueの解消点。
    expect(run("poison")).toEqual(["enemy"]);
    expect(run("stun")).toEqual(["enemy"]);
    // 状態異常ではないデバフ・無状態では不成立（「何らかのデバフ」への近似ではない）。
    expect(run("statDebuff")).toEqual([]);
    expect(run("none")).toEqual([]);
  });

  it("IT-CAP-TARGET-EFFECT-QUERY-PROD-009: SKL_NANAE_COMMANDER_PS1 cleanses her own debuffs when she is burning, evaluated on the state left by the preceding step (raw「自身が状態異常だった場合、自身にかけられたデバフを全て解除する」)", () => {
    const skillId = "SKL_NANAE_COMMANDER_PS1";
    // 解除が実際に効くことまで見るため、実在のデバフ定義も同じsnapshotへ載せる。
    const { skill, snapshot } = loadSkill("UNIT_NANAE_COMMANDER", skillId, [
      "UNIT_DOROTHEA_PIONEER",
    ]);

    const run = (burning: boolean) => {
      const base = unitOf(
        "actor",
        "ALLY",
        "UNIT_NANAE_COMMANDER" as never,
        { column: "CENTER", row: "FRONT" },
        { currentHp: 500 },
      );
      const debuff = {
        ...heldEffect(base, "defdown", ["DEBUFF"], { statModStat: "DEFENSE" }),
        effectActionDefinitionId: createEffectActionDefinitionId(
          "ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN",
        ),
      };
      const actor = {
        ...base,
        appliedEffects: burning
          ? [
              debuff,
              statusAilment(base, "burn", {
                continuousDamage: { continuousDamageKind: "BURN", damageType: "PHYSICAL" },
              }),
            ]
          : [debuff],
      };
      const allUnits = [actor];
      const definitions = definitionsOf(snapshot, skillId, skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, skillId, definitions, recorder, rootEventId),
      );
      return completedTargetsFor(recorder, "ACT_NANAE_COMMANDER_PS1_CLEANSE");
    };

    expect(run(true)).toEqual(["actor"]);
    expect(run(false)).toEqual([]);
  });
});
