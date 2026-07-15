import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnitSummaryTable } from "./UnitSummaryTable.js";
import type { SummaryRow } from "./summary-projector.js";

function row(overrides: Partial<SummaryRow> & { battleUnitId: string }): SummaryRow {
  return {
    roster: {
      battleUnitId: overrides.battleUnitId,
      unitDefinitionId: "UNIT_A",
      side: "ALLY",
      displayName: "エーユニット",
    },
    summary: {
      battleUnitId: overrides.battleUnitId,
      damageDealt: 100,
      damageTaken: 50,
      healingDone: 0,
      combatStatus: "ACTIVE",
      finalHp: 900,
      maximumHp: 1000,
    },
    ...overrides,
  };
}

describe("UnitSummaryTable", () => {
  it("shows the DAMAGE/DEFENSE/HEAL/STATUS columns (UI-AC-009)", () => {
    render(<UnitSummaryTable side="ally" rows={[row({ battleUnitId: "ally:1" })]} />);

    expect(screen.getByRole("columnheader", { name: /DAMAGE/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /DEFENSE/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /HEAL/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /STATUS/ })).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
  });

  it("renders duplicate unitDefinitionId participants as separate rows keyed by battleUnitId (UI-AC-008)", () => {
    render(
      <UnitSummaryTable
        side="ally"
        rows={[
          row({ battleUnitId: "ally:1" }),
          row({
            battleUnitId: "ally:2",
            summary: { ...row({ battleUnitId: "ally:2" }).summary, damageDealt: 200 },
          }),
        ]}
      />,
    );

    expect(screen.getAllByText("エーユニット")).toHaveLength(2);
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("labels the ally and enemy sides", () => {
    const { rerender } = render(<UnitSummaryTable side="ally" rows={[]} />);
    expect(screen.getByText("ALLY UNIT SUMMARY")).toBeInTheDocument();

    rerender(<UnitSummaryTable side="enemy" rows={[]} />);
    expect(screen.getByText("ENEMY UNIT SUMMARY")).toBeInTheDocument();
  });
});
