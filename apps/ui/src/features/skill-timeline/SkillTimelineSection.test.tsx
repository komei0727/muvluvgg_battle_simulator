import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SkillTimelineSection } from "./SkillTimelineSection.js";
import { buildRosterIndex } from "../details/event-formatters.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

const ATTACKER = "bu-ally-1";
const CASTER = "bu-ally-2";

const roster = buildRosterIndex([
  { battleUnitId: ATTACKER, unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "アタッカー" },
  { battleUnitId: CASTER, unitDefinitionId: "UNIT_B", side: "ALLY", displayName: "キャスター" },
]);

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly parentSequence?: number;
  readonly skillUseId?: string;
  readonly sourceUnitId?: string;
  readonly sourceSide?: string;
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  return {
    schemaVersion: 1,
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: [],
    stateVersionBefore: seed.sequence,
    stateVersionAfter: seed.sequence + 1,
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    ...(seed.sourceSide !== undefined ? { sourceSide: seed.sourceSide } : {}),
    details: seed.details ?? {},
  };
}

const EVENTS: readonly BattleLogEventResponse[] = [
  event({
    sequence: 1,
    type: "TARGETS_SELECTED",
    skillUseId: "su-attack",
    sourceUnitId: ATTACKER,
    details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
  }),
  event({
    sequence: 2,
    type: "TARGETS_SELECTED",
    skillUseId: "su-cast",
    sourceUnitId: CASTER,
    details: { skillDefinitionId: "SKL_CAST", bindings: [] },
  }),
  event({
    sequence: 3,
    type: "MEMORY_TRIGGERED",
    skillUseId: "su-memory",
    sourceSide: "ALLY",
    details: {
      memoryDefinitionId: "MEM_X",
      triggeredEffectIndex: 0,
      sourceSide: "ALLY",
      triggerEventId: "evt-1",
    },
  }),
];

describe("SkillTimelineSection", () => {
  // UI-AC-053: ユニットを選んで、そのユニットのスキル発動の表示/非表示を切り替えられる。
  it("unchecking a unit hides that unit's activation rows", async () => {
    const user = userEvent.setup();
    render(<SkillTimelineSection events={EVENTS} roster={roster} />);

    expect(screen.getByRole("button", { name: /SKL_ATTACK/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SKL_CAST/ })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /アタッカー/ }));

    expect(screen.queryByRole("button", { name: /SKL_ATTACK/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SKL_CAST/ })).toBeInTheDocument();
  });

  // UI-AC-053: スキルを選んで、そのスキルの発動の表示/非表示を切り替えられる。
  it("unchecking a skill hides that skill's activation rows", async () => {
    const user = userEvent.setup();
    render(<SkillTimelineSection events={EVENTS} roster={roster} />);

    await user.click(screen.getByRole("checkbox", { name: "SKL_ATTACK" }));

    expect(screen.queryByRole("button", { name: /SKL_ATTACK/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SKL_CAST/ })).toBeInTheDocument();
  });

  // UI-AC-053: ユニット・スキルの2系統フィルタはAND条件で絞り込む。
  it("applies unit and skill filters as an AND condition", async () => {
    const user = userEvent.setup();
    render(<SkillTimelineSection events={EVENTS} roster={roster} />);

    // アタッカーのユニットだけ残し、SKL_CASTのスキルだけ残す -> 両方満たす行はゼロ件になる。
    await user.click(screen.getByRole("checkbox", { name: /キャスター/ }));
    await user.click(screen.getByRole("checkbox", { name: "SKL_ATTACK" }));

    expect(screen.queryByRole("button", { name: /SKL_ATTACK/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /SKL_CAST/ })).not.toBeInTheDocument();
  });

  // UI-AC-053: 発動を開くと、その解決に属するイベントだけの因果ツリーが見える。
  it("expands a row to reveal its scoped causality tree, and collapses again on second click", async () => {
    const user = userEvent.setup();
    render(<SkillTimelineSection events={EVENTS} roster={roster} />);

    const toggle = screen.getByRole("button", { name: /SKL_ATTACK/ });
    const row = toggle.closest("li")!;

    expect(within(row).queryByRole("button", { name: /TARGETS_SELECTED/ })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(within(row).getByRole("button", { name: /TARGETS_SELECTED/ })).toBeInTheDocument();

    await user.click(toggle);
    expect(within(row).queryByRole("button", { name: /TARGETS_SELECTED/ })).not.toBeInTheDocument();
  });

  it("excludes a Memory-origin activation entirely: no row and no checkbox in either fieldset", () => {
    render(<SkillTimelineSection events={EVENTS} roster={roster} />);

    expect(screen.queryByRole("button", { name: /MEM_X/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /MEM_X/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /メモリー/ })).not.toBeInTheDocument();
  });

  // UI-AC-053: ユニットを外すと、そのユニット専用のスキルはスキル一覧からも消える
  // （他ユニットとも共有されるスキルなら、そのユニットが残っている限り一覧に残る）。
  it("removes a unit's exclusive skill from the skill fieldset when that unit is unchecked", async () => {
    const user = userEvent.setup();
    render(<SkillTimelineSection events={EVENTS} roster={roster} />);

    expect(screen.getByRole("checkbox", { name: "SKL_ATTACK" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "SKL_CAST" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /アタッカー/ }));

    expect(screen.queryByRole("checkbox", { name: "SKL_ATTACK" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "SKL_CAST" })).toBeInTheDocument();

    // 再度チェックすると一覧へ戻り、以前の選択状態(選択済み)も保たれている。
    await user.click(screen.getByRole("checkbox", { name: /アタッカー/ }));
    const restoredCheckbox = screen.getByRole("checkbox", { name: "SKL_ATTACK" });
    expect(restoredCheckbox).toBeInTheDocument();
    expect(restoredCheckbox).toBeChecked();
  });
});
