// docs/ui-design/04_コンポーネント・状態管理設計.md §4「行動トレースの位置と再生」/
// 01_UI要求・画面設計.md §8.10「操作」。
//
// 再生のタイマーとキー操作を`traceCursorReducer`の外に閉じるhook。reducerを純粋なまま
// 保つため、時間の経過とDOMのイベントはここで`TraceCursorAction`へ変換する。
import { useCallback, useEffect, type Dispatch, type KeyboardEvent } from "react";
import type { TraceCursorAction, TraceCursorState } from "./trace-cursor-reducer.js";

/** 1×のときの1単位の間隔。速度で割る。 */
export const PLAYBACK_BASE_INTERVAL_MS = 1000;

// 詳細タブのtablistは←→でtabを切り替え、selectと入力欄は←→・Home／End・Spaceを
// 自分で使うため、これらにフォーカスがある間はどのキーも奪わない
const KEY_OWNING_SELECTOR = 'select, input, textarea, [role="tab"], [contenteditable="true"]';
// ボタン・リンクはSpaceで起動するが←→・Home／Endは使わない
const SPACE_OWNING_SELECTOR = 'button, a[href], summary, [role="button"]';

function owns(target: EventTarget, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

export interface TracePlayback {
  /** 行動トレースの領域のroot要素へ付ける。 */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useTracePlayback(
  state: TraceCursorState,
  dispatch: Dispatch<TraceCursorAction>,
): TracePlayback {
  const { playing, speed, stepCount } = state;

  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    const timer = setInterval(() => {
      dispatch({ type: "moved", direction: 1, times: 1, fromPlayback: true });
    }, PLAYBACK_BASE_INTERVAL_MS / speed);
    return () => {
      clearInterval(timer);
    };
  }, [playing, speed, dispatch]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      if (owns(event.target, KEY_OWNING_SELECTOR)) {
        return;
      }
      const action = actionForKey(event.key, event.shiftKey, stepCount);
      if (action === undefined) {
        return;
      }
      if (action.type === "playToggled" && owns(event.target, SPACE_OWNING_SELECTOR)) {
        return;
      }
      event.preventDefault();
      dispatch(action);
    },
    [dispatch, stepCount],
  );

  return { onKeyDown };
}

function actionForKey(
  key: string,
  shiftKey: boolean,
  stepCount: number,
): TraceCursorAction | undefined {
  const times = shiftKey ? stepCount : 1;
  switch (key) {
    case "ArrowRight":
      return { type: "moved", direction: 1, times };
    case "ArrowLeft":
      return { type: "moved", direction: -1, times };
    case "Home":
      return { type: "movedToEdge", edge: "first" };
    case "End":
      return { type: "movedToEdge", edge: "last" };
    case " ":
      return { type: "playToggled" };
    default:
      return undefined;
  }
}
