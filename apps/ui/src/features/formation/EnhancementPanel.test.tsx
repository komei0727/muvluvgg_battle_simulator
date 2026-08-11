import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnhancementPanel } from "./EnhancementPanel.js";
import type { UiViolation } from "./draft-validation.js";
import type { SideEnhancementInput } from "./types.js";

function enhancement(overrides: Partial<SideEnhancementInput> = {}): SideEnhancementInput {
  return {
    enabled: true,
    academyLevels: {
      unitTypes: { PHYSICAL: 1, ENERGY: 1, AGILE: 1 },
      attributes: { AGGRESSIVE: 1, SHY: 1, CUTE: 1, SMART: 1, COMICAL: 1, CLEVER: 1 },
    },
    ...overrides,
  };
}

function renderPanel(
  overrides: {
    readonly enhancement?: SideEnhancementInput;
    readonly violations?: readonly UiViolation[];
    readonly disabled?: boolean;
    readonly onToggle?: (enabled: boolean) => void;
    readonly onAcademyLevelChange?: (
      group: "unitTypes" | "attributes",
      key: string,
      value: number | "",
    ) => void;
  } = {},
) {
  const onToggle = overrides.onToggle ?? vi.fn();
  const onAcademyLevelChange = overrides.onAcademyLevelChange ?? vi.fn();
  render(
    <EnhancementPanel
      side="ally"
      enhancement={overrides.enhancement ?? enhancement()}
      violations={overrides.violations ?? []}
      disabled={overrides.disabled ?? false}
      onToggle={onToggle}
      onAcademyLevelChange={onAcademyLevelChange}
    />,
  );
  return { onToggle, onAcademyLevelChange };
}

describe("EnhancementPanel (UI-CMP-014)", () => {
  it("UI-CT-034: shows all nine academy level inputs — three unit types and six attributes", () => {
    renderPanel();

    for (const label of ["物理", "EN", "敏捷"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    for (const label of [
      "アグレッシブ",
      "シャイ",
      "キュート",
      "スマート",
      "コミカル",
      "クレバー",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("spinbutton")).toHaveLength(9);
  });

  it("reports a toggle change without changing the inputs itself", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderPanel({ enhancement: enhancement({ enabled: false }) });

    await user.click(screen.getByRole("checkbox", { name: /強化/ }));

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("disables every academy level input while the toggle is off, keeping the values on screen", () => {
    renderPanel({
      enhancement: {
        enabled: false,
        academyLevels: {
          unitTypes: { PHYSICAL: 50, ENERGY: 1, AGILE: 1 },
          attributes: { AGGRESSIVE: 1, SHY: 1, CUTE: 1, SMART: 1, COMICAL: 1, CLEVER: 1 },
        },
      },
    });

    expect(screen.getByLabelText("物理")).toBeDisabled();
    expect(screen.getByLabelText("物理")).toHaveValue(50);
  });

  it("reports the edited academy level with its group and key", async () => {
    const user = userEvent.setup();
    const { onAcademyLevelChange } = renderPanel();

    await user.clear(screen.getByLabelText("クレバー"));

    expect(onAcademyLevelChange).toHaveBeenLastCalledWith("attributes", "CLEVER", "");
  });

  it("UI-CT-034/UI-CT-037: shows the violation of one academy level on that input only", () => {
    renderPanel({
      violations: [
        {
          path: "/allyFormation/enhancement/academyLevels/unitTypes/ENERGY",
          code: "ACADEMY_LEVEL_INVALID",
          message: "学園レベルは1以上の整数で入力してください。",
          severity: "error",
        },
      ],
    });

    expect(screen.getByLabelText("EN")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("物理")).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("学園レベルは1以上の整数で入力してください。")).toBeInTheDocument();
  });

  it("uses the enemy formation's own violation paths", () => {
    render(
      <EnhancementPanel
        side="enemy"
        enhancement={enhancement()}
        violations={[
          {
            path: "/enemyFormation/enhancement/academyLevels/attributes/SHY",
            code: "ACADEMY_LEVEL_INVALID",
            message: "学園レベルは1以上の整数で入力してください。",
            severity: "error",
          },
        ]}
        disabled={false}
        onToggle={vi.fn()}
        onAcademyLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("シャイ")).toHaveAttribute("aria-invalid", "true");
  });

  it("disables the toggle itself while the whole form is disabled (submitting)", () => {
    renderPanel({ disabled: true });

    expect(screen.getByRole("checkbox", { name: /強化/ })).toBeDisabled();
    expect(screen.getByLabelText("物理")).toBeDisabled();
  });
});
