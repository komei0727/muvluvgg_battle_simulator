import { requireUnit } from "./action-resolution-shared.js";
import { resetRuntimeCounter } from "../model/runtime-counter-state.js";
import { collectResolutionScopeResets } from "../triggering/runtime-counter-matcher.js";
import type { ActiveEffectSequenceResolution } from "../triggering/effect-sequence-runtime-counter-matcher.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ResolutionResult } from "./resolution-result.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { SkillDefinitionId, UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { ExecutionGuardExceededError } from "../../shared/errors.js";

/**
 * `finalizeResolutionScope`の「破棄→発行→候補解決」反復に対する上限。
 * counter更新は`PassiveActivationGuard`
 * （R-PS-07）を経由しないため、`DEFAULT_PASSIVE_CHAIN_LIMITS`だけでは
 * 自己再生成する`resetScope`counterの無限ループを検出できない。対象12行は
 * いずれも`resetScope`を宣言しないため通常は1周も要さず、この上限に
 * 到達すること自体が誤ったCatalog定義を示す。
 */
const MAX_RESOLUTION_SCOPE_RESET_ROUNDS = 10;

/**
 * `beginEffectSequenceResolution`/`finalizeEffectSequenceResolution(Steps)`/
 * `finalizeResolutionScope`が発行するイベントに共通する因果関係コンテキスト。
 * `PassiveActivationRuntime`が1解決スコープぶん保持するenvelope値をそのまま渡す。
 */
export interface ResolutionScopeLifecycleContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * EFF-006: 呼び出し側（`action-skill-use-resolver.ts`のAS/EX、
 * `action-charge-resolver.ts`のチャージ解放、この行動専用`activatePassiveCandidate`
 * のPS自身のEffectSequence）が、これから解決する1つのEffectSequenceが宣言する
 * `counterUpdates`（あれば）を登録する。`skillUseId`はその解決を一意に識別する
 * 既存の実行時識別子であり、`EFFECT_SEQUENCE`スコープのcounterの保持先キーにも
 * そのまま使う。`counterUpdates`が空配列でも登録して構わない（マッチ対象が
 * 無いだけで、`finalizeEffectSequenceResolution`の呼び出しは省略できない —
 * 呼び出し側は毎回対で呼ぶ契約にした方が単純なため）。
 */
export function beginEffectSequenceResolution(
  activeEffectSequenceResolutions: Map<SkillUseId, ActiveEffectSequenceResolution>,
  skillUseId: SkillUseId,
  actorUnitId: BattleUnitId,
  skillDefinitionId: SkillDefinitionId,
  counterUpdates: readonly RuntimeCounterUpdateDefinition[],
): void {
  activeEffectSequenceResolutions.set(skillUseId, {
    actorUnitId,
    skillDefinitionId,
    counterUpdates,
  });
}

/**
 * EFF-006: `EffectSequence`は状態を持たないため、1回の解決が
 * 完了した時点で必ずそのcounterを破棄する（`SkillRuntime`の
 * `resetScope: "RESOLUTION_SCOPE"`と異なり、宣言による選択の余地がない）。
 * `activeEffectSequenceResolutions`からエントリ自体を先に削除してから
 * 破棄・`RuntimeCounterReset`発行を行う — この順序により、`RuntimeCounterReset`
 * 自身を再誘発契機にする誤ったCatalog定義（`R-EFF-11`が警告する自己再生成
 * パターン）があっても、削除済みの解決に対しては`applyEffectSequenceRuntimeCounterUpdates`
 * が何もマッチさせられないため、無限ループが原理的に起こらない
 * （`finalizeResolutionScope`の反復回数上限とは異なる安全策）。
 * `resolveChild`が呼ばれる前に最新の`units`へ書き込む点、複数counterを1件ずつ
 * 発行・解決する点は既存パターンと同じ——呼び出し元（`resolveEvent`自身への
 * 再帰、またはトップレベルの`finalizeEffectSequenceResolution`）が各yieldの
 * 直後にその候補解決を終えてから次のcounterへ進むため、`getUnits`/`setUnits`で
 * その副作用を都度読み書きする。
 */
export function* finalizeEffectSequenceResolutionSteps(
  context: ResolutionScopeLifecycleContext,
  activeEffectSequenceResolutions: Map<SkillUseId, ActiveEffectSequenceResolution>,
  getUnits: () => readonly BattleUnit[],
  setUnits: (units: readonly BattleUnit[]) => void,
  skillUseId: SkillUseId,
): Generator<BattleDomainEvent, void, void> {
  const resolution = activeEffectSequenceResolutions.get(skillUseId);
  activeEffectSequenceResolutions.delete(skillUseId);
  if (resolution === undefined) {
    return;
  }
  const actor = requireUnit(getUnits(), resolution.actorUnitId);
  const counters = actor.effectSequenceCounters?.[skillUseId] ?? {};
  for (const counterId of Object.keys(counters) as (keyof typeof counters)[]) {
    const currentActor = requireUnit(getUnits(), resolution.actorUnitId);
    const currentCounters = currentActor.effectSequenceCounters?.[skillUseId] ?? {};
    const result = resetRuntimeCounter(currentCounters, counterId);
    if (result === undefined) {
      continue;
    }
    const carryBefore = currentCounters[counterId]?.carry ?? 0;
    // `effectSequenceCounters`は`skillCounters`と異なり、この
    // 解決が完了したら`skillUseId`エントリ自体も完全に消す（空の`{}`を
    // 残す既存の非対称な規約を流用しない — `captureBattleState`/
    // `applyTwoLevelCounterDeltas`（`pruneEmptyFirstLevelEntries`）が実状態と
    // 一致させるためにも、最後のcounterを消した時点でキー自体を削除する）。
    const nextEffectSequenceCounters = { ...currentActor.effectSequenceCounters };
    if (Object.keys(result.counters).length === 0) {
      delete nextEffectSequenceCounters[skillUseId];
    } else {
      nextEffectSequenceCounters[skillUseId] = result.counters;
    }
    const hasRemainingEntries = Object.keys(nextEffectSequenceCounters).length > 0;
    const { effectSequenceCounters: _omit, ...actorWithoutCounters } = currentActor;
    const updatedActor: BattleUnit = hasRemainingEntries
      ? { ...actorWithoutCounters, effectSequenceCounters: nextEffectSequenceCounters }
      : actorWithoutCounters;
    setUnits(
      getUnits().map((u) => (u.battleUnitId === updatedActor.battleUnitId ? updatedActor : u)),
    );
    const recorded = context.recorder.record({
      eventType: "RuntimeCounterReset",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: context.rootEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: resolution.actorUnitId,
      payload: {
        ownerUnitId: resolution.actorUnitId,
        scope: "EFFECT_SEQUENCE",
        counter: counterId,
        skillDefinitionId: resolution.skillDefinitionId,
        before: result.change.before,
      },
      stateDelta: {
        units: {
          [resolution.actorUnitId]: {
            effectSequenceCounters: {
              [skillUseId]: { [counterId]: { before: result.change.before, after: undefined } },
            },
            ...(carryBefore !== 0
              ? {
                  effectSequenceCounterCarry: {
                    [skillUseId]: { [counterId]: { before: carryBefore, after: undefined } },
                  },
                }
              : {}),
          },
        },
      },
    });
    yield recorded;
  }
}

/**
 * EFF-006: `finalizeEffectSequenceResolutionSteps`のトップレベル
 * 版。呼び出し側（AS/EX使用・チャージ解放）が、1つのEffectSequenceの解決
 * （`applyEffectActionGroups`の戻り）を受け取った直後に必ず1回呼ぶ。各
 * `RuntimeCounterReset`を`onFactEventForPassiveChain`（呼び出し元の
 * `onFactEvent`再帰）へ渡し、その候補解決を完全に終えてから次のcounterへ
 * 進む（`finalizeResolutionScope`と同じトップレベル専用の駆動方法 — PS連鎖
 * 内部からはこの関数を呼んではならない、代わりに
 * `finalizeEffectSequenceResolutionSteps`を`yield*`委譲すること）。
 */
export function finalizeEffectSequenceResolution(
  context: ResolutionScopeLifecycleContext,
  activeEffectSequenceResolutions: Map<SkillUseId, ActiveEffectSequenceResolution>,
  getUnits: () => readonly BattleUnit[],
  setUnits: (units: readonly BattleUnit[]) => void,
  skillUseId: SkillUseId,
  onFactEventForPassiveChain: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[],
): readonly BattleUnit[] {
  for (const recorded of finalizeEffectSequenceResolutionSteps(
    context,
    activeEffectSequenceResolutions,
    getUnits,
    setUnits,
    skillUseId,
  )) {
    setUnits(onFactEventForPassiveChain(recorded, getUnits()));
  }
  return getUnits();
}

/**
 * `R-EFF-11`「解決スコープ終了時にリセットするcounter」。呼び出し側
 * （`resolveSkillUse`／charge解放／`advanceBattle`の
 * `TurnStarted`処理など、このインスタンスが担当する1解決スコープを完全に終えた
 * 箇所）が、そのスコープ内の最後の`onFactEvent`呼び出し後に必ず1回呼び出す。
 * `resetScope: "RESOLUTION_SCOPE"`を宣言し現在値を持つcounterを破棄して
 * `RuntimeCounterReset`を発行し、その候補解決（`onFactEventForPassiveChain`
 * 経由、トップレベルの呼び出しのため安全）を行う。この候補解決が同じスコープへ
 * 新しい対象counterを生成・更新した場合は、リセット対象counterが残らなくなる
 * まで「破棄→発行→候補解決」を繰り返す。対象12行はいずれも`resetScope`を
 * 宣言しないため、この処理は常に即座に`units`をそのまま返す。
 *
 * `resetScope: RESOLUTION_SCOPE`のcounterが、自身の
 * `RuntimeCounterReset`をtriggerとする`counterUpdates`を持つ場合
 * （破棄→発行→その候補解決で同じcounterが即座に再生成される）、このwhileは
 * 決して`targets`が空にならず同期的に無限ループする。counter更新はPS発動
 * 済みGuard（`R-PS-07`）を通らないため、既存のPassiveChainLimitsもこの
 * ループ自体を止めない。反復回数の上限を設け、超過時は黙って打ち切る代わりに
 * 決定的なエラーとして検出する。
 *
 * 呼び出し側がこの解決スコープへ入る直前に保持していた因果
 * カーソル（`cursor`）を引数で受け取り、戻り値は`onFactEvent`と同じ
 * `ResolutionResult`（`units`と確定値の`lastEventId`）で統一する。
 * `recorder.getEvents()`の末尾を呼び出し側が推測する方式は採らない。
 *
 * 何も破棄しなかった場合（対象12行のように`resetScope`を宣言しない場合が
 * 常時これに該当）、この呼び出し自身は何も発行していない——受け取った
 * `cursor`をそのまま`lastEventId`として返し、呼び出し側が保持していた
 * 因果カーソルを無関係な`rootEventId`で上書きしない。
 *
 * 何か破棄・発行した場合は、`onFactEventForPassiveChain()`が返す`lastEventId`
 * （`RuntimeCounterReset`自身がPS/Memory候補を発動させた場合はその候補連鎖・
 * 付随する効果適用まで含めた実際の終端イベント）をそのまま採用する。
 */
export function finalizeResolutionScope(
  context: ResolutionScopeLifecycleContext,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  units: readonly BattleUnit[],
  cursor: DomainEventId,
  onFactEventForPassiveChain: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => ResolutionResult,
): ResolutionResult {
  let currentUnits = units;
  let lastEventId: DomainEventId = cursor;
  let round = 0;
  while (true) {
    const targets = collectResolutionScopeResets({
      units: currentUnits,
      unitDefinitions,
      skillDefinitions,
    });
    if (targets.length === 0) {
      return { units: currentUnits, lastEventId };
    }
    round += 1;
    if (round > MAX_RESOLUTION_SCOPE_RESET_ROUNDS) {
      throw new ExecutionGuardExceededError(
        `finalizeResolutionScope exceeded ${MAX_RESOLUTION_SCOPE_RESET_ROUNDS} discard/emit/resolve rounds; a counterUpdates definition likely re-triggers its own resetScope: RESOLUTION_SCOPE counter from the RuntimeCounterReset event it causes (infinite regeneration)`,
      );
    }
    for (const target of targets) {
      const owner = requireUnit(currentUnits, target.ownerUnitId);
      const counters = owner.skillCounters?.[target.skillDefinitionId] ?? {};
      // 破棄されるcarryもstateDeltaへ含めるため、
      // `resetRuntimeCounter`が削除する前に読み取っておく。
      const carryBefore = counters[target.counter]?.carry ?? 0;
      const result = resetRuntimeCounter(counters, target.counter);
      if (result === undefined) {
        continue;
      }
      const updatedOwner: BattleUnit = {
        ...owner,
        skillCounters: { ...owner.skillCounters, [target.skillDefinitionId]: result.counters },
      };
      currentUnits = currentUnits.map((u) =>
        u.battleUnitId === owner.battleUnitId ? updatedOwner : u,
      );
      const recorded = context.recorder.record({
        eventType: "RuntimeCounterReset",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        resolutionScopeId: context.resolutionScopeId,
        parentEventId: context.rootEventId,
        rootEventId: context.rootEventId,
        sourceUnitId: target.ownerUnitId,
        payload: {
          ownerUnitId: target.ownerUnitId,
          scope: "SKILL_RUNTIME",
          counter: target.counter,
          skillDefinitionId: target.skillDefinitionId,
          before: result.change.before,
        },
        stateDelta: {
          units: {
            [target.ownerUnitId]: {
              skillCounters: {
                [target.skillDefinitionId]: {
                  // `after: 0`ではなく`undefined`にして、
                  // 独立Reducerがキー自体を削除できるようにする（実状態の
                  // `resetRuntimeCounter`と同じく、値0で残すのではなく削除）。
                  [target.counter]: { before: result.change.before, after: undefined },
                },
              },
              // carryが実際に非0だった場合だけ
              // `skillCounterCarry`を持つ（0のcarryは元々`captureBattleState`
              // が省略するキーのため、削除する意味のある差分がない）。
              ...(carryBefore !== 0
                ? {
                    skillCounterCarry: {
                      [target.skillDefinitionId]: {
                        [target.counter]: { before: carryBefore, after: undefined },
                      },
                    },
                  }
                : {}),
            },
          },
        },
      });
      const resolved = onFactEventForPassiveChain(recorded, currentUnits);
      currentUnits = resolved.units;
      lastEventId = resolved.lastEventId;
    }
  }
}
