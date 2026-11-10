import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import { createBattleStateReplay } from "../../entities/battle-state-replay.js";
import type { RosterEntry } from "../../entities/roster.js";
import type { BattleLogEventResponse, BattleStateResponse } from "../../shared/api/api-contract.js";
import { buildRosterIndex } from "../details/event-presentation.js";
import { projectActionSegments } from "./action-segment-projector.js";
import { projectTraceBoard } from "./trace-board-projector.js";
import type { TraceBoardView, TraceUnitCardView } from "./trace-board-view.js";
import { TraceBoard } from "./TraceBoard.js";

function card(
  id: string,
  side: "ALLY" | "ENEMY",
  column: number,
  row: "FRONT" | "REAR",
  overrides: Partial<TraceUnitCardView> = {},
): TraceUnitCardView {
  return {
    battleUnitId: id,
    side,
    column,
    row,
    displayName: id === "ally:1" ? "味方A" : id === "enemy:1" ? "敵C" : id,
    name: id === "ally:1" ? "味方A" : id === "enemy:1" ? "敵C" : id,
    hp: { before: 1000, after: 1000, maximum: 1000 },
    shield: { before: 0, after: 0 },
    chips: [],
    roles: { actor: false, activator: false, target: false },
    defeated: false,
    ...overrides,
  };
}

const VIEW: TraceBoardView = {
  units: [
    card("ally:1", "ALLY", 0, "FRONT", {
      roles: { actor: true, activator: false, target: false },
      ap: { before: 3, after: 1, maximum: 4 },
      extraGauge: { before: 0, after: 20, maximum: 100 },
    }),
    card("ally:2", "ALLY", 2, "REAR", { heal: { total: 30 } }),
    card("enemy:1", "ENEMY", 1, "FRONT", {
      hp: { before: 1000, after: 0, maximum: 1000 },
      shield: { before: 50, after: 10 },
      damage: { total: 1050, hits: 1, critical: true, shieldAbsorbed: 50 },
      roles: { actor: false, activator: false, target: true },
      defeated: true,
      chips: [
        { key: "effect:E", label: "EFF_X", kind: "DEBUFF", change: "added", ineffective: false },
        { key: "effect:F", label: "EFF_Y", kind: "BUFF", change: "removed", ineffective: false },
      ],
    }),
    card("enemy:2", "ENEMY", 0, "REAR", {
      roles: { actor: false, activator: true, target: false },
    }),
  ],
  arrows: [
    { fromUnitId: "ally:1", toUnitId: "enemy:1", kind: "attack", side: "ALLY" },
    { fromUnitId: "enemy:2", toUnitId: "ally:1", kind: "passive", side: "ENEMY" },
    { fromUnitId: "ally:1", toUnitId: "ally:2", kind: "heal", side: "ALLY" },
  ],
};

type Rect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

let rects: Record<string, Rect> = {};
let resizeCallbacks: (() => void)[] = [];

function domRect(rect: Rect): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => rect,
  };
}

beforeEach(() => {
  rects = {
    board: { left: 0, top: 0, width: 600, height: 400 },
    "ally:1": { left: 0, top: 200, width: 100, height: 100 },
    "ally:2": { left: 400, top: 300, width: 100, height: 100 },
    "enemy:1": { left: 200, top: 100, width: 100, height: 100 },
    "enemy:2": { left: 0, top: 0, width: 100, height: 100 },
  };
  resizeCallbacks = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const key =
      this.dataset["traceUnit"] ?? (this.dataset["traceBoard"] !== undefined ? "board" : "");
    return domRect(rects[key] ?? { left: 0, top: 0, width: 0, height: 0 });
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function cardGroups(region: HTMLElement): readonly string[] {
  return within(region)
    .getAllByRole("group")
    .map((group) => group.getAttribute("data-trace-unit") ?? "");
}

describe("TraceBoard", () => {
  it("UI-CT-194: 敵を上・味方を下に、前衛どうしが向き合う3列×前衛／後衛へカードを置き、空き枠を残す", () => {
    render(<TraceBoard view={VIEW} />);
    const enemy = screen.getByRole("region", { name: "敵の盤面" });
    const ally = screen.getByRole("region", { name: "味方の盤面" });
    expect(enemy.compareDocumentPosition(ally) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 敵は後衛→前衛、味方は前衛→後衛の順に並べ、前衛どうしを境界線の側に寄せる
    const enemyRows = within(enemy).getAllByRole("row");
    expect(enemyRows.map((row) => row.getAttribute("aria-label"))).toEqual(["後衛", "前衛"]);
    const allyRows = within(ally).getAllByRole("row");
    expect(allyRows.map((row) => row.getAttribute("aria-label"))).toEqual(["前衛", "後衛"]);
    expect(cardGroups(enemyRows[0]!)).toEqual(["enemy:2"]);
    expect(cardGroups(enemyRows[1]!)).toEqual(["enemy:1"]);
    expect(within(enemyRows[1]!).getAllByRole("cell")).toHaveLength(3);
    expect(within(enemyRows[1]!).getAllByRole("cell")[1]).toContainElement(
      screen.getByRole("group", { name: /^敵C/ }),
    );
    expect(cardGroups(allyRows[0]!)).toEqual(["ally:1"]);
    expect(cardGroups(allyRows[1]!)).toEqual(["ally:2"]);
    expect(within(allyRows[1]!).getAllByRole("cell")[2]).toContainElement(
      screen.getByRole("group", { name: /^ally:2/ }),
    );
  });

  it("UI-CT-195: 発動者から対象へ、攻撃は陣営色・PSは破線・回復は回復の色の矢印を測った位置へ引き、矢印の内容を文字でも読める。大きさが変わると引き直す", () => {
    render(<TraceBoard view={VIEW} />);
    const svg = document.querySelector("svg[data-trace-arrows]");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("viewBox", "0 0 600 400");
    const paths = [...svg!.querySelectorAll("path[data-arrow]")];
    expect(paths.map((path) => path.getAttribute("data-arrow"))).toEqual([
      "ally:1>enemy:1",
      "enemy:2>ally:1",
      "ally:1>ally:2",
    ]);
    expect(paths[0]?.getAttribute("class")).toMatch(/arrowAttackAlly/);
    expect(paths[1]?.getAttribute("class")).toMatch(/arrowPassive/);
    expect(paths[1]).toHaveAttribute("stroke-dasharray");
    expect(paths[2]?.getAttribute("class")).toMatch(/arrowHeal/);
    // 始点は発動者のカード中心(50,250)から、終点は対象のカード中心(250,150)から内側へ寄せる
    const first = paths[0]!.getAttribute("d")!;
    expect(first).toMatch(/^M\d+(\.\d+)? \d+(\.\d+)? Q/);
    const [, x1, y1] = /^M(\S+) (\S+)/.exec(first)!.map(Number);
    expect(x1).toBeGreaterThan(50);
    expect(y1).toBeLessThan(250);

    const list = screen.getByRole("list", { name: "矢印" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["味方A → 敵C（攻撃）", "enemy:2 → 味方A（PS発動）", "味方A → ally:2（回復）"]);

    rects = { ...rects, board: { left: 0, top: 0, width: 800, height: 500 } };
    act(() => {
      for (const callback of resizeCallbacks) {
        callback();
      }
    });
    expect(svg).toHaveAttribute("viewBox", "0 0 800 500");
  });

  it("UI-CT-188: 盤面のバー・ゲージ・矢印がinline styleを持たない", () => {
    const { container } = render(<TraceBoard view={VIEW} />);
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("path[data-arrow]").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("draws the arrows once from the first layout without ResizeObserver", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("ResizeObserver", undefined);
    render(<TraceBoard view={VIEW} />);
    // 計測は描画後に1回だけ行い、ResizeObserverが無い環境でも落ちない
    expect(document.querySelectorAll("path[data-arrow]")).toHaveLength(3);
  });
});

describe("TraceBoard with a replayed total war", () => {
  it("UI-CT-186: 総力戦で途中から出撃したユニットが、出撃前の時点では盤面に無く、出撃後の時点では名前で盤面に出る", () => {
    const fixture = totalWarSuccessFixture as unknown as {
      initialState: BattleStateResponse;
      stateTransitions: readonly Record<string, unknown>[];
      events: readonly BattleLogEventResponse[];
      unitRoster: readonly Omit<RosterEntry, "displayName">[];
    };
    const roster = buildRosterIndex(
      fixture.unitRoster.map((entry) => ({
        ...entry,
        displayName: `【第二陣】${entry.battleUnitId}`,
      })),
    );
    const segments = projectActionSegments(fixture.events, fixture.unitRoster);
    const replay = createBattleStateReplay(
      fixture.initialState,
      fixture.stateTransitions,
      segments.map((s) => s.stateVersionBefore),
    );
    const deployed = segments.find(
      (s) => s.kind === "SYSTEM" && s.headline.kind === "FORMATION_DEPLOYED",
    )!;
    const viewAt = (version: number) =>
      projectTraceBoard({
        before: replay.stateAt(deployed.stateVersionBefore),
        after: replay.stateAt(version),
        segment: deployed,
        steps: [],
        roster,
        actionOrders: new Map(),
      });
    const newcomer = fixture.unitRoster.find(
      (entry) =>
        !fixture.initialState.units.some((u) => u.battleUnitId === entry.battleUnitId) &&
        viewAt(deployed.stateVersionAfter).units.some((u) => u.battleUnitId === entry.battleUnitId),
    );
    expect(newcomer).toBeDefined();
    const name = `【第二陣】${newcomer!.battleUnitId}`;

    const { rerender } = render(<TraceBoard view={viewAt(deployed.stateVersionBefore)} />);
    expect(screen.queryByRole("group", { name: new RegExp(`^${name}`) })).toBeNull();

    rerender(<TraceBoard view={viewAt(deployed.stateVersionAfter)} />);
    const group = screen.getByRole("group", { name: new RegExp(`^${name}`) });
    expect(within(group).getByText(newcomer!.battleUnitId)).toBeInTheDocument();
  });
});
