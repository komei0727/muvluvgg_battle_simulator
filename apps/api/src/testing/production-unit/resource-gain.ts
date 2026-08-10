import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import { createBattleId } from "../../domain/shared/ids.js";
import { noMissNoCrit } from "../fixtures/index.js";

/**
 * ユニット効果軸の `-004` 以降が使う「保持している `APPLY_RESOURCE_GAIN_MOD` が、
 * **以後の自分の行動**で得るEXゲージをどう変えるか」を観測するハーネス。
 *
 * このCapabilityは「付与されたか」ではなく「以後のリソース獲得量が変わるか」でしか
 * 完了を判定できない（G-05／R-ACT-03）。付与そのものは `-001` の振る舞い表が
 * `effectsApplied` の `magnitude` と期間まで固定するが、**獲得側の行動は別のスキル
 * 使用**であり、スキル使用1回の観測には構造的に載らない。
 *
 * 補正を配る側（舞亜・カリナ）と獲得する側（そのASを使うユニット）が別ユニットに
 * あるため、この観測は関係する全ユニットのファイルから呼ばれる（retire基準3）。
 * 組み立てをここへ集約し、複製は宣言だけに留める。
 */

/** `ActionStarted` が公開するEXゲージの変化前後（増加が0でも必ず現れる）。 */
export interface ObservedExGaugeGain {
  readonly before: number;
  readonly after: number;
  readonly gained: number;
}

/**
 * `ResourceChanged`（`reason: EX_GAIN`）payload。補正前の `baseDelta`（R-ACT-03より
 * 消費APと同量）と補正後の `delta` を同じ1件で公開するため、「補正が効いた」ことと
 * 「基礎量そのものは動いていない」ことをここで分けられる。
 * **増加が0になった行動では発行されない**ため、その場合は `null` になる。
 */
export interface ObservedPublishedGain {
  readonly baseDelta: number;
  readonly delta: number;
  readonly before: number;
  readonly after: number;
}

/** 行動者が保持している `APPLY_RESOURCE_GAIN_MOD` を由来定義ごとにまとめたもの。 */
export interface ObservedGainModifier {
  readonly effectActionDefinitionId: string;
  /** 付与時点で評価済みの `rateDelta`（`AppliedEffect.magnitude`）。 */
  readonly magnitude: number;
  /** 同じ定義を何インスタンス保持しているか（`STACKABLE` は全件が合算される）。 */
  readonly instances: number;
}

export interface ExGaugeGainOptions {
  readonly units: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
  /** 行動者が実際に使う実 `catalog/` のAS。消費APがそのまま基礎量になる。 */
  readonly skill: SkillDefinition;
  readonly actorUnitId: string;
  readonly battleId?: string;
}

export interface ExGaugeGainObservation {
  readonly gain: ObservedExGaugeGain;
  readonly published: ObservedPublishedGain | null;
  readonly modifiers: readonly ObservedGainModifier[];
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
}

function modifiersOf(
  actor: BattleUnit,
  definitions: BattleDefinitions,
): readonly ObservedGainModifier[] {
  const counted = new Map<string, ObservedGainModifier>();
  for (const effect of actor.appliedEffects) {
    const definition = definitions.effectActions.get(effect.effectActionDefinitionId);
    if (definition === undefined || definition.kind !== "APPLY_RESOURCE_GAIN_MOD") {
      continue;
    }
    const key = String(effect.effectActionDefinitionId);
    counted.set(key, {
      effectActionDefinitionId: key,
      magnitude: effect.magnitude,
      instances: (counted.get(key)?.instances ?? 0) + 1,
    });
  }
  return [...counted.values()];
}

/**
 * `actorUnitId` に実ASを1回使わせ、その行動が公開したEXゲージ獲得と、行動者が
 * 保持している獲得量補正を返す。
 */
export function observeExGaugeGain(options: ExGaugeGainOptions): ExGaugeGainObservation {
  const actor = options.units.find((unit) => unit.battleUnitId === options.actorUnitId);
  if (actor === undefined) {
    throw new Error(`no actor "${options.actorUnitId}" on the board`);
  }
  const recorder = new EventRecorder(createBattleId(options.battleId ?? "B_EX_GAIN"));
  const result = resolveSkillUse(
    actor,
    options.skill,
    "AS",
    "AS",
    options.units,
    options.definitions,
    noMissNoCrit(),
    recorder,
    1,
    1,
    recorder.nextActionId(),
    recorder.nextResolutionScopeId(),
  );
  const events = recorder.getEvents();
  const started = events.find(
    (event): event is Extract<BattleDomainEvent, { eventType: "ActionStarted" }> =>
      event.eventType === "ActionStarted" && event.payload.actorUnitId === actor.battleUnitId,
  );
  if (started === undefined) {
    throw new Error(`"${options.actorUnitId}" never started an action`);
  }
  const published = events.find(
    (event): event is Extract<BattleDomainEvent, { eventType: "ResourceChanged" }> =>
      event.eventType === "ResourceChanged" &&
      event.payload.reason === "EX_GAIN" &&
      event.payload.battleUnitId === actor.battleUnitId,
  );
  return {
    gain: {
      before: started.payload.exBefore,
      after: started.payload.exAfter,
      gained: started.payload.exAfter - started.payload.exBefore,
    },
    published:
      published === undefined
        ? null
        : {
            baseDelta: published.payload.baseDelta,
            delta: published.payload.delta,
            before: published.payload.before,
            after: published.payload.after,
          },
    modifiers: modifiersOf(actor, options.definitions),
    units: result.units,
    recorder,
  };
}
