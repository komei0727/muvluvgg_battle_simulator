import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import { FormationEditor } from "./FormationEditor.js";
import { createInitialDraft, slotKeyOf } from "./types.js";

function catalog(): BattleSimulationCatalogResponse {
  return {
    schemaVersion: 1,
    catalogRevision: "rev-1",
    units: [
      {
        unitDefinitionId: "UNIT_A",
        displayName: "アルファ",
        characterName: "Alpha",
        attribute: "CUTE",
        unitType: "ATTACKER",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT"],
        selectable: true,
        unavailableCapabilities: [],
      },
    ],
    memories: [],
  };
}

describe("FormationEditor", () => {
  it("renders a side heading and 6 unit slots + 6 memory slots", () => {
    const draft = createInitialDraft();
    render(
      <FormationEditor
        side="ally"
        slots={draft.allySlots}
        memoryDefinitionIds={draft.allyMemoryDefinitionIds}
        catalog={catalog()}
        violations={[]}
        disabled={false}
        onOpenUnitSelection={vi.fn()}
        onOpenMemorySelection={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: /メモリー\d+を追加/ })).toHaveLength(6);
  });

  // Review (PR #119): FRONT/REAR was only distinguishable via each slot's
  // accessible name, not visually. docs/ui-design/01_UI要求・画面設計.md §5.1
  // requires a visible "FRONT / 前衛" / "REAR / 後衛" row heading.
  it("shows a visible FRONT/REAR row heading, not just accessible names", () => {
    const draft = createInitialDraft();
    render(
      <FormationEditor
        side="ally"
        slots={draft.allySlots}
        memoryDefinitionIds={draft.allyMemoryDefinitionIds}
        catalog={catalog()}
        violations={[]}
        disabled={false}
        onOpenUnitSelection={vi.fn()}
        onOpenMemorySelection={vi.fn()}
      />,
    );

    expect(screen.getByText("FRONT / 前衛")).toBeInTheDocument();
    expect(screen.getByText("REAR / 後衛")).toBeInTheDocument();
  });

  it("resolves the catalog unit for a filled slot and shows its display name", () => {
    const draft = createInitialDraft();
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const slots = draft.allySlots.map((slot) =>
      slot.slotKey === slotKey ? { ...slot, unitDefinitionId: "UNIT_A" } : slot,
    );

    render(
      <FormationEditor
        side="ally"
        slots={slots}
        memoryDefinitionIds={draft.allyMemoryDefinitionIds}
        catalog={catalog()}
        violations={[]}
        disabled={false}
        onOpenUnitSelection={vi.fn()}
        onOpenMemorySelection={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /アルファ/ })).toBeInTheDocument();
  });

  it("calls onOpenUnitSelection with the slotKey when an empty unit slot is activated", async () => {
    const user = userEvent.setup();
    const draft = createInitialDraft();
    const onOpenUnitSelection = vi.fn();
    render(
      <FormationEditor
        side="ally"
        slots={draft.allySlots}
        memoryDefinitionIds={draft.allyMemoryDefinitionIds}
        catalog={catalog()}
        violations={[]}
        disabled={false}
        onOpenUnitSelection={onOpenUnitSelection}
        onOpenMemorySelection={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "前衛1にユニットを追加" }));

    expect(onOpenUnitSelection).toHaveBeenCalledWith(slotKeyOf("ally", "FRONT", 0));
  });

  it("calls onOpenMemorySelection with the side and index when a memory slot is activated", async () => {
    const user = userEvent.setup();
    const draft = createInitialDraft();
    const onOpenMemorySelection = vi.fn();
    render(
      <FormationEditor
        side="enemy"
        slots={draft.enemySlots}
        memoryDefinitionIds={draft.enemyMemoryDefinitionIds}
        catalog={catalog()}
        violations={[]}
        disabled={false}
        onOpenUnitSelection={vi.fn()}
        onOpenMemorySelection={onOpenMemorySelection}
      />,
    );

    await user.click(screen.getByRole("button", { name: "メモリー1を追加" }));

    expect(onOpenMemorySelection).toHaveBeenCalledWith("enemy", 0);
  });

  it("disables every slot when disabled is true", () => {
    const draft = createInitialDraft();
    render(
      <FormationEditor
        side="ally"
        slots={draft.allySlots}
        memoryDefinitionIds={draft.allyMemoryDefinitionIds}
        catalog={catalog()}
        violations={[]}
        disabled={true}
        onOpenUnitSelection={vi.fn()}
        onOpenMemorySelection={vi.fn()}
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("shows an off-aptitude warning badge only for the slot with an APTITUDE_MISMATCH violation", () => {
    const draft = createInitialDraft();
    const slotKey = slotKeyOf("ally", "REAR", 0);
    const slots = draft.allySlots.map((slot) =>
      slot.slotKey === slotKey ? { ...slot, unitDefinitionId: "UNIT_A" } : slot,
    );

    render(
      <FormationEditor
        side="ally"
        slots={slots}
        memoryDefinitionIds={draft.allyMemoryDefinitionIds}
        catalog={catalog()}
        violations={[
          {
            path: "/allyFormation/units",
            slotKey,
            code: "APTITUDE_MISMATCH",
            message: "適性外の配置です。",
            severity: "warning",
          },
        ]}
        disabled={false}
        onOpenUnitSelection={vi.fn()}
        onOpenMemorySelection={vi.fn()}
      />,
    );

    expect(screen.getByText("適性外")).toBeInTheDocument();
  });
});
