import { requireUnit } from "./action-resolution-shared.js";
import { applyCooldownManipulationAction } from "./cooldown-manipulation-application-service.js";
import { applyDamageAction } from "../combat/damage-application-service.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";

interface EffectActionGroup {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hits: ResolvedEffectApplication[];
}

/** `resolveSkillOrder` の定義順出力を、同一EffectActionDefinitionIdの連続runでまとめる。 */
function groupConsecutiveByEffectAction(
  plan: readonly ResolvedEffectApplication[],
): readonly EffectActionGroup[] {
  const groups: EffectActionGroup[] = [];
  for (const entry of plan) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.effectActionDefinitionId === entry.effectActionDefinitionId) {
      last.hits.push(entry);
    } else {
      groups.push({ effectActionDefinitionId: entry.effectActionDefinitionId, hits: [entry] });
    }
  }
  return groups;
}

/**
 * `groupConsecutiveByEffectAction`が生成したgroupを解決するために共有される
 * 因果関係コンテキスト。`action-skill-use-resolver.ts`（AS/EX使用、チャージ
 * 発動）と`passive-activation-service.ts`（PS発動）の両方が使う。両者の間で
 * 循環importを起こさないよう、`applyEffectActionGroups`自体は独立したこの
 * ファイルへ置く。
 */
export interface EffectActionGroupContext {
  readonly definitions: BattleDefinitions;
  readonly actorId: BattleUnitId;
  readonly random: RandomSource;
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** PSがターン開始・終了など行動外のトップレベルイベントから発動した場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
  /** Issue #34: DAMAGE適用の各ヒット確定直後にPS即時連鎖を解決するフック（`applyDamageAction`へ素通しする）。未指定ならPS解決を行わない。 */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

export interface EffectActionGroupsResult {
  readonly units: readonly BattleUnit[];
  /** 使用者が戦闘不能になる前に到達し、実際に処理したヒット・適用の総数。 */
  readonly resolvedCount: number;
  /**
   * PR #141再レビュー[P2]: 使用者が戦闘不能になったことで未処理のまま残った
   * ヒット・適用の総数。0より大きい場合だけが「中断」(R-SKL-01)であり、
   * 呼び出し側は`resolvedCount`/`interruptedCount`のどちらもここから得て、
   * 戦闘不能かどうかだけで中断を判定しない。
   */
  readonly interruptedCount: number;
}

/**
 * AS/EX使用（`resolveSkillUse`）とチャージ発動（`resolveChargeRelease`）、PS発動
 * （`passive-activation-service.ts`）が使う、EffectActionDefinitionId単位groupの
 * 適用ループ。Issue #129: `DAMAGE`に加えて`COOLDOWN_MANIPULATION`（対象スキルの
 * クールタイムを短縮・リセットする純粋な状態操作）を解釈する。それ以外のkindは
 * M6/M7/M8スコープのため未対応のまま拒否する。各group開始直前に使用者の最新
 * 状態を確認し、既に戦闘不能ならそのgroup以降を一切呼び出さず、EffectAction
 * 種別に関係なく残り全てを`interruptedCount`へ計上する（R-SKL-01「使用者が
 * 戦闘不能になった場合、未解決効果を中断する」）。DAMAGE group自身の最後の
 * ヒットで使用者が倒れた場合（そのgroup内には未処理ヒットが残らない）も、
 * 次のgroup開始時のこの確認で正しく検出する（PR #141再レビュー[P2] 2件目）。
 */
export function applyEffectActionGroups(
  plan: readonly ResolvedEffectApplication[],
  units: readonly BattleUnit[],
  context: EffectActionGroupContext,
): EffectActionGroupsResult {
  let working = units;
  let resolvedCount = 0;
  let interruptedCount = 0;
  for (const group of groupConsecutiveByEffectAction(plan)) {
    if (isDefeated(requireUnit(working, context.actorId))) {
      interruptedCount += group.hits.length;
      continue;
    }
    const effectAction = context.definitions.effectActions.get(group.effectActionDefinitionId);
    if (effectAction === undefined) {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `effectActionDefinitionId "${group.effectActionDefinitionId}" was not found in the given effectActions (Catalog preflight should already guarantee this reference exists)`,
      );
    }
    if (effectAction.kind === "DAMAGE") {
      const currentActor = requireUnit(working, context.actorId);
      const result = applyDamageAction(
        currentActor,
        group.hits,
        effectAction,
        working,
        context.random,
        {
          recorder: context.recorder,
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
          skillUseId: context.skillUseId,
          resolutionScopeId: context.actionScope,
          rootEventId: context.rootEventId,
          parentEventId: context.parentEventId,
          skillDefinitionId: context.skillDefinitionId,
          ...(context.onFactEventForPassiveChain !== undefined
            ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
            : {}),
        },
      );
      working = result.units;
      resolvedCount += group.hits.length - result.interruptedCount;
      interruptedCount += result.interruptedCount;
    } else if (effectAction.kind === "COOLDOWN_MANIPULATION") {
      const result = applyCooldownManipulationAction(group.hits, effectAction, working, {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        parentEventId: context.parentEventId,
        sourceUnitId: context.actorId,
      });
      working = result.units;
      // COOLDOWN_MANIPULATIONは使用者戦闘不能による中断の対象外（Issue #129
      // 時点で自傷を伴わない純粋な状態操作のため）。全件解決済みとして数える。
      resolvedCount += group.hits.length;
    } else {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `EffectAction kind other than "DAMAGE"/"COOLDOWN_MANIPULATION" is not supported by this basic turn action resolver (M6/M7/M8 scope)`,
      );
    }
  }
  return { units: working, resolvedCount, interruptedCount };
}
