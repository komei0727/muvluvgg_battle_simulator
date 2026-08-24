import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { applyEffectActionGroups } from "../../domain/battle/resolution/effect-action-group-resolver.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import { effectActionGroupContext } from "../fixtures/index.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
  type PassiveChain,
} from "./passive-activation.js";

/**
 * 実 production の `EffectActionDefinition` 1件を、名指しした相手へ**実 resolver**
 * （`applyEffectActionGroups`）で付与し、そこから発行された本物の `EffectApplied`
 * を返す。
 *
 * 「効果が付与された際」を契機にするPSは `EffectApplied` payload の分類欄
 * （`effectKind`／`categories`／`statusKind`）を読む。この欄は付与サービスが
 * 分類器（`effect-category-classifier.ts`）を通して初めて載るため、payload を
 * 手組みすると「実装が実際にどう分類したか」を一切確かめられない — 状態異常が
 * `DEBUFF` と `STATUS` の**両方**を受け取ること（R-STS-01）、`APPLY_STATUS` でも
 * 保持者に有利な効果は `STATUS` を受け取らないこと、被ダメージ補正（`INCOMING`）の
 * バフ／デバフが `magnitude` の符号ではなく向きで決まることは、いずれも
 * 実装側にしか無い判断である。
 *
 * 対象は実 selector 語彙（`POSITION_SLOT`、盤面の1スロットには1体しか居ないので
 * 一意）で名指しする。対象選択の妥当性は `-001` の振る舞い表が持つ責務であり、
 * ここでは「誰へ付与したか」を前提として固定したい。
 */
const APPLY_SKILL_ID = "SKL_TEST_TRIGGER_APPLY";
const APPLY_BINDING_ID = "TGT_TEST_TRIGGER_APPLY";

/** `EffectApplied` payload のうち、契機の判定に使われる分類欄だけ。 */
export interface ObservedEffectClassification {
  readonly effectKind: string;
  readonly categories: readonly string[];
  /** `APPLY_STATUS` 由来の付与だけが持つ。 */
  readonly statusKind?: string;
}

export interface ProductionEffectApplication {
  /** 付与後の盤面。 */
  readonly units: readonly BattleUnit[];
  /** 実 resolver が発行した `EffectApplied` そのもの。 */
  readonly event: BattleDomainEvent;
  readonly classification: ObservedEffectClassification;
  /** 付与が出し終えた位置（呼び出し側が以後のイベントだけを見るための境界）。 */
  readonly eventsAfter: number;
}

export interface ApplyProductionEffectOptions {
  /** 付与を記録する行動envelope。発行された `EffectApplied` はこの中に入る。 */
  readonly chain: PassiveChain;
  readonly definitions: BattleDefinitions;
  readonly units: readonly BattleUnit[];
  /** 付与する production EffectAction。効果量は実 Formula 評価に任せる。 */
  readonly effectActionDefinitionId: string;
  /** 付与する側。`EffectApplied.sourceUnitId` になり `sourceSelector` が読む。 */
  readonly from: string;
  /** 付与される側。`targetSelector` が読む。 */
  readonly to: string;
}

function unitOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  const found = units.find((unit) => unit.battleUnitId === battleUnitId);
  if (found === undefined) {
    throw new Error(`no unit "${battleUnitId}" on the board`);
  }
  return found;
}

/**
 * 名指しした1体だけを対象に取り、`effectActionDefinitionIds` を**同じACTION step**へ
 * 定義順に並べた合成スキル。同じstepに置くことで「同じ行動で配られた効果」という
 * 前提（免疫が一方だけを弾く形）を実 resolver の上で作れる。
 */
function singleTargetSkill(
  source: BattleUnit,
  target: BattleUnit,
  effectActionDefinitionIds: readonly string[],
): SkillDefinition {
  const binding = createTargetBindingId(APPLY_BINDING_ID);
  return {
    skillDefinitionId: createSkillDefinitionId(APPLY_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 0 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: binding,
          selector: {
            kind: "SELECT",
            side: source.side === target.side ? "ALLY" : "ENEMY",
            count: 1,
            filters: [
              { kind: "POSITION_SLOT", row: target.position.row, column: target.position.column },
            ],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: binding },
          actions: effectActionDefinitionIds.map((id) => ({
            effectActionDefinitionId: createEffectActionDefinitionId(id),
          })),
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
    metadata: { displayName: APPLY_SKILL_ID, tags: [] },
  };
}

export function applyProductionEffect(
  options: ApplyProductionEffectOptions,
): ProductionEffectApplication {
  const source = unitOf(options.units, options.from);
  const target = unitOf(options.units, options.to);
  const skill = singleTargetSkill(source, target, [options.effectActionDefinitionId]);
  const definitions: BattleDefinitions = {
    ...options.definitions,
    skillDefinitions: new Map(options.definitions.skillDefinitions).set(
      skill.skillDefinitionId,
      skill,
    ),
  };
  const plan = resolveSkillOrder(
    skill,
    source,
    options.units,
    definitions.effectActions,
    undefined,
    definitions.unitDefinitions,
  );
  if (plan.targetUnitIds.length !== 1 || plan.targetUnitIds[0] !== options.to) {
    throw new Error(
      `the slot filter resolved to [${plan.targetUnitIds.join(", ")}] instead of "${options.to}"`,
    );
  }
  const applied = applyEffectActionGroups(
    plan,
    options.units,
    effectActionGroupContext({
      actor: source,
      skillId: APPLY_SKILL_ID,
      definitions,
      recorder: options.chain.recorder,
      rootEventId: options.chain.rootEventId,
      // 付与も行動envelopeの中で起きたことにする（`EffectApplied` の `actionId`／
      // `resolutionScopeId` を実戦闘と同じ形に保つ）。
      extras: { actionId: options.chain.actionId, actionScope: options.chain.resolutionScopeId },
    }),
  );
  const event = options.chain.eventsOfType("EffectApplied").at(-1);
  if (event === undefined) {
    throw new Error(
      `applying "${options.effectActionDefinitionId}" to "${options.to}" emitted no EffectApplied`,
    );
  }
  const payload = event.payload as {
    readonly effectKind: string;
    readonly categories: readonly string[];
    readonly statusKind?: string;
  };
  return {
    units: applied.units,
    event,
    classification: {
      effectKind: payload.effectKind,
      categories: [...payload.categories],
      ...(payload.statusKind === undefined ? {} : { statusKind: payload.statusKind }),
    },
    eventsAfter: options.chain.recorder.getEvents().length,
  };
}

/** `EffectApplicationRejected` payload のうち、拒否の意味を決める欄だけ。 */
export interface ObservedRejection {
  readonly unitId: string;
  readonly effectActionDefinitionId: string;
  readonly reason: string;
  /** `APPLY_STATUS` 由来の拒否だけが持つ（`EffectApplied` と同じ規約）。 */
  readonly statusKind?: string;
  /** 拒否したインスタンスの由来定義。免疫が**どの付与由来か**をIDで名指しする。 */
  readonly blockedBy: string;
}

export interface EffectImmunityObservation {
  /** 実際に付与された効果（`EffectApplied` の発行順）。 */
  readonly applied: readonly string[];
  /** 免疫が拒否した効果（`EffectApplicationRejected` の発行順）。 */
  readonly rejected: readonly ObservedRejection[];
  /**
   * 観測後の免疫インスタンス自身の状態。`blockedCount` は拒否のたびに増え、
   * `maxBlocks` に達すると以後は拒否しなくなる（`duration` の失効とは独立）。
   */
  readonly immunity: {
    readonly categories: readonly string[];
    readonly statusKinds?: readonly string[];
    readonly blockedCount: number;
    readonly maxBlocks: number | null;
  };
  readonly units: readonly BattleUnit[];
}

/**
 * 免疫を持つユニットへ、実 production の EffectAction 群を**同じ1行動**で配り、
 * 通ったものと弾かれたものを分けて返す（R-EFF-03）。
 *
 * 種別限定免疫（`EFFECT_IMMUNITY.statusKinds`）の完了境界は「カテゴリ全体ではなく
 * 指定した種別だけを拒否する」ことなので、**拒否される側と拒否されない側を同じ
 * 免疫へ両方通さないと**カテゴリ丸ごとの免疫と区別がつかない。`-001` の振る舞い表は
 * 付与そのもの（`magnitude`・期間）までしか持てず、以後の攻撃で何が弾かれるかは
 * 別のスキル使用に属するため、この観測が引き受ける。
 */
export function observeEffectImmunity(options: {
  readonly definitions: BattleDefinitions;
  readonly units: readonly BattleUnit[];
  /** 免疫の保持者。 */
  readonly holder: string;
  /** 効果を配る側。 */
  readonly from: string;
  /** 同じACTION stepへ定義順に並べる production EffectAction。 */
  readonly effectActionDefinitionIds: readonly string[];
  /** 観測対象の免疫インスタンスの由来定義。 */
  readonly immunityEffectActionDefinitionId: string;
  readonly battleId?: string;
}): EffectImmunityObservation {
  const chain = openPassiveChain({
    definitions: options.definitions,
    actorUnitId: options.from,
    battleId: options.battleId ?? "B_IMMUNITY",
  });
  const source = unitOf(options.units, options.from);
  const target = unitOf(options.units, options.holder);
  const immunityBefore = target.appliedEffects.find(
    (effect) => effect.effectActionDefinitionId === options.immunityEffectActionDefinitionId,
  );
  if (immunityBefore?.immunity === undefined) {
    throw new Error(
      `"${options.holder}" holds no immunity from "${options.immunityEffectActionDefinitionId}"`,
    );
  }
  const skill = singleTargetSkill(source, target, options.effectActionDefinitionIds);
  const definitions: BattleDefinitions = {
    ...options.definitions,
    skillDefinitions: new Map(options.definitions.skillDefinitions).set(
      skill.skillDefinitionId,
      skill,
    ),
  };
  const plan = resolveSkillOrder(
    skill,
    source,
    options.units,
    definitions.effectActions,
    undefined,
    definitions.unitDefinitions,
  );
  if (plan.targetUnitIds.length !== 1 || plan.targetUnitIds[0] !== options.holder) {
    throw new Error(
      `the slot filter resolved to [${plan.targetUnitIds.join(", ")}] instead of "${options.holder}"`,
    );
  }
  const eventsBefore = chain.recorder.getEvents().length;
  const resolved = applyEffectActionGroups(
    plan,
    options.units,
    effectActionGroupContext({
      actor: source,
      skillId: APPLY_SKILL_ID,
      definitions,
      recorder: chain.recorder,
      rootEventId: chain.rootEventId,
      extras: { actionId: chain.actionId, actionScope: chain.resolutionScopeId },
    }),
  );
  const emitted = chain.recorder.getEvents().slice(eventsBefore);
  const holderAfter = unitOf(resolved.units, options.holder);
  const immunityAfter = holderAfter.appliedEffects.find(
    (effect) => effect.effectInstanceId === immunityBefore.effectInstanceId,
  );

  return {
    applied: emitted
      .filter((event) => event.eventType === "EffectApplied")
      .map((event) =>
        String((event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId),
      ),
    rejected: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectApplicationRejected" }> =>
          event.eventType === "EffectApplicationRejected",
      )
      .map((event) => ({
        unitId: String(event.payload.battleUnitId),
        effectActionDefinitionId: String(event.payload.effectActionDefinitionId),
        reason: event.payload.reason,
        ...(event.payload.statusKind === undefined ? {} : { statusKind: event.payload.statusKind }),
        blockedBy: String(
          holderAfter.appliedEffects.find(
            (effect) => effect.effectInstanceId === event.payload.blockingEffectInstanceId,
          )?.effectActionDefinitionId ?? event.payload.blockingEffectInstanceId,
        ),
      })),
    immunity: {
      categories: [...(immunityAfter?.immunity?.categories ?? [])],
      ...(immunityAfter?.immunity?.statusKinds === undefined
        ? {}
        : { statusKinds: [...immunityAfter.immunity.statusKinds] }),
      blockedCount: immunityAfter?.immunity?.blockedCount ?? 0,
      maxBlocks: immunityAfter?.immunity?.maxBlocks ?? null,
    },
    units: resolved.units,
  };
}

/** 実 `EffectApplied` 1件に対する、分類payloadと実PS経路の発動結果。 */
export interface ClassificationTriggerObservation {
  readonly classification: ObservedEffectClassification;
  /**
   * 実 `PassiveActivationRuntime` を通して実際に発動したPSのID（発動順）。
   * 候補検出（R-PS-01）だけでなく発動直前の再確認（R-PS-04）とEffectSequence解決
   * まで通した結果なので、「契機は合うが発動できない」形もここに現れる。
   */
  readonly activated: readonly string[];
}

/**
 * 「効果が付与された際」を契機にするPSを、**実 resolver が発行した `EffectApplied`
 * だけ**で駆動し、その分類payloadと発動結果を返す。
 *
 * `-001` の振る舞い表はハーネスが組み立てた契機イベント（`trigger-events.ts` の
 * `effectApplied`）を使うため、payload欄の値はテスト側の宣言でしかない。実装が
 * その効果をどう分類したかは、この経路にしか現れない。
 */
export function observeClassificationTrigger(options: {
  readonly definitions: BattleDefinitions;
  readonly units: readonly BattleUnit[];
  readonly effectActionDefinitionId: string;
  readonly from: string;
  readonly to: string;
  readonly battleId?: string;
}): ClassificationTriggerObservation {
  const chain = openPassiveChain({
    definitions: options.definitions,
    actorUnitId: options.from,
    battleId: options.battleId ?? "B_CLASSIFICATION",
  });
  const applied = applyProductionEffect({
    chain,
    definitions: options.definitions,
    units: options.units,
    effectActionDefinitionId: options.effectActionDefinitionId,
    from: options.from,
    to: options.to,
  });
  chain.fireRecorded(applied.event, applied.units);
  return { classification: applied.classification, activated: activatedPassiveSkillIds(chain) };
}
