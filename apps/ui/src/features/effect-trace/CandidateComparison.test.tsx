import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CandidateComparison } from "./CandidateComparison.js";
import { buildRosterIndex } from "../details/event-formatters.js";
import type { RankCandidateComparison } from "./candidate-comparison.js";

const roster = buildRosterIndex([
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "コトハ" },
  { battleUnitId: "ally:2", unitDefinitionId: "UNIT_B", side: "ALLY", displayName: "翠蘭" },
  { battleUnitId: "ally:3", unitDefinitionId: "UNIT_C", side: "ALLY", displayName: "エレーナ" },
]);

function comparison(overrides: Partial<RankCandidateComparison> = {}): RankCandidateComparison {
  return {
    orderKey: "HIGHEST_ATTACK",
    spec: {
      orderKey: "HIGHEST_ATTACK",
      field: "attack",
      direction: "DESC",
      label: "攻撃力が最も高い",
    },
    resolvedBeforeSequence: 894,
    candidates: [
      {
        battleUnitId: "ally:1",
        value: 23484,
        initialValue: 19570,
        contributions: [{ effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP", amount: 3914 }],
        isChosen: true,
      },
      {
        battleUnitId: "ally:2",
        value: 17774,
        initialValue: 17774,
        contributions: [],
        isChosen: false,
      },
    ],
    gapToRunnerUp: { runnerUpUnitId: "ally:2", amount: 5710, ratio: 0.3212 },
    matchesReconstruction: true,
    hasUnreadableCandidate: false,
    ...overrides,
  };
}

function candidateRows(): readonly HTMLElement[] {
  const table = screen.getByRole("table", { name: /解決時点の候補/ });
  return within(table).getAllByRole("row").slice(1);
}

describe("CandidateComparison", () => {
  // UI-AC-046: 候補一覧・選択先・次点との差が読める。
  it("lists the candidates in resolution order and marks the chosen one (UI-CT-100)", () => {
    render(<CandidateComparison comparison={comparison()} roster={roster} />);

    const rows = candidateRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("コトハ");
    expect(rows[0]).toHaveTextContent("23,484");
    expect(rows[1]).toHaveTextContent("翠蘭");
    // 選ばれた候補は行のマークと、アクセシブルな名前の両方で分かるようにする。
    expect(within(rows[0]!).getByText("選択")).toBeVisible();
    expect(within(rows[1]!).queryByText("選択")).toBeNull();
  });

  it("shows the gap to the runner-up as both an amount and a percentage (UI-CT-100)", () => {
    render(<CandidateComparison comparison={comparison()} roster={roster} />);

    const gap = screen.getByText(/次点との差/);
    expect(gap).toHaveTextContent("5,710");
    expect(gap).toHaveTextContent("32.1%");
    expect(gap).toHaveTextContent("翠蘭");
  });

  // UI-AC-046: 割合バフの寄与が内訳として分かる。
  it("breaks the chosen value into its starting value and the effects in force (UI-CT-101)", () => {
    render(<CandidateComparison comparison={comparison()} roster={roster} />);

    const chosenRow = candidateRows()[0]!;
    expect(chosenRow).toHaveTextContent("19,570");
    expect(chosenRow).toHaveTextContent("ACT_KOTOHA_REBEL_AS2_ATK_UP");
    expect(chosenRow).toHaveTextContent("+3,914");
  });

  // UI-AC-046: 逆算であるという限界が明示されている。
  it("always states that the comparison is inferred from the grant, not observed (UI-CT-101)", () => {
    render(<CandidateComparison comparison={comparison()} roster={roster} />);

    expect(screen.getByText(/逆算/)).toBeVisible();
  });

  it("warns when the reconstructed top candidate is not the one that was actually chosen (UI-CT-102)", () => {
    render(
      <CandidateComparison
        comparison={comparison({ matchesReconstruction: false })}
        roster={roster}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/一致しません/);
  });

  it("warns when a candidate's value could not be read instead of presenting a partial ranking as complete (UI-CT-102)", () => {
    render(
      <CandidateComparison
        comparison={comparison({
          hasUnreadableCandidate: true,
          candidates: [
            ...comparison().candidates,
            { battleUnitId: "ally:3", contributions: [], isChosen: false },
          ],
        })}
        roster={roster}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/読めなかった/);
    // 値が読めない候補は「-」を出し、順位の数字を与えない。
    const lastRow = candidateRows()[2]!;
    expect(lastRow).toHaveTextContent("エレーナ");
    expect(lastRow).toHaveTextContent("-");
  });

  it("renders without a gap when the chosen candidate has no runner-up (UI-CT-102)", () => {
    const { gapToRunnerUp: _omitted, ...withoutGap } = comparison();
    render(
      <CandidateComparison
        comparison={{ ...withoutGap, candidates: [withoutGap.candidates[0]!] }}
        roster={roster}
      />,
    );

    expect(candidateRows()).toHaveLength(1);
    expect(screen.queryByText(/次点との差/)).toBeNull();
  });
});
