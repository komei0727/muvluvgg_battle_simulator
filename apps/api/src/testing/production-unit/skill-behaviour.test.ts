import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../fixtures/index.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  SUBJECT_ID,
} from "./skill-behaviour.js";

/**
 * 共通ハーネス自身の回帰テスト。ユニット効果軸の `-003`（実行ベース網羅監査）は
 * 「そのユニットのテストが実際に実行したEffectAction」を数えるが、その数え方が
 * 壊れても production 定義側のテストは成功し続けてしまう。数え方そのものと、
 * 前提状態の作り方が持つ2つの性質をここで固定する。
 *
 * 検証にはドロテアを使う。`ACT_DOROTHEA_GRACE_AS1_STUN`（自身へ気絶）と
 * `ACT_DOROTHEA_GRACE_PS1_GUARD`（自身へ被ダメージ減）が、どちらも自身へ効果を
 * 付与する実 production 定義であり、前提アクションの素材にちょうどよい。
 */

const UNIT_DEFINITION_ID = "UNIT_DOROTHEA_GRACE";
const SELF_STUN_ID = "ACT_DOROTHEA_GRACE_AS1_STUN";
const SELF_GUARD_ID = "ACT_DOROTHEA_GRACE_PS1_GUARD";
const EX_SKILL_ID = "SKL_DOROTHEA_GRACE_EX";
const EX_DAMAGE_ID = "ACT_DOROTHEA_GRACE_EX_DAMAGE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

describe("production-unit skill behaviour harness", () => {
  it("UT-SKILL-BEHAVIOUR-001: an EffectAction executed only as a preceding action is not counted as execution coverage", () => {
    // 前提アクションはスキルの対象選択・分岐・発動条件を通さずEffectAction 1件を
    // 直接撃つ。これを網羅の実績に数えると、production スキル側では一度も適用され
    // ないActionを前提で撃つだけで `-003` を通せてしまう。
    resetExecutedActionIds();

    observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: EX_SKILL_ID },
      precedingActions: [{ effectActionDefinitionId: SELF_STUN_ID, target: "SELF" }],
    });

    const executed = collectedExecutedActionIds();
    // 観測対象のスキル使用で適用されたActionは数える。
    expect(executed.has(EX_DAMAGE_ID)).toBe(true);
    // 前提でしか実行していないActionは数えない。
    expect(executed.has(SELF_STUN_ID)).toBe(false);
  });

  it("UT-SKILL-BEHAVIOUR-002: two preceding actions grant effects with distinct runtime instance IDs", () => {
    // `EventRecorder` は effectInstanceId を内部カウンタから発番する。前提アクション
    // ごとにRecorderを作り直すとカウンタが1から再開し、baselineへ同一instance IDの
    // 効果が並んで、解除・リンク・消費が実戦闘に存在しない状態で評価される。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const baseline = applyPrecedingActions(board, [
      { effectActionDefinitionId: SELF_STUN_ID, target: "SELF" },
      { effectActionDefinitionId: SELF_GUARD_ID, target: "SELF" },
    ]);

    const subject = baseline.find((unit) => unit.battleUnitId === SUBJECT_ID);
    expect(subject).toBeDefined();
    expect(subject!.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual([
      SELF_STUN_ID,
      SELF_GUARD_ID,
    ]);
    const instanceIds = subject!.appliedEffects.map((effect) => effect.effectInstanceId);
    expect(new Set(instanceIds).size).toBe(instanceIds.length);
  });
});
