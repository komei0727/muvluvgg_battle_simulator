import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "../domain/battle/lifecycle/battle.js";
import { createBattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createTurnLimit } from "../domain/battle/model/turn-limit.js";
import { SequenceRandomSource } from "../testing/random/sequence-random-source.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../domain/shared/side.js";
import { detectPassiveCandidates } from "../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../domain/battle/triggering/passive-activation-guard.js";
import type { TriggerCandidateEvent } from "../domain/battle/triggering/trigger-event.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * Issue #144 follow-up (docs/ddd/15_Unit_Memory変換台帳.md 該当行):
 * `SKL_SUIRAN_CHAOS_PS3`が参照する`SkillUseStarting`はBattle Engineが実行時に
 * 発行するが、実ライフサイクル経由で候補検出（trigger一致）を確認する統合
 * テストがまだ無かった。
 *
 * 完全な発動・実効果解決までは検証しない: `SKL_SUIRAN_CHAOS_PS3`のEffectSequence
 * step は `target: { kind: "TRIGGER_TARGET" }` / `{ kind: "TRIGGER_SOURCE" }` を
 * 参照するが、`skill-resolution-service.ts`の基本実装（M6/M7スコープ）は
 * `SELF`/`BINDING`しか解決できず、これらのkindは未対応のため例外を送出する
 * （このIssueとは独立したギャップ）。そのため、ここでは`detectPassiveCandidates`
 * （R-PS-01候補抽出）だけを、Battle Engineが実際に発行する`SkillUseStarting`
 * （本Issueで`skillType`欠落を修正した実データ）と、real production `catalog/`
 * から読み込んだ未改変のSuiranの`UnitDefinition`/`SkillDefinition`で検証する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

const SUIRAN_UNIT_ID = "UNIT_SUIRAN_CHAOS";
const SUIRAN_PS3_ID = "SKL_SUIRAN_CHAOS_PS3";

const ATTACKER_UNIT_ID = "UNIT_TEST_PS3_ATTACKER";
const ATTACKER_AS_ID = "SKL_TEST_PS3_ATTACKER_AS";
const ATTACKER_EFFECT_ID = "ACT_TEST_PS3_ATTACKER_HIT";
const ENEMY_UNIT_ID = "UNIT_TEST_PS3_ENEMY";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 50,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
}

function testUnitDefinition(id: string, actionSpeed: number): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 50,
      defense: 10,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [createSkillDefinitionId(ATTACKER_AS_ID)],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: `CHAR_${id}`,
      affiliations: [],
      tags: [],
    },
  };
}

function attackerSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(ATTACKER_AS_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(ATTACKER_EFFECT_ID) },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "TestAttack", tags: [] },
  };
}

function attackerEffectAction(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACKER_EFFECT_ID),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

describe("production Catalog SKL_SUIRAN_CHAOS_PS3 (Issue #144 follow-up, TRIGGER_POSITION_RELATION)", () => {
  it("IT-CAT-PROD-012: is detected as a candidate through detectPassiveCandidates when the REAL SkillUseStarting event a battle actually emits fires from an ally positioned in front of Suiran", () => {
    // Step 1: run a real ally-vs-enemy battle (without Suiran) so
    // `action-skill-use-resolver.ts` emits a genuine `SkillUseStarting`
    // event, proving this Issue's `skillType` payload fix at its real
    // emission site (not a hand-authored stand-in).
    const attackerOnlyDefinitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[createUnitDefinitionId(ATTACKER_UNIT_ID), [attackerSkill()]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [createEffectActionDefinitionId(ATTACKER_EFFECT_ID), attackerEffectAction()],
      ]),
      unitDefinitions: new Map([
        [createUnitDefinitionId(ATTACKER_UNIT_ID), testUnitDefinition(ATTACKER_UNIT_ID, 20)],
        [createUnitDefinitionId(ENEMY_UNIT_ID), testUnitDefinition(ENEMY_UNIT_ID, 5)],
      ]),
      skillDefinitions: new Map([[createSkillDefinitionId(ATTACKER_AS_ID), attackerSkill()]]),
    };
    const attacker = createBattleUnit(
      member("ally:attacker", ATTACKER_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
      "ALLY",
      LIMITS,
    );
    const enemy = createBattleUnit(
      member("enemy:1", ENEMY_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );
    const battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [attacker],
        [enemy],
        createTurnLimit(1),
        attackerOnlyDefinitions,
      ),
      new SequenceRandomSource([]),
      new EventRecorder(createBattleId("B_1")),
    );
    const turnRecorder = new EventRecorder(createBattleId("B_1"));
    advanceBattle(battle, new SequenceRandomSource([]), turnRecorder);

    const skillUseStarting = turnRecorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "SkillUseStarting" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === ATTACKER_AS_ID,
      );
    expect(skillUseStarting).toBeDefined();
    expect((skillUseStarting!.payload as { skillType: string }).skillType).toBe("AS");

    // Step 2: feed that REAL emitted event into `detectPassiveCandidates`
    // (R-PS-01) together with Suiran's REAL, unmodified `UnitDefinition`/
    // `SkillDefinition` loaded from production `catalog/`, positioned so the
    // attacker is "in front of" Suiran (R-POS-02, POSITION_RELATION).
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([SUIRAN_UNIT_ID as never], []);
    const suiranUnitDefinition = snapshot.units.get(SUIRAN_UNIT_ID as never);
    expect(suiranUnitDefinition).toBeDefined();
    expect(suiranUnitDefinition!.passiveSkillDefinitionIds).toContain(SUIRAN_PS3_ID);

    const suiran = createBattleUnit(
      member("ally:suiran", SUIRAN_UNIT_ID, "ALLY", { column: "LEFT", row: "BACK" }),
      "ALLY",
      LIMITS,
    );
    const unitDefinitions = new Map(snapshot.units);
    unitDefinitions.set(
      createUnitDefinitionId(ATTACKER_UNIT_ID),
      testUnitDefinition(ATTACKER_UNIT_ID, 20),
    );
    unitDefinitions.set(
      createUnitDefinitionId(ENEMY_UNIT_ID),
      testUnitDefinition(ENEMY_UNIT_ID, 5),
    );

    const triggerEvent: TriggerCandidateEvent = {
      eventType: skillUseStarting!.eventType,
      category: skillUseStarting!.category === "DIAGNOSTIC" ? "FACT" : skillUseStarting!.category,
      ...(skillUseStarting!.sourceUnitId !== undefined
        ? { sourceUnitId: skillUseStarting!.sourceUnitId }
        : {}),
      ...(skillUseStarting!.targetUnitIds !== undefined
        ? { targetUnitIds: skillUseStarting!.targetUnitIds }
        : {}),
      payload: skillUseStarting!.payload,
    };

    const candidates = detectPassiveCandidates({
      event: triggerEvent,
      units: [suiran, attacker, enemy],
      unitDefinitions,
      skillDefinitions: snapshot.skills,
      activationGuard: createEmptyPassiveActivationGuard(),
    });

    const ps3Candidate = candidates.find(
      (candidate) => candidate.skillDefinition.skillDefinitionId === SUIRAN_PS3_ID,
    );
    expect(ps3Candidate).toBeDefined();
    expect(ps3Candidate!.unit.battleUnitId).toBe(suiran.battleUnitId);
  });
});
