import { act, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialTraceCursor,
  traceCursorReducer,
  type TraceCursorAction,
  type TraceCursorState,
  type TraceIndex,
} from "./trace-cursor-reducer.js";
import { PLAYBACK_BASE_INTERVAL_MS, useTracePlayback } from "./use-trace-playback.js";

// 1ステップの区間を12個並べ、行動単位の1単位＝1区間にする
const INDEX: TraceIndex = {
  segments: Array.from({ length: 12 }, () => ({
    kind: "ACTION" as const,
    side: "ALLY",
    turnNumber: 1,
    stepCount: 1,
  })),
};

let latest: TraceCursorState | undefined;
let send: ((action: TraceCursorAction) => void) | undefined;

function Harness() {
  const [state, dispatch] = useReducer(traceCursorReducer, INDEX, createInitialTraceCursor);
  const { onKeyDown } = useTracePlayback(state, dispatch);
  latest = state;
  send = dispatch;
  return (
    // 行動トレースの領域はroot要素でキーを受ける（ActionTraceSectionと同じ構造）
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- 子要素からbubbleするkeydownを受ける領域
    <section aria-label="行動トレース" tabIndex={0} onKeyDown={onKeyDown}>
      <select aria-label="進む単位" defaultValue="action">
        <option value="action">行動</option>
      </select>
      <input aria-label="入力" />
      <div role="tablist">
        <button type="button" role="tab" aria-selected="true">
          タブ
        </button>
      </div>
      <button type="button">1単位進む</button>
    </section>
  );
}

function current(): TraceCursorState {
  if (latest === undefined) {
    throw new Error("Harness is not rendered");
  }
  return latest;
}

function dispatch(action: TraceCursorAction): void {
  act(() => {
    send?.(action);
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useTracePlayback timer (UI-UT-ATR-025)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest = undefined;
    send = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances one unit per interval while playing and not while paused", () => {
    render(<Harness />);
    advance(PLAYBACK_BASE_INTERVAL_MS * 3);
    expect(current().segmentIndex).toBe(0);

    dispatch({ type: "playToggled" });
    advance(PLAYBACK_BASE_INTERVAL_MS - 1);
    expect(current().segmentIndex).toBe(0);
    advance(1);
    expect(current().segmentIndex).toBe(1);
    advance(PLAYBACK_BASE_INTERVAL_MS * 2);
    expect(current().segmentIndex).toBe(3);
    expect(current().playing).toBe(true);
  });

  it.each([
    [0.5, PLAYBACK_BASE_INTERVAL_MS * 2],
    [2, PLAYBACK_BASE_INTERVAL_MS / 2],
  ] as const)("uses the interval for speed %sx", (speed, interval) => {
    render(<Harness />);
    dispatch({ type: "speedChanged", speed });
    dispatch({ type: "playToggled" });
    advance(interval - 1);
    expect(current().segmentIndex).toBe(0);
    advance(1);
    expect(current().segmentIndex).toBe(1);
  });

  it("stops at the end and restarts from the first position when played again", () => {
    render(<Harness />);
    dispatch({ type: "playToggled" });
    advance(PLAYBACK_BASE_INTERVAL_MS * 20);
    expect(current().segmentIndex).toBe(11);
    expect(current().playing).toBe(false);

    dispatch({ type: "playToggled" });
    expect(current().segmentIndex).toBe(0);
    expect(current().playing).toBe(true);
    advance(PLAYBACK_BASE_INTERVAL_MS);
    expect(current().segmentIndex).toBe(1);
  });

  it("stops ticking after another operation stops playback", () => {
    render(<Harness />);
    dispatch({ type: "playToggled" });
    advance(PLAYBACK_BASE_INTERVAL_MS);
    dispatch({ type: "jumped", segmentIndex: 5 });
    advance(PLAYBACK_BASE_INTERVAL_MS * 3);
    expect(current().segmentIndex).toBe(5);
    expect(current().playing).toBe(false);
  });

  it("clears the timer on unmount", () => {
    const { unmount } = render(<Harness />);
    dispatch({ type: "playToggled" });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useTracePlayback keys (UI-UT-ATR-026)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest = undefined;
    send = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function region(): HTMLElement {
    return screen.getByRole("region", { name: "行動トレース" });
  }

  it("moves one unit with arrows and N units with Shift+arrows", () => {
    render(<Harness />);
    fireEvent.keyDown(region(), { key: "ArrowRight" });
    expect(current().segmentIndex).toBe(1);
    fireEvent.keyDown(region(), { key: "ArrowRight", shiftKey: true });
    expect(current().segmentIndex).toBe(6);
    fireEvent.keyDown(region(), { key: "ArrowLeft" });
    expect(current().segmentIndex).toBe(5);
    dispatch({ type: "stepCountChanged", stepCount: 3 });
    fireEvent.keyDown(region(), { key: "ArrowLeft", shiftKey: true });
    expect(current().segmentIndex).toBe(2);
  });

  it("moves to the edges with Home and End and toggles playback with Space", () => {
    render(<Harness />);
    fireEvent.keyDown(region(), { key: "End" });
    expect(current().segmentIndex).toBe(11);
    fireEvent.keyDown(region(), { key: "Home" });
    expect(current().segmentIndex).toBe(0);
    fireEvent.keyDown(region(), { key: " " });
    expect(current().playing).toBe(true);
    fireEvent.keyDown(region(), { key: " " });
    expect(current().playing).toBe(false);
  });

  it("prevents the default scroll for handled keys only", () => {
    render(<Harness />);
    expect(fireEvent.keyDown(region(), { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(region(), { key: "a" })).toBe(true);
    expect(current().segmentIndex).toBe(1);
  });

  it.each([
    ["select", () => screen.getByRole("combobox", { name: "進む単位" })],
    ["input", () => screen.getByRole("textbox", { name: "入力" })],
    ["tab", () => screen.getByRole("tab", { name: "タブ" })],
  ])("ignores keys while a %s has focus", (_label, target) => {
    render(<Harness />);
    for (const key of ["ArrowRight", "End", " "]) {
      expect(fireEvent.keyDown(target(), { key })).toBe(true);
    }
    expect(current().segmentIndex).toBe(0);
    expect(current().playing).toBe(false);
  });

  it("leaves Space to a focused button but still handles arrows", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "1単位進む" });
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    expect(current().playing).toBe(false);
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(current().segmentIndex).toBe(1);
  });

  it("ignores keys with Ctrl, Alt or Meta and already handled events", () => {
    render(<Harness />);
    fireEvent.keyDown(region(), { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(region(), { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(region(), { key: "End", metaKey: true });
    const handled = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(region(), handled);
    expect(current().segmentIndex).toBe(0);
  });
});
