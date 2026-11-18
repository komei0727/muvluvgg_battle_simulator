import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { createEffectActionDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import type { StatKind } from "../../domain/catalog/definitions/catalog-enums.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";

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

/**
 * 「初撃は命中・追加攻撃は回避」のように、ヒットごとに回避の成否を変える盤面の前提。
 * `evasionOf`の`INCOMING_HIT`消費は「先頭から回避」しか作れないため、確率50%の
 * 回避を持たせ、成否を`hitRolls`の抽選列で決める。BUFF解除の検証で回避自体が解除対象に
 * ならないよう、解除不可にしておく。
 */
export function chanceEvasionOf(holderId: string): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_TEST_CHANCE_EVASION");
  return {
    effectInstanceId: createEffectInstanceId(`TEST_CHANCE_EVASION_${holderId}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId(holderId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "EVASION",
    statusDetails: { probability: 0.5 },
    duration: { definition: { dispellable: false, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

/**
 * スキル使用1回のヒットを解決順に並べた成否から、抽選列を作る。
 *
 * - `HIT`: `chanceEvasionOf`の保持者への命中（回避判定に外れ、続く会心判定にも外れる）
 * - `EVADE`: `chanceEvasionOf`の保持者が回避（会心判定は行われない）
 * - `PLAIN`: 回避効果を持たない対象への命中（会心判定だけ）
 * - `HIT_CRIT`／`CRIT`: `HIT`／`PLAIN`のうち会心になるヒット（会心率が0より大きい盤面で使う）
 * - 数値: ヒット以外の抽選（`RANDOM_BRANCH`の選択など）にその値をそのまま使う
 *
 * 末尾は会心しない値で埋める（ヒット以外の抽選が後続しても例外にしない）。
 */
export type HitRoll = "HIT" | "HIT_CRIT" | "EVADE" | "PLAIN" | "CRIT" | number;

export function hitRolls(outcomes: readonly HitRoll[]): RandomSource {
  const NO = 0.99;
  const YES = 0;
  const draws: Record<Exclude<HitRoll, number>, readonly number[]> = {
    HIT: [NO, NO],
    HIT_CRIT: [NO, YES],
    EVADE: [YES],
    PLAIN: [NO],
    CRIT: [YES],
  };
  const values = outcomes.flatMap((outcome) =>
    typeof outcome === "number" ? [outcome] : draws[outcome],
  );
  return new SequenceRandomSource([...values, ...new Array<number>(64).fill(NO)]);
}

/**
 * BUFF解除の前提。解除処理は効果の分類を定義から引くため、snapshotに載っている実定義の
 * IDで、解除可能な能力上昇を1個持たせる（効果量は検証対象ではない）。
 */
export function dispellableStatModOf(
  holderId: string,
  effectActionDefinitionId: string,
  options: {
    readonly index?: number;
    readonly category?: "BUFF" | "DEBUFF";
    /** `TARGET_HAS_EFFECT.statKinds`が読む能力種別。実定義の`payload.stat`と揃える。 */
    readonly stat: StatKind;
  },
): AppliedEffect {
  const definitionId = createEffectActionDefinitionId(effectActionDefinitionId);
  const index = options.index ?? 0;
  const category = options.category ?? "BUFF";
  return {
    effectInstanceId: createEffectInstanceId(`TEST_${category}_${index}_${holderId}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId(holderId),
    magnitude: category === "BUFF" ? 0.05 : -0.05,
    categories: [category],
    statModStat: options.stat,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}
