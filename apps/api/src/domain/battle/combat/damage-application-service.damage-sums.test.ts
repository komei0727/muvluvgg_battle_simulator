import { describe, expect, it } from "vitest";
import { applyDamageAction } from "./damage-application-service.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  damageAction,
  hit,
  damageEventContext,
} from "../../../testing/fixtures/damage-application.js";

/**
 * G-10（`14_Catalog定義スキーマ.md`）／RES-003A: `applyDamageAction`が
 * 直前結果（1解決スコープ）だけでなく、EffectSequence単位（`context.skillUseId`）の
 * 累計も同じregistryへ記録することを、実executorを通して検証する。
 */
describe("applyDamageAction EffectSequence damage sums (G-10, RES-003A)", () => {
  function sumReferencingAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
    return {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_SUM_REFERENCING"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_DEALT_RATIO", sourceResult: "SUM_DAMAGE_DEALT", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
  }

  it("UT-DAMAGE-APPLICATION-017 (G-10): two DAMAGE EffectActions of the same EffectSequence accumulate into SUM_DAMAGE_DEALT, which a later formula in that sequence reads as the total", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const first = unit("FIRST", "ENEMY", { defense: 10, maximumHp: 200 });
    const second = unit("SECOND", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    const damageResults: DamageResultRegistry = new Map();
    // 同じcontextを使い回すことで`skillUseId`（=EffectSequence解決）を共有する。
    const context = damageEventContext();

    const firstResult = applyDamageAction(
      attacker,
      [hit("FIRST", 1)],
      damageAction("PREVENTED"),
      [attacker, first, second],
      random,
      { ...context, damageResults },
    );
    const secondResult = applyDamageAction(
      attacker,
      [hit("SECOND", 1)],
      damageAction("PREVENTED"),
      firstResult.units,
      random,
      { ...context, damageResults },
    );
    expect(firstResult.hits[0]!.damage).toBe(20);
    expect(secondResult.hits[0]!.damage).toBe(20);
    // 直前結果は最後の1件だけ、累計はこのEffectSequenceの合計。
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(damageResults.get(attacker.battleUnitId)?.sumDamageDealt?.get(context.skillUseId)).toBe(
      40,
    );

    const referencingResult = applyDamageAction(
      attacker,
      [hit("FIRST", 1)],
      sumReferencingAction(),
      secondResult.units,
      random,
      { ...context, damageResults },
    );
    expect(referencingResult.hits[0]!.damage).toBe(40);
  });

  it("UT-DAMAGE-APPLICATION-018 (G-10): damage produced by another EffectSequence resolution in the same action (a PS chain) stays out of the acting skill's own sum", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const passiveOwner = unit("PASSIVE_OWNER", "ALLY", { attack: 500 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 2000 });
    const random = new SequenceRandomSource([]);
    // `PassiveActivationRuntime`は1行動につき1つのregistryをPS連鎖まで共有する。
    const damageResults: DamageResultRegistry = new Map();
    const skillSequence = damageEventContext();
    const passiveSequence = damageEventContext();

    const skillHit = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, passiveOwner, target],
      random,
      { ...skillSequence, damageResults },
    );
    const passiveHit = applyDamageAction(
      passiveOwner,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      skillHit.units,
      random,
      { ...passiveSequence, damageResults },
    );
    expect(skillHit.hits[0]!.damage).toBe(20);
    expect(passiveHit.hits[0]!.damage).toBe(490);

    const referencingResult = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      sumReferencingAction(),
      passiveHit.units,
      random,
      { ...skillSequence, damageResults },
    );
    // PSが与えた490は別のEffectSequence解決に属するため、20だけを参照する。
    expect(referencingResult.hits[0]!.damage).toBe(20);
  });
});
