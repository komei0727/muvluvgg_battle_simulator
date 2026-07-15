import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ValidationSummary } from "./ValidationSummary.js";
import type { UiViolation } from "./draft-validation.js";

describe("ValidationSummary", () => {
  it("renders nothing when there are no violations", () => {
    const { container } = render(<ValidationSummary violations={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("lists error messages distinctly from warning messages", () => {
    const violations: readonly UiViolation[] = [
      {
        path: "/allyFormation/units",
        code: "UNIT_COUNT_OUT_OF_RANGE",
        message: "味方ユニットを1～5体設定してください。",
        severity: "error",
      },
      {
        path: "/allyFormation/units",
        slotKey: "ally:REAR:0",
        code: "APTITUDE_MISMATCH",
        message: "適性外の配置です。",
        severity: "warning",
      },
    ];

    render(<ValidationSummary violations={violations} />);

    expect(screen.getByText("味方ユニットを1～5体設定してください。")).toBeInTheDocument();
    expect(screen.getByText("適性外の配置です。")).toBeInTheDocument();
  });

  it("only renders a single occurrence per unique message", () => {
    const violations: readonly UiViolation[] = [
      {
        path: "/allyFormation/units",
        slotKey: "ally:FRONT:0",
        code: "UNSUPPORTED_DEFINITION",
        message: "未対応の戦闘ルールを必要とする定義は選択できません。",
        severity: "error",
      },
      {
        path: "/allyFormation/units",
        slotKey: "ally:FRONT:1",
        code: "UNSUPPORTED_DEFINITION",
        message: "未対応の戦闘ルールを必要とする定義は選択できません。",
        severity: "error",
      },
    ];

    render(<ValidationSummary violations={violations} />);

    expect(
      screen.getAllByText("未対応の戦闘ルールを必要とする定義は選択できません。"),
    ).toHaveLength(1);
  });
});
