import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EffectTraceSection } from "./EffectTraceSection.js";
import { buildRosterIndex } from "../details/event-formatters.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

const SUIRAN_DEBUFF = "ACT_SUIRAN_CHAOS_AS1_DEBUFF";
const ELENA_BUFF = "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH";
const OTHER_EFFECT = "ACT_OTHER_MINOR_BUFF";

const roster = buildRosterIndex([
  {
    battleUnitId: "bu-ally-1",
    unitDefinitionId: "UNIT_A",
    side: "ALLY",
    displayName: "アタッカー",
  },
  { battleUnitId: "bu-ally-2", unitDefinitionId: "UNIT_B", side: "ALLY", displayName: "エレーナ" },
  { battleUnitId: "bu-ally-3", unitDefinitionId: "UNIT_C", side: "ALLY", displayName: "翠蘭" },
  {
    battleUnitId: "bu-enemy-1",
    unitDefinitionId: "UNIT_E",
    side: "ENEMY",
    displayName: "エネミーα",
  },
]);

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly turnNumber: number;
  readonly parentSequence?: number;
  readonly skillUseId?: string;
  readonly sourceUnitId?: string;
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  return {
    schemaVersion: 1,
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: seed.turnNumber,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: [],
    stateVersionBefore: seed.sequence,
    stateVersionAfter: seed.sequence + 1,
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    details: seed.details ?? {},
  };
}

function grant(
  sequence: number,
  turnNumber: number,
  overrides: Record<string, unknown>,
  envelope: Partial<EventSeed> = {},
): BattleLogEventResponse {
  return event({
    sequence,
    turnNumber,
    type: "EFFECT_APPLIED",
    ...envelope,
    details: {
      effectInstanceId: `ei-${sequence.toString()}`,
      effectActionDefinitionId: OTHER_EFFECT,
      targetUnitId: "bu-enemy-1",
      duplicate: false,
      kindKey: "K",
      effectKind: "APPLY_STAT_MOD",
      categories: ["BUFF"],
      magnitude: 10,
      linkedEffectGroupId: null,
      ...overrides,
    },
  });
}

// 翠蘭AS1デバフ（敵が保持・味方が消費）とエレーナEXバフ（味方が保持）、および
// プリセット外の効果を1つずつ含むログ。
const EVENTS: readonly BattleLogEventResponse[] = [
  event({
    sequence: 10,
    turnNumber: 1,
    type: "SKILL_USE_STARTED",
    skillUseId: "su-suiran",
    sourceUnitId: "bu-ally-3",
  }),
  grant(
    11,
    1,
    {
      effectInstanceId: "ei-suiran",
      effectActionDefinitionId: SUIRAN_DEBUFF,
      consumptionKind: "NEXT_INCOMING_ATTACK",
      consumptionMaxCount: 1,
    },
    { skillUseId: "su-suiran", sourceUnitId: "bu-ally-3", parentSequence: 10 },
  ),
  grant(
    12,
    1,
    {
      effectInstanceId: "ei-elena",
      effectActionDefinitionId: ELENA_BUFF,
      targetUnitId: "bu-ally-1",
      durationUnit: "TURN",
      initialRemaining: 3,
    },
    { sourceUnitId: "bu-ally-2" },
  ),
  grant(13, 1, { effectInstanceId: "ei-other" }, { sourceUnitId: "bu-ally-2" }),
  event({
    sequence: 20,
    turnNumber: 2,
    type: "SKILL_USE_STARTED",
    skillUseId: "su-attack",
    sourceUnitId: "bu-ally-1",
  }),
  event({
    sequence: 21,
    turnNumber: 2,
    type: "EFFECT_CONSUMPTION_CHANGED",
    skillUseId: "su-attack",
    sourceUnitId: "bu-enemy-1",
    parentSequence: 20,
    details: {
      effectInstanceId: "ei-suiran",
      battleUnitId: "bu-enemy-1",
      kind: "NEXT_INCOMING_ATTACK",
      before: 1,
      after: 0,
    },
  }),
  event({
    sequence: 22,
    turnNumber: 2,
    type: "EFFECT_EXPIRED",
    skillUseId: "su-attack",
    parentSequence: 21,
    details: {
      effectInstanceId: "ei-suiran",
      battleUnitId: "bu-enemy-1",
      effectActionDefinitionId: SUIRAN_DEBUFF,
      kindKey: "K",
      reason: "CONSUMPTION",
      linkedEffectGroupId: null,
      cascaded: false,
    },
  }),
  event({ sequence: 30, turnNumber: 3, type: "TURN_COMPLETING" }),
];

function detailRows(): readonly HTMLElement[] {
  const table = screen.getByRole("table", { name: /効果トレース明細/ });
  return within(table).getAllByRole("row").slice(1);
}

describe("EffectTraceSection", () => {
  // UI-AC-045: 注目効果2件が初期選択であり、プリセット外はログにあっても最初は出ない。
  it("opens with the two focused effects selected and the rest available but unselected (UI-CT-095)", () => {
    render(<EffectTraceSection events={EVENTS} roster={roster} />);

    const suiran = screen.getByRole("checkbox", { name: SUIRAN_DEBUFF });
    const elena = screen.getByRole("checkbox", { name: ELENA_BUFF });
    const other = screen.getByRole("checkbox", { name: OTHER_EFFECT });
    expect(suiran).toBeChecked();
    expect(elena).toBeChecked();
    expect(other).not.toBeChecked();

    const rows = detailRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(SUIRAN_DEBUFF),
      expect.stringContaining(ELENA_BUFF),
    ]);
  });

  // UI-AC-045: 消費者と付与先を何ターン目のものか読める。
  it("names the consumer of a debuff held by the enemy and the holder of a buff, with their turns (UI-CT-095)", () => {
    render(<EffectTraceSection events={EVENTS} roster={roster} />);

    const [debuffRow, buffRow] = detailRows();
    expect(debuffRow).toHaveTextContent("エネミーα");
    expect(debuffRow).toHaveTextContent("翠蘭");
    // 消費したのは保持者ではなく、直後に殴った味方である。
    expect(debuffRow).toHaveTextContent("アタッカー");
    expect(debuffRow).toHaveTextContent("消費された");
    // 同じ効果が同じ保持者へ何度も付与されるログ（実測: 1試行で同一定義が19インスタンス）
    // では、ターンと定義IDだけの行が見分けられない。付与の`sequence`で識別する。
    expect(debuffRow).toHaveTextContent("#11");
    expect(buffRow).toHaveTextContent("アタッカー");
    expect(buffRow).toHaveTextContent("エレーナ");
  });

  // UI-AC-045: 終了理由を色だけでなく文言でも区別する。
  it("distinguishes consumed / break-removed / unused-expired / ongoing outcomes in text (UI-CT-096)", () => {
    const events: readonly BattleLogEventResponse[] = [
      grant(1, 1, {
        effectInstanceId: "ei-broken",
        effectActionDefinitionId: SUIRAN_DEBUFF,
        consumptionKind: "NEXT_INCOMING_ATTACK",
        consumptionMaxCount: 1,
      }),
      grant(2, 1, {
        effectInstanceId: "ei-unused",
        effectActionDefinitionId: SUIRAN_DEBUFF,
        targetUnitId: "bu-enemy-2",
        consumptionKind: "NEXT_INCOMING_ATTACK",
        consumptionMaxCount: 1,
      }),
      grant(3, 1, {
        effectInstanceId: "ei-ongoing",
        effectActionDefinitionId: ELENA_BUFF,
        targetUnitId: "bu-ally-1",
      }),
      event({ sequence: 4, turnNumber: 2, type: "UNIT_BROKEN" }),
      event({
        sequence: 5,
        turnNumber: 2,
        type: "EFFECT_REMOVED",
        parentSequence: 4,
        details: {
          effectInstanceId: "ei-broken",
          battleUnitId: "bu-enemy-1",
          effectActionDefinitionId: SUIRAN_DEBUFF,
          kindKey: "K",
          reason: "REMOVED",
          linkedEffectGroupId: null,
          cascaded: false,
        },
      }),
      event({
        sequence: 6,
        turnNumber: 3,
        type: "EFFECT_EXPIRED",
        details: {
          effectInstanceId: "ei-unused",
          battleUnitId: "bu-enemy-2",
          effectActionDefinitionId: SUIRAN_DEBUFF,
          kindKey: "K",
          reason: "TIME_LIMIT",
          linkedEffectGroupId: null,
          cascaded: false,
        },
      }),
    ];

    render(<EffectTraceSection events={events} roster={roster} />);

    const texts = detailRows().map((row) => row.textContent ?? "");
    expect(texts[0]).toContain("ブレイクで解除");
    expect(texts[1]).toContain("未消費で失効");
    expect(texts[2]).toContain("継続中");
  });

  // UI-AC-045: 追跡対象を足せる／外せる。
  it("adds and removes tracked effects from the list of effects that appeared in the log (UI-CT-096)", async () => {
    const user = userEvent.setup();
    render(<EffectTraceSection events={EVENTS} roster={roster} />);

    await user.click(screen.getByRole("checkbox", { name: OTHER_EFFECT }));
    expect(detailRows()).toHaveLength(3);

    await user.click(screen.getByRole("checkbox", { name: SUIRAN_DEBUFF }));
    const remaining = detailRows().map((row) => row.textContent ?? "");
    expect(remaining).toHaveLength(2);
    expect(remaining.some((text) => text.includes(SUIRAN_DEBUFF))).toBe(false);
  });

  // BreakTimelineと同じ方針: 0件でも「起きなかった」ことが分かる。
  it("says the selected effects never appeared instead of rendering an empty grid (UI-CT-097)", async () => {
    const user = userEvent.setup();
    render(<EffectTraceSection events={EVENTS} roster={roster} />);

    await user.click(screen.getByRole("checkbox", { name: SUIRAN_DEBUFF }));
    await user.click(screen.getByRole("checkbox", { name: ELENA_BUFF }));

    expect(screen.getByText("選択した効果は付与されませんでした。")).toBeVisible();
    expect(screen.queryByRole("table", { name: /効果トレース明細/ })).toBeNull();
  });

  it("says no effect was applied at all when the log has no grants (UI-CT-097)", () => {
    render(
      <EffectTraceSection
        events={[event({ sequence: 1, turnNumber: 1, type: "TURN_STARTED" })]}
        roster={roster}
      />,
    );

    expect(screen.getByText("効果の付与は記録されていません。")).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  // 演習専用にしない: ブレイクを持たない通常戦闘のログでも同じtabが成立する。
  it("works on an ordinary battle log that has no UNIT_BROKEN at all (UI-CT-098)", () => {
    const events: readonly BattleLogEventResponse[] = [
      grant(
        1,
        1,
        {
          effectInstanceId: "ei-buff",
          effectActionDefinitionId: ELENA_BUFF,
          targetUnitId: "bu-ally-1",
        },
        { sourceUnitId: "bu-ally-2" },
      ),
      event({ sequence: 2, turnNumber: 2, type: "UNIT_DEFEATED", sourceUnitId: "bu-ally-1" }),
      event({
        sequence: 3,
        turnNumber: 2,
        type: "EFFECT_REMOVED",
        parentSequence: 2,
        details: {
          effectInstanceId: "ei-buff",
          battleUnitId: "bu-ally-1",
          effectActionDefinitionId: ELENA_BUFF,
          kindKey: "K",
          reason: "REMOVED",
          linkedEffectGroupId: null,
          cascaded: false,
        },
      }),
    ];

    render(<EffectTraceSection events={events} roster={roster} />);

    const [row] = detailRows();
    // 撃破由来の解除をブレイク解除と読み違えない（`UNIT_BROKEN`は演習にしか現れない）。
    expect(row).toHaveTextContent("失効・解除（REMOVED）");
    expect(row).not.toHaveTextContent("ブレイクで解除");
  });

  // 05_非機能・アクセシビリティ設計.md: CSPが`style-src 'self'`のため、スイムレーンは
  // inline styleを1つも持てない。
  it("draws the swimlane with turn columns and without any inline style attribute (UI-CT-097)", () => {
    const { container } = render(<EffectTraceSection events={EVENTS} roster={roster} />);

    const swimlane = screen.getByRole("table", { name: /効果トレース スイムレーン/ });
    expect(
      within(swimlane)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["保持", "効果", "T1", "T2", "T3"]);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });
});
