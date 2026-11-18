import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { createEffectActionDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";

/**
 * 命中条件（R-SKL-06 #4a）の前提として、敵に「攻撃を回避する」状態を持たせる。
 * 回避そのものは検証対象ではないため、乱数を消費しない確率1の`EVASION`を手組みする。
 *
 * - `hits`省略: 消費なし。何ヒットでも全て回避する
 * - `hits`指定: `INCOMING_HIT`消費。先頭から`hits`ヒットだけ回避し、以降は命中する
 *   （「最後のヒットだけ命中」「Nヒット中M命中」を乱数列なしで作る）
 */
export function evasionOf(holderId: string, hits?: number): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_TEST_EVASION");
  return {
    effectInstanceId: createEffectInstanceId(`TEST_EVASION_${holderId}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId(holderId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "EVASION",
    statusDetails: { probability: 1 },
    duration:
      hits === undefined
        ? { definition: { dispellable: true, linkedEffectGroupId: null } }
        : {
            definition: {
              consumption: { kind: "INCOMING_HIT", maxCount: hits },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            consumptionRemaining: hits,
          },
    appliedTurnNumber: 1,
  };
}
