import { requireUnit, type ActionResolutionResult } from "./action-resolution-shared.js";
import { resolveWait } from "./action-wait-resolver.js";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
import { resolveChargeStart, resolveChargeRelease } from "./action-charge-resolver.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import {
  createActionQueue,
  isQueueEligible,
  reorderRemainingQueue,
  type ActionReservation,
  type ReservedActionKind,
} from "../action/action-queue.js";
import { isExUsable, selectAsCandidate } from "../action/action-selection-policy.js";
import { evaluateActivationCondition } from "./activation-condition-evaluator.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import {
  activeStatusEffect,
  isDefeated,
  isFrozen,
  isStunned,
  type BattleUnit,
} from "../model/battle-unit.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ActionReservationRemovalReason } from "../events/domain-event.js";
import { resolveVictory, type VictoryResult } from "../outcome/victory-policy.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface ActionPhaseResult {
  readonly allyUnits: readonly BattleUnit[];
  readonly enemyUnits: readonly BattleUnit[];
  /** `undefined` means the phase drained naturally without a victory being resolved. */
  readonly result: VictoryResult | undefined;
}

function splitBySide(units: readonly BattleUnit[]): {
  ally: readonly BattleUnit[];
  enemy: readonly BattleUnit[];
} {
  return {
    ally: units.filter((unit) => unit.side === "ALLY"),
    enemy: units.filter((unit) => unit.side === "ENEMY"),
  };
}

/**
 * R-ACT-01/R-ACT-03: 気絶・凍結によるWAITの消費リソースは、通常のWAIT
 * （AP1消費、Q-BTL-06と同じ選択規則）と同じ「APがあれば消費し、無ければ
 * EXゲージ全量を消費する」二択に従う（R-STS-02「APがあれば待機でAPを1消費
 * する。AP 0・EX満タンならEXゲージを全量消費して待機する」）。R-ORD-01が
 * 保証する行動可能条件（AP1以上／EXゲージ満タン／チャージ発動待ち）のうち
 * 前二者のどちらかを満たす前提で、AP優先の二択だけを判定すればよい。
 */
function chooseWaitResource(actor: BattleUnit): "AP" | "EX_GAUGE" {
  return actor.currentAp >= 1 ? "AP" : "EX_GAUGE";
}

/**
 * `ActionReservationRemoved`はCatalog上・設計書上（`catalog-event-types.ts`、
 * `08_ドメインイベント.md`）トリガー可能なFACTイベントであり、他のFACTイベント
 * と同じくPS/Memory連鎖の契機になり得る（Issue #180 PRレビュー[P2]再指摘）。
 * このため`battle.ts`の`startBattle`（`BattleStarted`）と同じ形——新しい
 * `resolutionScopeId`（PS発動済み集合・候補スタックをこの除去群専用に区切る）
 * を発行し、独立した`PassiveActivationRuntime`で各`ActionReservationRemoved`
 * を`onFactEvent`へ渡してから`finalizeResolutionScope`する——で処理する。
 * `rootEventId`は除去群を引き起こした行動（`resolveOneAction`が返す
 * `resolution.rootEventId`）を維持し、監査上の因果は「この行動が引き起こした」
 * まま保つ。
 *
 * PRレビュー[P2]再々指摘: 除去対象を一括で事前計算してから順に処理すると、
 * ある除去のPS/Memory連鎖が他の予約の適格性・生死を変えても反映されない
 * （例: Bの除去PSがCの凍結を解除し適格性を戻してもCは事前リストに残ったまま
 * 誤って除去される。逆にBの除去PSがDの適格性を奪ってもDは事前リストに無く
 * 実行されてしまう。Bの除去PSがDを戦闘不能にした場合、除去理由も本来の
 * `DEFEATED`ではなく事前計算時点の`INELIGIBLE`のまま記録されてしまう）。
 * そのため`remaining`全体を対象に、除去対象と理由（戦闘不能なら`DEFEATED`、
 * それ以外でR-ORD-01を満たさなくなっていれば`INELIGIBLE`）を1件ずつ最新の
 * `units`から判定し、そのPS/Memory連鎖を解決してから次を判定し直す——
 * 除去不要な状態に落ち着くまで繰り返す。`remaining`は毎回ちょうど1件ずつ
 * 減るため、無限ループにはならない。
 *
 * PRレビュー[P2]再々々指摘: `finalizeResolutionScope()`自体が
 * `resetScope: RESOLUTION_SCOPE`のcounter破棄・`RuntimeCounterReset`発行と
 * その候補解決を行うため、ここでも`remaining`の生死・適格性が変わりうる。
 * 終了済みのruntimeは再利用できない（`finalizeResolutionScope`は1回しか
 * 意味を持たない終端操作）ため、外側のループで「1件ずつ除去→
 * finalizeResolutionScope→最新状態で再評価」を、新たな除去対象が無くなる
 * まで繰り返す。新たな除去対象が見つかった回だけ、新しい`resolutionScopeId`と
 * 独立した`PassiveActivationRuntime`を発行する。
 *
 * PRレビュー[P2]是正（Issue #180、横断整備は#251）: `finalizeResolutionScope()`が
 * 発行・解決した最後の`DomainEventId`を`lastEventId`として明示的に受け取り
 * （`recorder.getEvents()`の末尾を推測しない）、新しい除去スコープを開始する
 * 場合はその値を次の`ActionReservationRemoved.parentEventId`へ引き継ぐ。
 * これにより、`RuntimeCounterReset`のPS/Memory連鎖が原因で新たに不適格になった
 * 予約の除去イベントは、無関係な旧い除去イベントではなく、真の原因である
 * 終了処理の終端イベントを親に持つ。
 */
function removeIneligibleAndDefeatedReservations(
  remaining: readonly ActionReservation[],
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
  parentEventId: DomainEventId,
  rootEventId: DomainEventId,
): {
  readonly remaining: readonly ActionReservation[];
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
} {
  let currentRemaining = remaining;
  let working = units;
  let lastEventId = parentEventId;

  for (;;) {
    let passiveRuntime: PassiveActivationRuntime | undefined;
    const resolutionScopeId = recorder.nextResolutionScopeId();

    for (;;) {
      const next = currentRemaining.find((entry) => {
        const unit = requireUnit(working, entry.battleUnitId);
        return isDefeated(unit) || !isQueueEligible(unit);
      });
      if (next === undefined) {
        break;
      }
      const reason: ActionReservationRemovalReason = isDefeated(
        requireUnit(working, next.battleUnitId),
      )
        ? "DEFEATED"
        : "INELIGIBLE";
      passiveRuntime ??= new PassiveActivationRuntime(
        { definitions, random, recorder, turnNumber, cycleNumber, resolutionScopeId, rootEventId },
        working,
      );
      const event = recorder.record({
        eventType: "ActionReservationRemoved",
        category: "FACT",
        turnNumber,
        cycleNumber,
        resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId,
        sourceUnitId: next.battleUnitId,
        payload: { battleUnitId: next.battleUnitId, reason },
      });
      lastEventId = event.eventId;
      working = passiveRuntime.onFactEvent(event, working);
      currentRemaining = currentRemaining.filter(
        (entry) => entry.battleUnitId !== next.battleUnitId,
      );
    }

    if (passiveRuntime === undefined) {
      // この回は除去対象が最初から無かった——直前の
      // `finalizeResolutionScope`後の再評価も含め、これ以上除去すべき
      // ものは残っていない。
      break;
    }
    const finalized = passiveRuntime.finalizeResolutionScope();
    working = finalized.units;
    // PRレビュー[P2]是正の再指摘: 何も破棄・発行しなかった場合
    // （`finalized.lastEventId === undefined`）は、この因果カーソルを
    // 無関係な値で巻き戻さず、直前の`ActionReservationRemoved`のままにする。
    if (finalized.lastEventId !== undefined) {
      lastEventId = finalized.lastEventId;
    }
    // ループの先頭に戻り、finalizeResolutionScope自身のPS/Memory連鎖後の
    // 最新`working`で`currentRemaining`を再評価する。新しい除去スコープを
    // 開始する場合、その最初の`ActionReservationRemoved.parentEventId`は
    // この`lastEventId`（何か発行していれば終了処理自身の終端イベント、
    // 何も発行していなければ直前の除去イベントのまま）を引き継ぐ。
  }

  return { remaining: currentRemaining, units: working, lastEventId };
}

/**
 * `06_戦闘状態遷移.md` のDECIDING〜COMPLETINGの基本形。R-ACT-01の優先順「気絶中：
 * 待機（チャージは付与時に既にキャンセル済み、`stun-grant-service.ts`）／凍結中：
 * 待機・チャージを維持（発動待ちのチャージがあれば`ChargeHeldByFreeze`を記録）／
 * 発動待ちのチャージ効果があれば予約より優先して発動する／EX予約ならEXスキルを
 * 使用する／AS予約なら使用可能なASを選ぶ／なければ待機する」を実装する。
 * R-ACT-02「気絶、凍結などによって使用を禁止されていない」はこの優先順自体が
 * 気絶・凍結中は`selectAsCandidate`/`isExUsable`へ到達させないことで構造的に
 * 満たす。R-ACT-03の一部（AS/EXのコスト消費、通常の待機によるAP1消費、
 * `Q-BTL-06`のEXゲージ全量消費による待機、チャージ開始・発動の無消費）だけを
 * 実装する。EXゲージ増加(R-ACT-04)、PS/Memory連鎖(M6)はこの関数の対象外。
 * `ActionStarted`が自身の解決スコープを開き（`08_ドメインイベント.md`
 * 「resolutionScopeId」はActionIdと対応する）、`ActionCompleted`までの全イベント
 * がそのrootEventIdを共有する。
 */
function resolveOneAction(
  actorId: BattleUnitId,
  reservedActionType: ReservedActionKind,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
): ActionResolutionResult {
  const actor = requireUnit(units, actorId);
  const actionId = recorder.nextActionId();
  const actionScope = recorder.nextResolutionScopeId();

  // R-ACT-01 #1: 気絶中は待機する。チャージのキャンセルはSTUN付与時点
  // （`effect-action-group-resolver.ts`のAPPLY_STATUS/STUN分岐）で既に完了して
  // いるため、ここへ到達した時点で`actor.charge`は常にundefinedのはず。
  if (isStunned(actor)) {
    return resolveWait(
      actor,
      reservedActionType,
      "STUNNED",
      chooseWaitResource(actor),
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  // R-ACT-01 #2/R-SKL-05: 凍結中は待機し、発動待ちのチャージがあれば維持
  // する（キャンセルしない、解除後の次の行動機会に発動）。`ChargeHeldByFreeze`は
  // `ActionWaited`自身のPS/Memory連鎖が解決した後・`ActionCompleting`より前の
  // 時点（`onWaitEstablished`フック）で、その時点の最新`units`から判定して
  // 記録する（Issue #180 PRレビュー[P2]）——呼び出し前の`actor`スナップショット
  // を参照すると、連鎖中にチャージが変化した場合を見逃す。
  if (isFrozen(actor)) {
    return resolveWait(
      actor,
      reservedActionType,
      "FROZEN",
      chooseWaitResource(actor),
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
      (context) => {
        const currentActor = requireUnit(context.units, context.actorId);
        const freezeEffect = activeStatusEffect(currentActor, "FREEZE");
        if (currentActor.charge === undefined || freezeEffect === undefined) {
          return undefined;
        }
        return context.recorder.record({
          eventType: "ChargeHeldByFreeze",
          category: "FACT",
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          actionId: context.actionId,
          resolutionScopeId: context.resolutionScopeId,
          parentEventId: context.parentEventId,
          rootEventId: context.rootEventId,
          sourceUnitId: context.actorId,
          targetUnitIds: [context.actorId],
          payload: {
            actorUnitId: context.actorId,
            skillDefinitionId: currentActor.charge.skill.skillDefinitionId,
            startedActionId: currentActor.charge.startedActionId,
            freezeEffectInstanceId: freezeEffect.effectInstanceId,
          },
        });
      },
    );
  }

  // R-ACT-01 #3: 発動待ちのチャージ効果は予約されたAS/EXより優先して発動する。
  if (actor.charge !== undefined) {
    return resolveChargeRelease(
      actor,
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  if (reservedActionType === "EX") {
    const exSkill = definitions.exSkillByUnit.get(actor.unitDefinitionId);
    if (exSkill === undefined) {
      throw new DomainValidationError(
        "unitDefinitionId",
        `references a UnitDefinitionId absent from the given exSkillByUnit: "${actor.unitDefinitionId}"`,
      );
    }
    // R-ACT-01 #5 / Q-BTL-06: 対象候補がなければEXは使用不能とし、EXゲージ全量を
    // 消費して待機する。
    if (
      !isExUsable(exSkill, actor, units, definitions.unitDefinitions, evaluateActivationCondition)
    ) {
      return resolveWait(
        actor,
        reservedActionType,
        "EX_UNUSABLE",
        "EX_GAUGE",
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
        actionId,
        actionScope,
      );
    }
    if (exSkill.resolution.kind === "CHARGE") {
      return resolveChargeStart(
        actor,
        exSkill,
        "EX",
        reservedActionType,
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
        actionId,
        actionScope,
      );
    }
    return resolveSkillUse(
      actor,
      exSkill,
      "EX",
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  const activeSkills = definitions.activeSkillsByUnit.get(actor.unitDefinitionId) ?? [];
  const selection = selectAsCandidate(
    activeSkills,
    actor,
    units,
    definitions.unitDefinitions,
    evaluateActivationCondition,
  );

  if (selection.kind === "WAIT") {
    return resolveWait(
      actor,
      reservedActionType,
      "NO_USABLE_ACTIVE_SKILL",
      "AP",
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  if (selection.skill.resolution.kind === "CHARGE") {
    return resolveChargeStart(
      actor,
      selection.skill,
      "AS",
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  return resolveSkillUse(
    actor,
    selection.skill,
    "AS",
    reservedActionType,
    units,
    definitions,
    random,
    recorder,
    turnNumber,
    cycleNumber,
    actionId,
    actionScope,
  );
}

/**
 * `06_戦闘状態遷移.md` のQUEUE_BUILDING〜ACTION_RESOLUTIONを、使用可能な行動が
 * 無くなるまで繰り返す（`createActionQueue` が空を返した時点で終了）。各1行動
 * 完了後にR-END-01タイミング#1（ユニットの1行動完了後）の勝敗判定を行い、
 * 確定した時点で残りの行動を打ち切る。PS/Memory連鎖(M6)は行わない。
 * `ActionQueueCreated`は周回ごとに発行し、ターンの解決スコープ（`turnRootEventId`）
 * を共有する。行動自体（`ActionStarted`以降）は自分自身の解決スコープを新しく開く。
 */
export function resolveActionPhase(
  allyUnits: readonly BattleUnit[],
  enemyUnits: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  turnRootEventId: DomainEventId,
  turnScopeParentEventId: DomainEventId,
): ActionPhaseResult {
  let units: readonly BattleUnit[] = [...allyUnits, ...enemyUnits];
  let cycleNumber = 0;
  let turnScopeParent = turnScopeParentEventId;

  // R-ACT-03: AS・PS・EXのコストは1以上であり、Catalog検証（`createCost`/
  // JSON Schema）がコスト0の定義を生成前に拒否する。このガードは、それでも
  // コスト0相当のASが紛れ込んだ場合(不正データ、将来のバグ)への多層防御。
  // costが0だと`consumeAp`が no-op になり、そのユニットのAPはキュー適格判定
  // (`isQueueEligible`)を通過し続け、周回を再生成するたびに再度選ばれてしまう。
  // 通常規則(cost>=1、WAITは必ずAP 1を消費)ではターン内の総周回数は開始時APの
  // 合計を超えないため、それを上回った時点で無限周回と判断し、規定ターン上限を
  // 経由せずこのターン内で即座に検出する(`resolveActionPhase`はターンをまたがない)。
  // R-SKL-05: チャージ効果発動はAP・EXゲージを消費しないため、チャージ開始の
  // AP消費1回につき最大2周回（開始+発動）を要する。安全上限を2倍にして、
  // 正当なチャージ多用を誤検知しないようにする。
  const maxCyclesPerTurn = units.reduce((sum, unit) => sum + unit.maximumAp, 0) * 2 + 1;

  for (;;) {
    const queue = createActionQueue(units);
    if (queue.entries.length === 0) {
      break;
    }
    cycleNumber += 1;
    if (cycleNumber > maxCyclesPerTurn) {
      throw new DomainValidationError(
        "resolveActionPhase.cycleNumber",
        `exceeded the maximum possible cycles for this turn (${maxCyclesPerTurn}, derived from the total starting AP across all units); a 0-cost action is preventing forward progress`,
      );
    }

    const queueCreated = recorder.record({
      eventType: "ActionQueueCreated",
      category: "FACT",
      turnNumber,
      cycleNumber,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      parentEventId: turnScopeParent,
      rootEventId: turnRootEventId,
      payload: {
        cycleNumber,
        reservations: queue.entries.map((entry) => ({
          battleUnitId: entry.battleUnitId,
          reservedActionKind: entry.reservedActionKind,
          actionSpeed: requireUnit(units, entry.battleUnitId).combatStats.actionSpeed,
        })),
      },
    });
    turnScopeParent = queueCreated.eventId;

    // `remaining`は「まだ処理していないこの周回の予約」。`06_戦闘状態遷移.md`
    // 「戦闘不能者の除去」: 行動完了ごとにここから戦闘不能者を即時除去する
    // （dequeue時の`isDefeated`判定は本来届かないはずの防御的判定として残す）。
    let remaining = queue.entries;

    while (remaining.length > 0) {
      const reservation = remaining[0]!;
      remaining = remaining.slice(1);

      if (isDefeated(requireUnit(units, reservation.battleUnitId))) {
        continue;
      }

      const beforeActionUnits = units;
      const resolution = resolveOneAction(
        reservation.battleUnitId,
        reservation.reservedActionKind,
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
      );
      units = resolution.units;

      // 戦闘不能者の除去（`06_戦闘状態遷移.md`）とR-ORD-01適格性の喪失
      // （Issue #180 PRレビュー[P1]再指摘）を、除去対象と理由が安定するまで
      // 1件ずつ再評価しながら処理する（PRレビュー[P2]再々指摘: ある除去のPS/
      // Memory連鎖が他の予約の適格性・生死を変え得るため、事前に一括計算した
      // リストをそのまま使うと反映されない）。
      const removal = removeIneligibleAndDefeatedReservations(
        remaining,
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
        resolution.completedEventId,
        resolution.rootEventId,
      );
      remaining = removal.remaining;
      units = removal.units;
      const causeEventId = removal.lastEventId;

      // R-ORD-04: 現在の1行動(とPS/Memory連鎖)完了・戦闘不能者除去の後、未行動者の
      // 行動速度が実際に変わっていた場合だけ並べ直す。予約種別(AS/EX)は
      // `reorderRemainingQueue`が維持する。
      if (remaining.length > 0) {
        const speedChanged = remaining.some(
          (entry) =>
            requireUnit(beforeActionUnits, entry.battleUnitId).combatStats.actionSpeed !==
            requireUnit(units, entry.battleUnitId).combatStats.actionSpeed,
        );
        if (speedChanged) {
          const before = remaining.map((entry) => ({
            battleUnitId: entry.battleUnitId,
            actionSpeed: requireUnit(beforeActionUnits, entry.battleUnitId).combatStats.actionSpeed,
          }));
          const reordered = reorderRemainingQueue(remaining, units);
          const after = reordered.map((entry) => ({
            battleUnitId: entry.battleUnitId,
            actionSpeed: requireUnit(units, entry.battleUnitId).combatStats.actionSpeed,
          }));
          recorder.record({
            eventType: "ActionQueueReordered",
            category: "FACT",
            turnNumber,
            cycleNumber,
            resolutionScopeId: resolution.actionScope,
            parentEventId: causeEventId,
            rootEventId: resolution.rootEventId,
            payload: { before, after },
          });
          remaining = reordered;
        }
      }

      const { ally, enemy } = splitBySide(units);
      const victory = resolveVictory({
        allAlliesDefeated: ally.every(isDefeated),
        allEnemiesDefeated: enemy.every(isDefeated),
        turnLimitReached: false,
      });
      if (victory !== undefined) {
        return { allyUnits: ally, enemyUnits: enemy, result: victory };
      }
    }
  }

  const { ally, enemy } = splitBySide(units);
  return { allyUnits: ally, enemyUnits: enemy, result: undefined };
}
