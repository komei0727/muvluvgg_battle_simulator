import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActionTraceResponse, TRACE_ROSTER } from "../../test/action-trace-response.js";
import { buildRosterIndex } from "../details/event-presentation.js";
import { ActionTraceSection } from "./ActionTraceSection.js";

const ROSTER = buildRosterIndex(TRACE_ROSTER);

function renderSection(response = createActionTraceResponse(), onJumpToTransition = vi.fn()) {
  const view = render(
    <ActionTraceSection
      response={response}
      roster={ROSTER}
      onJumpToTransition={onJumpToTransition}
    />,
  );
  return { ...view, onJumpToTransition };
}

function position(): string {
  return screen.getByRole("status", { name: "現在位置" }).textContent ?? "";
}

function stepList() {
  return screen.getByRole("list", { name: "処理の一覧" });
}

function stepRows() {
  return within(stepList()).getAllByRole("button");
}

function card(name: RegExp) {
  return screen.getByRole("group", { name });
}

async function goToSegment(user: ReturnType<typeof userEvent.setup>, index: number) {
  for (let count = 0; count < index; count += 1) {
    await user.click(screen.getByRole("button", { name: "1単位進む" }));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ActionTraceSection", () => {
  it("UI-CT-177: ヒットのある行動で行動者に「行動中」、対象に「対象」が付き、対象にダメージ合計と会心・シールド吸収、HPバーに減った分が残る", async () => {
    const user = userEvent.setup();
    renderSection();
    await goToSegment(user, 2);

    expect(position()).toMatch(/ターン 1/);
    expect(position()).toMatch(/行動 3 \/ 8/);
    expect(card(/^【先駆】味方A.*行動中/)).toBeInTheDocument();
    const target = card(/^敵C.*対象/);
    expect(within(target).getByText("−1,800")).toBeInTheDocument();
    expect(within(target).getByText("会心")).toBeInTheDocument();
    expect(within(target).getByText(/盾 −300/)).toBeInTheDocument();
    expect(within(target).getByRole("img", { name: /HP 3,500 \/ 5,000/ })).toBeInTheDocument();
  });

  it("UI-CT-178: 回復・効果の付与と解除・撃破・AP/PPの消費が区別して示される", async () => {
    const user = userEvent.setup();
    renderSection();
    await goToSegment(user, 3);

    const healed = card(/^敵C/);
    expect(within(healed).getByText("+500")).toBeInTheDocument();
    const removed = within(healed).getByRole("listitem", { name: /EFF_GUARD/ });
    expect(removed.getAttribute("aria-label")).toMatch(/解除/);

    await user.click(screen.getByRole("button", { name: "1単位戻る" }));
    const applied = within(card(/^敵C/)).getByRole("listitem", { name: /EFF_GUARD/ });
    expect(applied.getAttribute("aria-label")).toMatch(/付与/);
    expect(
      within(card(/^敵D/)).getByRole("img", { name: /PP 1 \/ 3（1消費）/ }),
    ).toBeInTheDocument();
    expect(
      within(card(/^【先駆】味方A/)).getByRole("img", { name: /AP 1 \/ 3（2消費）/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "末尾へ" }));
    await user.click(screen.getByRole("button", { name: "1単位戻る" }));
    expect(card(/^敵C.*撃破/)).toBeInTheDocument();
  });

  it("UI-CT-179: 割り込みPSの行が字下げされ「割り込み」と示され、PS発動者に「PS発動」が付く。メモリー発動はメモリー（陣営）と出る", async () => {
    const user = userEvent.setup();
    renderSection();
    await goToSegment(user, 2);

    const interrupt = stepRows().find((row) => /PASSIVE_ACTIVATED/.test(row.textContent ?? ""));
    expect(interrupt).toBeDefined();
    expect(within(interrupt!).getByText("割り込み")).toBeInTheDocument();
    expect(interrupt!.closest("li")?.className).toMatch(/depth1/);
    expect(card(/^敵D.*PS発動/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "1単位進む" }));
    const memory = stepRows().find((row) => /MEMORY_TRIGGERED/.test(row.textContent ?? ""));
    expect(within(memory!).getByText("メモリー（味方）")).toBeInTheDocument();
    expect(within(memory!).getByText("割り込み")).toBeInTheDocument();
  });

  it("UI-CT-180: ヒットの行に計算過程の項目とシールド吸収・HPダメージの内訳が出て、payloadに無い項目は出ない", async () => {
    const user = userEvent.setup();
    renderSection();
    await goToSegment(user, 2);

    const hit = stepRows().find((row) => /HIT_CONFIRMED/.test(row.textContent ?? ""))!;
    const terms = within(hit).getByRole("list", { name: "計算過程" });
    expect(
      within(terms)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["攻撃力1,000", "実効防御200", "スキル威力1.5", "会心倍率1.5", "計算ダメージ1,800"]);
    const breakdown = within(hit).getByRole("list", { name: "内訳" });
    expect(
      within(breakdown)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["シールド吸収 300", "HPダメージ 1,500"]);
    expect(within(hit).queryByText(/属性倍率/)).toBeNull();
    expect(within(hit).queryByText(/サブユニット/)).toBeNull();
  });

  it("UI-CT-181: 進む・戻る・N単位・先頭・末尾で位置表示・盤面・処理の一覧が切り替わり、端のボタンが無効になる。処理単位では現在の行が強調され、まだ起きていない行が薄く出る", async () => {
    const user = userEvent.setup();
    renderSection();

    expect(position()).toMatch(/行動 1 \/ 8/);
    expect(screen.getByRole("button", { name: "先頭へ" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "1単位戻る" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "5単位戻る" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "5単位進む" }));
    expect(position()).toMatch(/行動 6 \/ 8/);
    expect(position()).toMatch(/ターン 2/);

    await user.click(screen.getByRole("button", { name: "末尾へ" }));
    expect(position()).toMatch(/行動 8 \/ 8/);
    expect(screen.getByRole("button", { name: "1単位進む" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // 無効のボタンは押しても動かない
    await user.click(screen.getByRole("button", { name: "1単位進む" }));
    expect(position()).toMatch(/行動 8 \/ 8/);

    await user.click(screen.getByRole("button", { name: "先頭へ" }));
    expect(position()).toMatch(/行動 1 \/ 8/);
    await goToSegment(user, 2);

    await user.click(screen.getByRole("button", { name: "処理" }));
    expect(screen.getByRole("button", { name: "処理" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "先頭へ" }));
    await goToSegment(user, 4);
    // 区間0・1は1ステップずつなので、4回進むと区間2（味方Aの行動）の3ステップ目
    expect(position()).toMatch(/行動 3 \/ 8/);
    expect(position()).toMatch(/処理 3 \//);
    const rows = within(stepList()).getAllByRole("listitem");
    expect(rows[2]).toHaveAttribute("aria-current", "step");
    expect(rows[2]?.className).toMatch(/current/);
    expect(rows[3]?.className).toMatch(/upcoming/);
    expect(rows[0]?.className).not.toMatch(/upcoming/);

    await user.click(screen.getByRole("button", { name: "ターン" }));
    await user.click(screen.getByRole("button", { name: "1単位進む" }));
    expect(position()).toMatch(/ターン 2/);
    expect(position()).toMatch(/行動 6 \/ 8/);
  });

  it("UI-CT-182: 領域の中のキー操作で移動・再生でき、selectにフォーカスがある間はキーを奪わない", async () => {
    const user = userEvent.setup();
    renderSection();
    const forward = screen.getByRole("button", { name: "1単位進む" });
    forward.focus();

    await user.keyboard("{ArrowRight}");
    expect(position()).toMatch(/行動 2 \/ 8/);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(position()).toMatch(/行動 7 \/ 8/);
    await user.keyboard("{ArrowLeft}");
    expect(position()).toMatch(/行動 6 \/ 8/);
    await user.keyboard("{End}");
    expect(position()).toMatch(/行動 8 \/ 8/);
    await user.keyboard("{Home}");
    expect(position()).toMatch(/行動 1 \/ 8/);

    // ボタンにフォーカスがある間、Spaceはボタン自身のもの。領域の他の場所ではSpaceで再生する
    const region = screen.getByRole("region", { name: "行動トレース" });
    fireEvent.keyDown(region, { key: " " });
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    fireEvent.keyDown(region, { key: " " });
    expect(screen.getByRole("button", { name: "再生" })).toBeInTheDocument();

    const follow = screen.getByRole("combobox", { name: "追跡" });
    follow.focus();
    await user.keyboard("{ArrowRight}");
    expect(position()).toMatch(/行動 1 \/ 8/);
  });

  it("UI-CT-183: 再生で一定間隔ごとに1単位進み、末尾で止まる。他の操作で再生が止まる", () => {
    vi.useFakeTimers();
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "再生" }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(position()).toMatch(/行動 2 \/ 8/);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(position()).toMatch(/行動 4 \/ 8/);

    fireEvent.click(screen.getByRole("button", { name: "1単位戻る" }));
    expect(screen.getByRole("button", { name: "再生" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(position()).toMatch(/行動 3 \/ 8/);

    fireEvent.click(screen.getByRole("button", { name: "再生" }));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(position()).toMatch(/行動 8 \/ 8/);
    expect(screen.getByRole("button", { name: "再生" })).toBeInTheDocument();
  });

  it("UI-CT-184: タイムライン・行動順・処理の一覧の行を押すとその時点へ移り、追跡で除外される区間が薄く出る", async () => {
    const user = userEvent.setup();
    renderSection();
    const timeline = screen.getByRole("navigation", { name: "タイムライン" });

    await user.click(within(timeline).getByRole("button", { name: /ターン2 【先駆】味方A/ }));
    expect(position()).toMatch(/行動 7 \/ 8/);
    expect(within(timeline).getByRole("button", { name: /ターン2 【先駆】味方A/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(
      within(timeline).getByRole("button", { name: /ターン2 【先駆】味方A.*撃破あり/ }),
    ).toBeInTheDocument();

    await user.click(within(timeline).getByRole("button", { name: /ターン1 敵D/ }));
    const order = screen.getByRole("navigation", { name: "行動順" });
    expect(
      within(order)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([expect.stringMatching(/味方A/), expect.stringMatching(/敵D/)]);
    await user.click(within(order).getByRole("button", { name: /味方A/ }));
    expect(position()).toMatch(/行動 3 \/ 8/);

    const hit = stepRows().find((row) => /HIT_CONFIRMED/.test(row.textContent ?? ""))!;
    await user.click(hit);
    expect(screen.getByRole("button", { name: "処理" })).toHaveAttribute("aria-pressed", "true");
    expect(position()).toMatch(/処理 4 \//);

    await user.selectOptions(screen.getByRole("combobox", { name: "追跡" }), "ALLY");
    const enemyTick = within(timeline).getByRole("button", { name: /ターン1 敵D/ });
    expect(enemyTick.className).toMatch(/dim/);
    expect(
      within(timeline).getByRole("button", { name: /ターン1 【先駆】味方A/ }).className,
    ).not.toMatch(/dim/);
  });

  it("UI-CT-185: 変化の表に範囲内で変化したユニットだけが出て、「状態遷移で開く」で範囲の最初の状態遷移へ移る", async () => {
    const user = userEvent.setup();
    const { onJumpToTransition } = renderSection();
    await goToSegment(user, 2);

    const table = screen.getByRole("table", { name: "変化の表" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "【先駆】味方A",
      "敵C",
      "敵D",
    ]);
    expect(within(rows[1]!).getByText(/5,000 → 3,500/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/シールド 300 → 0/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/\+EFF_GUARD/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "状態遷移で開く" }));
    // 区間2の前の版は2。それより後の最初の遷移はAP消費（版4、配列の0番目）
    expect(onJumpToTransition).toHaveBeenCalledWith(0);

    await user.click(screen.getByRole("button", { name: "先頭へ" }));
    expect(screen.queryByRole("table", { name: "変化の表" })).toBeNull();
    expect(screen.getByText("この範囲では状態が変化しません。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "状態遷移で開く" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("UI-CT-187: 再実行で応答が変わると、位置が先頭・再生が停止に戻る", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const { rerender } = renderSection(createActionTraceResponse("battle-1"), onJump);
    await goToSegment(user, 3);
    await user.click(screen.getByRole("button", { name: "再生" }));
    expect(position()).toMatch(/行動 4 \/ 8/);

    rerender(
      <ActionTraceSection
        response={createActionTraceResponse("battle-2")}
        roster={ROSTER}
        onJumpToTransition={onJump}
      />,
    );
    expect(position()).toMatch(/行動 1 \/ 8/);
    expect(screen.getByRole("button", { name: "再生" })).toBeInTheDocument();
  });

  it("shows a notice instead of the trace when the log has no events", () => {
    renderSection({ ...createActionTraceResponse(), events: [], stateTransitions: [] });
    expect(screen.getByText("行動トレースに表示するイベントがありません。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再生" })).toBeNull();
  });
});
