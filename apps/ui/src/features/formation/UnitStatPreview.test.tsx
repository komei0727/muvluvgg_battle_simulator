import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnitStatPreview } from "./UnitStatPreview.js";
import type { FormationStatPreviewUnit } from "../simulation/api-contract.js";

const UNIT: FormationStatPreviewUnit = {
  side: "ALLY",
  unitDefinitionId: "UNIT_ALLY",
  formationPosition: { column: 0, row: "FRONT" },
  maximumHp: 1050,
  combatStats: {
    attack: 105,
    defense: 125,
    criticalRate: 25,
    actionSpeed: 12,
    affinityBonus: 25,
    criticalDamageBonus: 50,
  },
  // 適性外配置＋クレバー編成補正が乗った状態を想定し、補正前とは別の値にする。
  enhancedBaseStats: {
    maximumHp: 1000,
    attack: 100,
    defense: 100,
    criticalRate: 10,
    actionSpeed: 12,
    affinityBonus: 25,
    criticalDamageBonus: 50,
  },
};

function valueFor(label: string): string {
  const term = screen.getByText(label);
  const value = term.nextElementSibling;
  if (value === null) throw new Error(`no value cell for ${label}`);
  return value.textContent ?? "";
}

describe("UnitStatPreview", () => {
  it("UI-CT-067: shows the corrected stats by default", () => {
    render(<UnitStatPreview id="p1" status="ready" unit={UNIT} />);

    expect(valueFor("最大HP")).toBe("1,050");
    expect(valueFor("攻撃力")).toBe("105");
    expect(valueFor("会心率")).toBe("25%");
  });

  it("UI-CT-068: shows the pre-correction stats when the base display is selected", () => {
    render(<UnitStatPreview id="p1" status="ready" unit={UNIT} showBase />);

    expect(valueFor("最大HP")).toBe("1,000");
    expect(valueFor("攻撃力")).toBe("100");
    expect(valueFor("防御力")).toBe("100");
    expect(valueFor("会心率")).toBe("10%");
  });

  it("UI-CT-069: names which of the two the panel is showing, so the numbers are not mistaken for each other", () => {
    const { unmount } = render(<UnitStatPreview id="p1" status="ready" unit={UNIT} />);
    expect(screen.getByText("開始時ステータス")).toBeTruthy();
    unmount();

    render(<UnitStatPreview id="p1" status="ready" unit={UNIT} showBase />);
    expect(screen.getByText("補正前ステータス")).toBeTruthy();
    // 何の補正を外しているのかを示す（切り替えても変わらない項目があるため）。
    expect(screen.getByText(/編成ボーナス・配置適性の補正なし/)).toBeTruthy();
  });

  it("UI-CT-070: reports that the pre-correction stats are unavailable instead of silently showing the corrected ones", () => {
    const { enhancedBaseStats: _dropped, ...withoutBase } = UNIT;

    render(<UnitStatPreview id="p1" status="ready" unit={withoutBase} showBase />);

    expect(screen.getByText("補正前ステータスは取得できませんでした")).toBeTruthy();
    // 補正後の値が補正前として出てはならない。
    expect(screen.queryByText("105")).toBeNull();
  });

  it("UI-CT-071: keeps reporting the fetch status regardless of which display is selected", () => {
    render(<UnitStatPreview id="p1" status="loading" showBase />);

    expect(screen.getByText("ステータスを取得中…")).toBeTruthy();
  });
});
