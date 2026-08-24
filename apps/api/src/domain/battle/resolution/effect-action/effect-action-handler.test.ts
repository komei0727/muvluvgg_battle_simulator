import { describe, expect, it } from "vitest";
import { createEffectActionEventCursor } from "./effect-action-handler.js";
import type { EffectActionGroupContext, UnitsBox } from "./effect-action-group-context.js";
import type { BattleUnit } from "../../model/battle-unit.js";
import type { EventRecorder } from "../../events/event-recorder.js";
import {
  contextFor,
  seedRecorder,
  unit,
} from "../../../../testing/fixtures/effect-sequence-plan.js";

/**
 * REF-015でkind別ハンドラを切り出した際に、各kindへ散っていた「内部イベントを
 * PS/Memory即時連鎖へ届ける」二経路（callbackへの同期通知 / driverへの`yield`）を
 * {@link createEffectActionEventCursor}へ集約した。その二経路の切り替えと、
 * 同じイベントを両経路へ二重に流さない捕捉位置の前進を固定する。
 */
function record(recorder: EventRecorder, turnNumber: number): void {
  recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber },
  });
}

function setUp(withCallback: boolean): {
  readonly context: EffectActionGroupContext;
  readonly box: UnitsBox;
  readonly recorder: EventRecorder;
  readonly notified: string[];
} {
  const actor = unit("U_ACTOR", "ALLY");
  const { recorder, rootEventId } = seedRecorder();
  const notified: string[] = [];
  const onFactEventForPassiveChain = (
    event: { readonly eventType: string },
    units: readonly BattleUnit[],
  ): readonly BattleUnit[] => {
    notified.push(event.eventType);
    return units;
  };
  const context = contextFor(
    actor,
    new Map(),
    recorder,
    rootEventId,
    withCallback ? onFactEventForPassiveChain : undefined,
  );
  return { context, box: { units: [actor] }, recorder, notified };
}

describe("createEffectActionEventCursor", () => {
  it("collects every event recorded after creation as innerEvents when no passive-chain callback is wired", () => {
    const { context, box, recorder } = setUp(false);
    const cursor = createEffectActionEventCursor(context, box);
    record(recorder, 2);
    record(recorder, 3);

    expect(cursor.innerEvents().map((event) => event.payload)).toEqual([
      { turnNumber: 2 },
      { turnNumber: 3 },
    ]);
  });

  it("excludes events already handed to the driver via takePending from the innerEvents batch", () => {
    const { context, box, recorder } = setUp(false);
    const cursor = createEffectActionEventCursor(context, box);
    record(recorder, 2);
    const yielded = cursor.takePending();
    record(recorder, 3);

    expect(yielded.map((event) => event.payload)).toEqual([{ turnNumber: 2 }]);
    expect(cursor.innerEvents().map((event) => event.payload)).toEqual([{ turnNumber: 3 }]);
  });

  it("forwards pending events to the passive-chain callback and leaves innerEvents empty when the callback is wired", () => {
    const { context, box, recorder, notified } = setUp(true);
    const cursor = createEffectActionEventCursor(context, box);
    record(recorder, 2);
    cursor.notifyPending();
    record(recorder, 3);
    cursor.notifyPending();

    expect(notified).toEqual(["TurnStarted", "TurnStarted"]);
    expect(cursor.innerEvents()).toEqual([]);
  });

  it("does not re-notify events that a previous notifyPending already forwarded", () => {
    const { context, box, recorder, notified } = setUp(true);
    const cursor = createEffectActionEventCursor(context, box);
    record(recorder, 2);
    cursor.notifyPending();
    cursor.notifyPending();

    expect(notified).toHaveLength(1);
  });

  it("advances past callee-notified events only on the callback route, so the driver route still receives them", () => {
    const withCallback = setUp(true);
    const withCallbackCursor = createEffectActionEventCursor(
      withCallback.context,
      withCallback.box,
    );
    record(withCallback.recorder, 2);
    withCallbackCursor.consumeNotifiedByCallee();

    const withoutCallback = setUp(false);
    const withoutCallbackCursor = createEffectActionEventCursor(
      withoutCallback.context,
      withoutCallback.box,
    );
    record(withoutCallback.recorder, 2);
    withoutCallbackCursor.consumeNotifiedByCallee();

    expect(withCallback.notified).toEqual([]);
    expect(withCallbackCursor.takePending()).toEqual([]);
    expect(withoutCallbackCursor.innerEvents().map((event) => event.payload)).toEqual([
      { turnNumber: 2 },
    ]);
  });
});
