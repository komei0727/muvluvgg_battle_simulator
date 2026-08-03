import type { BattleUnit } from "../model/battle-unit.js";
import { absorbFromShieldPool, emitShieldConsumed } from "./shield-policy.js";
import { absorbFromNextSubUnit, emitSubUnitDamaged } from "./sub-unit-policy.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import { driveRemovalSteps, notifyOrYieldNewEvents, revalidateHit } from "./damage-hit-chain.js";
import { expireDepletedAbsorberSteps } from "./damage-effect-expiry.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/** `absorbBeforeHitPointsSteps`が返す、HP適用より前に吸収された量の内訳。 */
export interface AbsorptionBeforeHitPoints {
  /** R-SHD-02 #2: ダメージタイプに対応するタイプありシールドの吸収量。 */
  readonly typedShieldAbsorbed: number;
  /** R-SHD-02 #3: タイプなしシールドの吸収量。 */
  readonly untypedShieldAbsorbed: number;
  /** R-SHD-02 #4／R-SUB-01: サブユニットの吸収量。 */
  readonly subUnitAbsorbed: number;
  /**
   * 吸収イベント（`ShieldConsumed`/`SubUnitDamaged`）のPS/Memory連鎖が前提を崩したため、
   * 残りの吸収先へ進まずに打ち切ったことを表す。`INTERRUPT`は使用者の戦闘不能
   * （R-SKL-01「使用者が戦闘不能になった場合、未解決効果を中断する」）、`SKIP`は対象の
   * 戦闘不能（R-ACTN-01 #2）。どちらの場合も呼び出し側はHP適用と`HitPointReduced`以降の
   * イベントへ進んではならない — 既に解決した吸収だけを残してこのヒットを終える。
   */
  readonly interruption: "NONE" | "INTERRUPT" | "SKIP";
  readonly lastEventId: DomainEventId;
}

/**
 * R-SHD-02 #2〜#4（DMG-004／DMG-005）: HPへ到達する前の吸収先へ、`poolDamage`
 * （`shieldIgnoreRate`分を除いた残り）を規定の順序「タイプありシールド → タイプなし
 * シールド → サブユニット」で振り分ける。`08_ドメインイベント.md`「ダメージイベント」の
 * 並び（`DamageCalculated`→`ShieldConsumed`／`SubUnitDamaged`→`HitPointReduced`→
 * `DamageApplied`）どおり、吸収はHP適用より前に記録する。
 *
 * **プール1つ／サブユニット1体**を単位に「減少 → `ShieldConsumed`（`SubUnitDamaged`）→
 * PS/Memory即時連鎖の解決 → 枯渇分の`EffectExpired`とR-EFF-09カスケード」を完了させてから
 * 次の吸収先・HPへ進む。まとめて吸収してから通知すると、先行する吸収イベントに反応するPSが
 * 「まだ未処理のはずの後続の吸収先とHPまで変更済み」の状態を観測し、`DamageApplied`に
 * 反応するPSが残量0のシールド／サブユニットとそのlinked groupをまだ有効として観測して
 * しまう（どちらも`catalog-event-types.ts`でFACT triggerとして許可されている）。
 *
 * サブユニットはシールドの後（R-SUB-01第1項「通常シールドをすべて適用した後に
 * サブユニットがダメージを受ける」）で、タイプ区分を持たない。R-SUB-01第2項の
 * 「毒、炎上など、通常シールドで受けられないダメージはサブユニットでも受けない」は
 * 呼び出し側の責務である — `continuous-damage-service.ts`はBURN/POISONを
 * この関数へ渡さない。
 */
export function* absorbBeforeHitPointsSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  damageType: DamageType,
  poolDamage: number,
  parentEventId: DomainEventId,
  hitContext: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
  },
): Generator<DamageStep, AbsorptionBeforeHitPoints, readonly BattleUnit[] | undefined> {
  const absorbedByPool = new Map<DamageType | null, number>();
  let remaining = poolDamage;
  let lastEventId = parentEventId;
  let interruption: AbsorptionBeforeHitPoints["interruption"] = "NONE";
  /**
   * `ShieldConsumed`/`SubUnitDamaged`起点のPS/Memory即時連鎖は`working`を書き換え得る
   * （攻撃者・対象を戦闘不能にする等）。R-SKL-01/R-SKL-03の中断契約に従い、連鎖の解決後は
   * 毎回この判定を通してから次の吸収先へ進む。
   *
   * 打ち切った事実を戻り値へ載せる。残ダメージをそのままHPへ向けると、「使用者が戦闘不能に
   * なった後もそのヒットのHP適用だけは続く」というR-SKL-01違反になる。
   */
  const absorptionInterrupted = (): boolean => {
    const revalidation = revalidateHit(context, working, attackerUnitId, targetUnitId);
    if (revalidation.kind === "CONTINUE") {
      return false;
    }
    interruption = revalidation.kind;
    return true;
  };
  // 「対応しないタイプありシールドへダメージを適用しない」（R-SHD-02末尾）ため、
  // このヒットの`damageType`と一致するタイプありプールと、タイプなしプールだけを
  // この順に走査する。
  for (const shieldType of [damageType, null] as const) {
    if (remaining <= 0) {
      break;
    }
    // 直前のプールの連鎖が残量・保持者を変え得るため、そのつど最新状態から取り直す。
    const holder = working.get(targetUnitId);
    if (holder === undefined) {
      break;
    }
    const absorption = absorbFromShieldPool(holder, remaining, shieldType);
    if (absorption.change === undefined) {
      continue;
    }
    const holderAfterPool: BattleUnit = { ...holder, appliedEffects: absorption.appliedEffects };
    working.set(targetUnitId, holderAfterPool);
    remaining -= absorption.absorbed;
    absorbedByPool.set(shieldType, absorption.absorbed);

    const consumedEventsStart = context.recorder.getEvents().length;
    lastEventId = emitShieldConsumed(
      context,
      holderAfterPool,
      absorption.change,
      "DAMAGE_ABSORPTION",
      lastEventId,
      hitContext,
    );
    yield* notifyOrYieldNewEvents(context, working, consumedEventsStart);

    // R-SHD-01第3項（個別消滅条件）: このプールで使い切ったインスタンスを、
    // 次のプール・サブユニット・HPへ進む前に失効させる。
    if (absorption.change.depletedEffectInstanceIds.length > 0) {
      const expiry = yield* driveRemovalSteps(
        context,
        working,
        expireDepletedAbsorberSteps(
          context,
          Array.from(working.values()),
          targetUnitId,
          absorption.change.depletedEffectInstanceIds,
          "SHIELD_DEPLETED",
          lastEventId,
        ),
      );
      lastEventId = expiry.lastEventId;
    }
    // このプールの連鎖が攻撃者・対象を戦闘不能にしていれば、残りの吸収先へ進まない
    // （R-SKL-01/R-SKL-03）。
    if (absorptionInterrupted()) {
      return {
        typedShieldAbsorbed: absorbedByPool.get(damageType) ?? 0,
        untypedShieldAbsorbed: absorbedByPool.get(null) ?? 0,
        subUnitAbsorbed: 0,
        interruption,
        lastEventId,
      };
    }
  }

  // R-SUB-01第1項: シールドを通り抜けた残りをサブユニットへ。1体ずつ
  // 「減少→`SubUnitDamaged`→連鎖→枯渇失効」を完了してから次の1体へ進む。
  // 連鎖が新しいサブユニットを付与しても同じヒットで無限に吸収し続けないよう、
  // 進行はあくまで残ダメージが尽きるか吸収できるインスタンスが無くなるまでとし、
  // 各周回で`working`から最新の保持者を取り直す。
  let subUnitAbsorbed = 0;
  while (remaining > 0) {
    const holder = working.get(targetUnitId);
    if (holder === undefined) {
      break;
    }
    const absorption = absorbFromNextSubUnit(holder, remaining);
    if (absorption.change === undefined) {
      break;
    }
    const holderAfter: BattleUnit = { ...holder, appliedEffects: absorption.appliedEffects };
    working.set(targetUnitId, holderAfter);
    remaining -= absorption.absorbed;
    subUnitAbsorbed += absorption.absorbed;

    const damagedEventsStart = context.recorder.getEvents().length;
    lastEventId = emitSubUnitDamaged(
      context,
      holderAfter,
      absorption.change,
      "DAMAGE_ABSORPTION",
      lastEventId,
      hitContext,
    );
    yield* notifyOrYieldNewEvents(context, working, damagedEventsStart);

    if (absorption.change.depleted) {
      const expiry = yield* driveRemovalSteps(
        context,
        working,
        expireDepletedAbsorberSteps(
          context,
          Array.from(working.values()),
          targetUnitId,
          [absorption.change.effectInstanceId],
          "SUBUNIT_DEPLETED",
          lastEventId,
        ),
      );
      lastEventId = expiry.lastEventId;
    }
    // シールドプールと同じく、このサブユニットの連鎖が攻撃者・対象を戦闘不能にしていれば
    // 次の1体へ進まない（R-SKL-01/R-SKL-03）。
    if (absorptionInterrupted()) {
      break;
    }
  }

  return {
    typedShieldAbsorbed: absorbedByPool.get(damageType) ?? 0,
    untypedShieldAbsorbed: absorbedByPool.get(null) ?? 0,
    subUnitAbsorbed,
    interruption,
    lastEventId,
  };
}
