import type { ActionId } from "../../shared/event-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";

/**
 * `06_戦闘状態遷移.md`「チャージ状態」のBattleUnit側の可変状態。凍結・気絶に
 * よるCANCELLED/FROZEN_HOLD遷移はStunned/Frozenが未実装(M7)のため対象外
 * (`13_実装計画.md`のR-SKL-05はM7で完了計上する)。凍結などによる阻害が無い前提
 * では、CHARGING/READY_TO_RELEASEを区別する必要がなく、チャージ中であること
 * 自体が「次の行動機会に発動する」ことを意味する。
 */
export interface ActiveCharge {
  readonly skill: SkillDefinition;
  readonly startedActionId: ActionId;
}
