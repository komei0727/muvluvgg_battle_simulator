import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnhancementPanel } from "./EnhancementPanel.js";
import type { SideEnhancementInput } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";

function enhancement(overrides: Partial<SideEnhancementInput> = {}): SideEnhancementInput {
  return {
    enabled: true,
    levelLink: { enabled: false, level: 200 },
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
    readonly onLevelLinkToggle?: (enabled: boolean) => void;
    readonly onLevelLinkChange?: (value: number | "") => void;
  } = {},
) {
  const onToggle = overrides.onToggle ?? vi.fn();
  const onAcademyLevelChange = overrides.onAcademyLevelChange ?? vi.fn();
  const onLevelLinkToggle = overrides.onLevelLinkToggle ?? vi.fn();
  const onLevelLinkChange = overrides.onLevelLinkChange ?? vi.fn();
  render(
    <EnhancementPanel
      side="ally"
      enhancement={overrides.enhancement ?? enhancement()}
      violations={overrides.violations ?? []}
      disabled={overrides.disabled ?? false}
      onToggle={onToggle}
      onAcademyLevelChange={onAcademyLevelChange}
      onLevelLinkToggle={onLevelLinkToggle}
      onLevelLinkChange={onLevelLinkChange}
    />,
  );
  return { onToggle, onAcademyLevelChange, onLevelLinkToggle, onLevelLinkChange };
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
    // 9項目＋リンクレベル（UI-AC-035）。学園レベルの側は上のラベルで固定している。
    expect(screen.getAllByRole("spinbutton")).toHaveLength(10);
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
        levelLink: { enabled: false, level: 200 },
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
        onLevelLinkToggle={vi.fn()}
        onLevelLinkChange={vi.fn()}
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

// docs/ui-design/01_UI要求・画面設計.md §5.6「レベルリンク」（UI-AC-035 / UI-CMP-023）
describe("EnhancementPanel — レベルリンク", () => {
  it("reports the link toggle without touching the link level", async () => {
    const user = userEvent.setup();
    const { onLevelLinkToggle, onLevelLinkChange } = renderPanel();

    await user.click(screen.getByRole("checkbox", { name: "レベルリンク" }));

    expect(onLevelLinkToggle).toHaveBeenCalledWith(true);
    expect(onLevelLinkChange).not.toHaveBeenCalled();
  });

  it("disables the link level input while the link is off, keeping the value on screen", () => {
    renderPanel({ enhancement: enhancement({ levelLink: { enabled: false, level: 250 } }) });

    expect(screen.getByLabelText("リンクレベル")).toBeDisabled();
    expect(screen.getByLabelText("リンクレベル")).toHaveValue(250);
  });

  it("enables the link level input once the link is on", () => {
    renderPanel({ enhancement: enhancement({ levelLink: { enabled: true, level: 250 } }) });

    expect(screen.getByLabelText("リンクレベル")).toBeEnabled();
    expect(
      screen.getByText("リンクを外したユニット以外は、レベルがこの値になります。"),
    ).toBeInTheDocument();
  });

  it("disables both link controls while the side enhancement toggle is off", () => {
    renderPanel({
      enhancement: enhancement({ enabled: false, levelLink: { enabled: true, level: 250 } }),
    });

    expect(screen.getByRole("checkbox", { name: "レベルリンク" })).toBeDisabled();
    expect(screen.getByLabelText("リンクレベル")).toBeDisabled();
  });

  it("reports the edited link level, including a cleared input", async () => {
    const user = userEvent.setup();
    const { onLevelLinkChange } = renderPanel({
      enhancement: enhancement({ levelLink: { enabled: true, level: 250 } }),
    });

    await user.clear(screen.getByLabelText("リンクレベル"));

    expect(onLevelLinkChange).toHaveBeenLastCalledWith("");
  });

  it("shows a LEVEL_LINK_INVALID violation on the link level input", () => {
    renderPanel({
      enhancement: enhancement({ levelLink: { enabled: true, level: "" } }),
      violations: [
        {
          path: "/allyFormation/enhancement/levelLink/level",
          code: "LEVEL_LINK_INVALID",
          message: "リンクレベルは1以上の整数で入力してください。",
          severity: "error",
        },
      ],
    });

    expect(screen.getByLabelText("リンクレベル")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("リンクレベルは1以上の整数で入力してください。")).toBeInTheDocument();
  });
});
