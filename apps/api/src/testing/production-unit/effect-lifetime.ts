import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";

/**
 * 実戦闘ログの各効果インスタンスが、宣言した時計で終わっているかを検査するハーネス。
 * 時計ごとに「この区間の中で終わらなければならない」区間を決め、付与から最初の
 * 終了（`EFFECT_EXPIRED`／`EFFECT_REMOVED`）までの位置を突き合わせる。
 *
 * 戦闘がその区間の終点より前に終わった付与は「終点へ到達していない」ため違反にも
 * 証拠にもしない。終点へ到達した付与があることは`exercised`で別に数える — 1ターン目で
 * 決着する戦闘ばかりでは、ターン末の時計は何も検査されないためである。
 */
export type EffectLifetime =
  /** 戦闘中永続。時間制限では失効しない（解除は別）。 */
  | "PERMANENT"
  /** 付与ターンの終了処理（`TURN_COMPLETING`〜`TURN_COMPLETED`）で終わる。 */
  | "GRANTING_TURN"
  /**
   * 付与した行動の完了処理（`ACTION_COMPLETING`〜`ACTION_COMPLETED`）で終わる。行動の外で
   * 付与したものは、その解決フェーズ（同じルートのイベント列）の中で終わる。
   */
  | "GRANTING_ACTION"
  /** 付与したスキル使用の効果処理を終えてから、その完了イベントまでに終わる。 */
  | "GRANTING_SKILL_USE"
  /** 付与後に保持者自身が行う最初の行動の完了処理で終わる。 */
  | "HOLDER_NEXT_ACTION";

export interface LifetimeVerdict {
  readonly effectActionDefinitionId: string;
  /** 宣言した時計の終点（永続なら付与後の行動完了）まで戦闘が進んだか。 */
  readonly exercised: boolean;
  readonly violation?: string;
}

function detailsOf(event: BattleLogEvent): Readonly<Record<string, unknown>> {
  return event.details as Readonly<Record<string, unknown>>;
}

const SKILL_USE_END_TYPES = new Set([
  "SKILL_USE_COMPLETED",
  "SKILL_USE_INTERRUPTED",
  "PASSIVE_RESOLVED",
  "PASSIVE_INTERRUPTED",
]);

function isTimeLimit(event: BattleLogEvent): boolean {
  return event.type === "EFFECT_EXPIRED" && detailsOf(event)["reason"] === "TIME_LIMIT";
}

function first(
  events: readonly BattleLogEvent[],
  predicate: (event: BattleLogEvent) => boolean,
): BattleLogEvent | undefined {
  return events.find(predicate);
}

function last(
  events: readonly BattleLogEvent[],
  predicate: (event: BattleLogEvent) => boolean,
): BattleLogEvent | undefined {
  return events.filter(predicate).at(-1);
}

/** 終わらなければならない区間。`from`より前の時間制限失効は早すぎる失効として扱う。 */
interface Window {
  readonly from?: BattleLogEvent;
  readonly until?: BattleLogEvent;
}

function windowOf(
  lifetime: EffectLifetime,
  applied: BattleLogEvent,
  events: readonly BattleLogEvent[],
): Window | string {
  switch (lifetime) {
    case "PERMANENT": {
      const later = first(
        events,
        (e) => e.type === "ACTION_COMPLETED" && e.sequence > applied.sequence,
      );
      return later === undefined ? {} : { from: later };
    }
    case "GRANTING_TURN": {
      const turn = applied.turnNumber;
      const from = first(events, (e) => e.type === "TURN_COMPLETING" && e.turnNumber === turn);
      const until = first(events, (e) => e.type === "TURN_COMPLETED" && e.turnNumber === turn);
      return { ...(from === undefined ? {} : { from }), ...(until === undefined ? {} : { until }) };
    }
    case "GRANTING_ACTION": {
      const actionId = applied.actionId;
      if (actionId === undefined) {
        // 行動の外（ターン開始時のPS攻撃など）の付与は、同じ解決フェーズの最後のイベント
        // までに終わる。次の行動の開始より前でもある。
        const until = last(events, (e) => e.rootSequence === applied.rootSequence);
        return until === undefined ? {} : { until };
      }
      const from = first(events, (e) => e.type === "ACTION_COMPLETING" && e.actionId === actionId);
      const until = first(events, (e) => e.type === "ACTION_COMPLETED" && e.actionId === actionId);
      return { ...(from === undefined ? {} : { from }), ...(until === undefined ? {} : { until }) };
    }
    case "GRANTING_SKILL_USE": {
      const skillUseId = applied.skillUseId;
      if (skillUseId === undefined) {
        return "was granted outside a skill use";
      }
      const from = last(
        events,
        (e) =>
          (e.type === "EFFECT_STEP_COMPLETED" || e.type === "DAMAGE_APPLIED") &&
          e.skillUseId === skillUseId,
      );
      const until = first(
        events,
        (e) => SKILL_USE_END_TYPES.has(e.type) && e.skillUseId === skillUseId,
      );
      return { ...(from === undefined ? {} : { from }), ...(until === undefined ? {} : { until }) };
    }
    case "HOLDER_NEXT_ACTION": {
      const holder = detailsOf(applied)["targetUnitId"];
      const nextAction = first(
        events,
        (e) =>
          e.type === "ACTION_STARTED" &&
          e.sequence > applied.sequence &&
          e.actionId !== applied.actionId &&
          detailsOf(e)["actorUnitId"] === holder,
      );
      if (nextAction === undefined) {
        return {};
      }
      const from = first(
        events,
        (e) => e.type === "ACTION_COMPLETING" && e.actionId === nextAction.actionId,
      );
      const until = first(
        events,
        (e) => e.type === "ACTION_COMPLETED" && e.actionId === nextAction.actionId,
      );
      return { ...(from === undefined ? {} : { from }), ...(until === undefined ? {} : { until }) };
    }
  }
}

/** `definitionIds`の各付与について、`lifetime`の時計で終わっているかを判定する。 */
export function judgeEffectLifetimes(
  events: readonly BattleLogEvent[],
  definitionIds: ReadonlySet<string>,
  lifetime: EffectLifetime,
): readonly LifetimeVerdict[] {
  return events
    .filter(
      (event) =>
        event.type === "EFFECT_APPLIED" &&
        definitionIds.has(detailsOf(event)["effectActionDefinitionId"] as string),
    )
    .map((applied) => {
      const effectActionDefinitionId = detailsOf(applied)["effectActionDefinitionId"] as string;
      const instanceId = detailsOf(applied)["effectInstanceId"];
      const end = first(
        events,
        (e) =>
          (e.type === "EFFECT_EXPIRED" || e.type === "EFFECT_REMOVED") &&
          detailsOf(e)["effectInstanceId"] === instanceId,
      );
      const label = `${effectActionDefinitionId}@${applied.sequence}`;
      const at = (event: BattleLogEvent | undefined) =>
        event === undefined ? "none" : `${event.type}@${event.sequence}`;
      const window = windowOf(lifetime, applied, events);
      if (typeof window === "string") {
        return { effectActionDefinitionId, exercised: false, violation: `${label} ${window}` };
      }

      if (lifetime === "PERMANENT") {
        const violation =
          end !== undefined && isTimeLimit(end)
            ? `${label} is permanent but expired at ${at(end)}`
            : undefined;
        return {
          effectActionDefinitionId,
          exercised: window.from !== undefined,
          ...(violation === undefined ? {} : { violation }),
        };
      }

      if (window.until === undefined) {
        // 終点の前に戦闘が終わった（保持者が二度と行動しなかった場合を含む）。
        const violation =
          end !== undefined && isTimeLimit(end)
            ? `${label} expired at ${at(end)} although its end point was never reached`
            : undefined;
        return {
          effectActionDefinitionId,
          exercised: false,
          ...(violation === undefined ? {} : { violation }),
        };
      }
      let violation: string | undefined;
      if (end === undefined || end.sequence > window.until.sequence) {
        violation = `${label} must end before ${at(window.until)}, ended at ${at(end)}`;
      } else if (
        isTimeLimit(end) &&
        window.from !== undefined &&
        end.sequence < window.from.sequence
      ) {
        violation = `${label} expired at ${at(end)}, before ${at(window.from)}`;
      }
      return {
        effectActionDefinitionId,
        exercised: true,
        ...(violation === undefined ? {} : { violation }),
      };
    });
}
