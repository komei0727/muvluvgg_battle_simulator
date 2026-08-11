import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnitEnhancementDialog } from "./UnitEnhancementDialog.js";
import type { UiViolation } from "./draft-validation.js";
import { createInitialUnitEnhancement } from "./types.js";
import type { GearInput, UnitEnhancementInput } from "./types.js";

function renderDialog(
  overrides: {
    readonly enhancement?: UnitEnhancementInput;
    readonly violations?: readonly UiViolation[];
    readonly onLevelChange?: (value: number | "") => void;
    readonly onGearChange?: (gearIndex: number, gear?: GearInput) => void;
    readonly onClose?: () => void;
  } = {},
) {
  const onLevelChange = overrides.onLevelChange ?? vi.fn();
  const onGearChange = overrides.onGearChange ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <UnitEnhancementDialog
      unitDisplayName="アルファ"
      slotKey="ally:FRONT:0"
      enhancement={overrides.enhancement ?? createInitialUnitEnhancement()}
      violations={overrides.violations ?? []}
      onLevelChange={onLevelChange}
      onGearChange={onGearChange}
      onClose={onClose}
    />,
  );
  return { onLevelChange, onGearChange, onClose };
}

describe("UnitEnhancementDialog (UI-CMP-015)", () => {
  it("UI-CT-035: opens on the unit with a level input defaulted to 200 and nine gear slots", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: /アルファ/ })).toBeInTheDocument();
    expect(screen.getByLabelText("現在レベル")).toHaveValue(200);
    expect(screen.getAllByLabelText(/ギア\d の対象ステータス/)).toHaveLength(9);
    expect(screen.getAllByLabelText(/ギア\d の種別/)).toHaveLength(9);
    expect(screen.getAllByLabelText(/ギア\d のランク/)).toHaveLength(9);
  });

  it("UI-CT-035: reports the edited level", async () => {
    const user = userEvent.setup();
    const { onLevelChange } = renderDialog();

    await user.clear(screen.getByLabelText("現在レベル"));

    expect(onLevelChange).toHaveBeenLastCalledWith("");
  });

  it("UI-CT-035: completes a gear slot only once stat, tier and grade are all chosen", async () => {
    const user = userEvent.setup();
    const { onGearChange } = renderDialog();

    await user.selectOptions(screen.getByLabelText("ギア1 の対象ステータス"), "ATTACK");

    // stat だけではギアが確定しないので、枠は空のまま報告する。
    expect(onGearChange).toHaveBeenLastCalledWith(0, undefined);
  });

  it("UI-CT-035: reports a fully specified gear, and clears it when the stat is emptied", async () => {
    const user = userEvent.setup();
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    const { onGearChange } = renderDialog({
      enhancement: {
        level: 200,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    expect(screen.getByLabelText("ギア1 の対象ステータス")).toHaveValue("ATTACK");
    expect(screen.getByLabelText("ギア1 の種別")).toHaveValue("III");
    expect(screen.getByLabelText("ギア1 のランク")).toHaveValue("S");

    await user.selectOptions(screen.getByLabelText("ギア1 の対象ステータス"), "");

    expect(onGearChange).toHaveBeenLastCalledWith(0, undefined);
  });

  it("UI-CT-035: allows the same stat in more than one gear slot", async () => {
    const user = userEvent.setup();
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    const { onGearChange } = renderDialog({
      enhancement: {
        level: 200,
        gears: [
          gear,
          { stat: "ATTACK", tier: "II", grade: "D" },
          ...Array<undefined>(7).fill(undefined),
        ],
      },
    });

    expect(screen.getByLabelText("ギア2 の対象ステータス")).toHaveValue("ATTACK");
    await user.selectOptions(screen.getByLabelText("ギア2 のランク"), "S");

    expect(onGearChange).toHaveBeenLastCalledWith(1, { stat: "ATTACK", tier: "II", grade: "S" });
  });

  it("UI-CT-037: shows a server level violation on the level input", () => {
    renderDialog({
      violations: [
        {
          path: "/allyFormation/units/0/enhancement/level",
          slotKey: "ally:FRONT:0",
          code: "SERVER_VIOLATION",
          message: 'must be 200 because "UNIT_A" declares no levelGrowth, got 220',
          severity: "error",
        },
      ],
    });

    expect(screen.getByLabelText("現在レベル")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/declares no levelGrowth/)).toBeInTheDocument();
  });

  it("UI-CT-037: shows a server gear violation on the gear slot it came from, not on the sent array index", () => {
    renderDialog({
      violations: [
        {
          path: "/allyFormation/units/0/enhancement/gears/0/tier",
          slotKey: "ally:FRONT:0",
          gearIndex: 3,
          code: "SERVER_VIOLATION",
          message: "ギアの種別が不正です。",
          severity: "error",
        },
      ],
    });

    expect(screen.getByLabelText("ギア4 の種別")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("ギア1 の種別")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("ignores violations belonging to a different slot", () => {
    renderDialog({
      violations: [
        {
          path: "/enemyFormation/units/0/enhancement/level",
          slotKey: "enemy:FRONT:0",
          code: "SERVER_VIOLATION",
          message: "他の枠のエラー",
          severity: "error",
        },
      ],
    });

    expect(screen.getByLabelText("現在レベル")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("closes on the close button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "閉じる" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the gear when its tier is emptied, instead of keeping the previous tier", async () => {
    const user = userEvent.setup();
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    const { onGearChange } = renderDialog({
      enhancement: { level: 200, gears: [gear, ...Array<undefined>(8).fill(undefined)] },
    });

    await user.selectOptions(screen.getByLabelText("ギア1 の種別"), "");

    expect(onGearChange).toHaveBeenLastCalledWith(0, undefined);
  });
});
