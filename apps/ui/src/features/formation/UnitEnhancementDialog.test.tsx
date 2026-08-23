import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnitEnhancementDialog } from "./UnitEnhancementDialog.js";
import type {
  GearInput,
  LevelLinkInput,
  UnitEnhancementInput,
} from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";
import type { CatalogGearEffect } from "../../shared/api/api-contract.js";
import { GEAR_STATS, createInitialDraft, createInitialUnitEnhancement } from "./types.js";

function renderDialog(
  overrides: {
    readonly enhancement?: UnitEnhancementInput;
    readonly violations?: readonly UiViolation[];
    readonly gearEffects?: readonly CatalogGearEffect[];
    readonly levelLink?: LevelLinkInput;
    readonly onLevelChange?: (value: number | "") => void;
    readonly onGearChange?: (gearIndex: number, gear?: GearInput) => void;
    readonly onLinkExclusionChange?: (excluded: boolean) => void;
    readonly onClose?: () => void;
  } = {},
) {
  const onLevelChange = overrides.onLevelChange ?? vi.fn();
  const onGearChange = overrides.onGearChange ?? vi.fn();
  const onLinkExclusionChange = overrides.onLinkExclusionChange ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <UnitEnhancementDialog
      unitDisplayName="アルファ"
      slotKey="ally:FRONT:0"
      enhancement={overrides.enhancement ?? createInitialUnitEnhancement()}
      violations={overrides.violations ?? []}
      {...(overrides.gearEffects !== undefined ? { gearEffects: overrides.gearEffects } : {})}
      sideEnhancement={{
        ...createInitialDraft().allyEnhancement,
        enabled: true,
        levelLink: overrides.levelLink ?? { enabled: false, level: 200 },
      }}
      onLevelChange={onLevelChange}
      onGearChange={onGearChange}
      onLinkExclusionChange={onLinkExclusionChange}
      onClose={onClose}
    />,
  );
  return { onLevelChange, onGearChange, onLinkExclusionChange, onClose };
}

/** APIが公開する効果表（R-ENH-04 #3）のうち、このテストが使う2ステータス分。 */
const GEAR_EFFECTS: readonly CatalogGearEffect[] = [
  {
    stat: "ATTACK",
    application: "RATIO",
    values: [
      { tier: "II", grade: "D", percentagePoints: 0.75 },
      { tier: "II", grade: "S", percentagePoints: 2.49 },
      { tier: "III", grade: "D", percentagePoints: 1 },
      { tier: "III", grade: "S", percentagePoints: 3.33 },
    ],
  },
  {
    stat: "CRITICAL_RATE",
    application: "POINT",
    values: [
      { tier: "II", grade: "D", percentagePoints: 1.5 },
      { tier: "II", grade: "S", percentagePoints: 5.25 },
      { tier: "III", grade: "D", percentagePoints: 2 },
      { tier: "III", grade: "S", percentagePoints: 7 },
    ],
  },
];

describe("UnitEnhancementDialog (UI-CMP-015)", () => {
  it("UI-CT-120: opens on the unit with a level input defaulted to 200 and nine gear slots", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: /アルファ/ })).toBeInTheDocument();
    expect(screen.getByLabelText("現在レベル")).toHaveValue(200);
    expect(screen.getAllByLabelText(/ギア\d の対象ステータス/)).toHaveLength(9);
    expect(screen.getAllByLabelText(/ギア\d の種別/)).toHaveLength(9);
    expect(screen.getAllByLabelText(/ギア\d のランク/)).toHaveLength(9);
  });

  it("UI-CT-121: reports the edited level", async () => {
    const user = userEvent.setup();
    const { onLevelChange } = renderDialog();

    await user.clear(screen.getByLabelText("現在レベル"));

    expect(onLevelChange).toHaveBeenLastCalledWith("");
  });

  it("UI-CT-122: completes a gear slot only once stat, tier and grade are all chosen", async () => {
    const user = userEvent.setup();
    const { onGearChange } = renderDialog();

    await user.selectOptions(screen.getByLabelText("ギア1 の対象ステータス"), "ATTACK");

    // stat だけではギアが確定しないので、枠は空のまま報告する。
    expect(onGearChange).toHaveBeenLastCalledWith(0, undefined);
  });

  it("UI-CT-123: reports a fully specified gear, and clears it when the stat is emptied", async () => {
    const user = userEvent.setup();
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    const { onGearChange } = renderDialog({
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    expect(screen.getByLabelText("ギア1 の対象ステータス")).toHaveValue("ATTACK");
    expect(screen.getByLabelText("ギア1 の種別")).toHaveValue("III");
    expect(screen.getByLabelText("ギア1 のランク")).toHaveValue("S");

    await user.selectOptions(screen.getByLabelText("ギア1 の対象ステータス"), "");

    expect(onGearChange).toHaveBeenLastCalledWith(0, undefined);
  });

  it("UI-CT-124: allows the same stat in more than one gear slot", async () => {
    const user = userEvent.setup();
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    const { onGearChange } = renderDialog({
      enhancement: {
        level: 200,
        linkExcluded: false,
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

  it("UI-CT-092: drops a stat that already fills its three gears from the other slots' options", () => {
    const attack: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    renderDialog({
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [attack, attack, attack, ...Array<undefined>(6).fill(undefined)],
      },
    });

    // 空枠からは選べない（同一ステータスは3枚まで）。
    const empty = screen.getByLabelText("ギア4 の対象ステータス");
    expect(within(empty).queryByRole("option", { name: "攻撃力" })).not.toBeInTheDocument();
    // 上限に達していない他のステータスはそのまま選べる。
    expect(within(empty).getByRole("option", { name: "防御力" })).toBeInTheDocument();
  });

  it("UI-CT-125: keeps the editing slot's own stat selectable so its tier and rank stay editable", async () => {
    const user = userEvent.setup();
    const attack: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    const { onGearChange } = renderDialog({
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [attack, attack, attack, ...Array<undefined>(6).fill(undefined)],
      },
    });

    // 3枚目の枠自身は「攻撃力」を持っているため、選択肢から外さない。外すと
    // 同じ値のまま種別・ランクだけを変えられなくなる。
    const third = screen.getByLabelText("ギア3 の対象ステータス");
    expect(within(third).getByRole("option", { name: "攻撃力" })).toBeInTheDocument();
    expect(third).toHaveValue("ATTACK");

    await user.selectOptions(screen.getByLabelText("ギア3 の種別"), "II");

    expect(onGearChange).toHaveBeenLastCalledWith(2, { stat: "ATTACK", tier: "II", grade: "S" });
  });

  it("UI-CT-093: keeps the fields of a slot that has no selectable stat left, and says so", () => {
    // 7ステータスすべてが3枚ずつ埋まった枠。`GEAR_SLOT_COUNT`が9である限り
    // 実データでは起こらないが、選択肢が空の枠でも入力欄を消さないことを固定する。
    const filled = GEAR_STATS.flatMap((stat) =>
      Array.from({ length: 3 }, (): GearInput => ({ stat, tier: "III", grade: "S" })),
    );
    renderDialog({
      enhancement: { level: 200, linkExcluded: false, gears: [...filled, undefined] },
    });

    const empty = screen.getByLabelText(`ギア${String(filled.length + 1)} の対象ステータス`);
    expect(empty).toBeInTheDocument();
    expect(within(empty).queryByRole("option", { name: "攻撃力" })).not.toBeInTheDocument();
    expect(screen.getByText("選べるステータスがありません")).toBeInTheDocument();
  });

  it("UI-CT-094: shows the over-limit warning on the gear slot it belongs to", () => {
    const attack: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    renderDialog({
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [attack, attack, attack, attack, ...Array<undefined>(5).fill(undefined)],
      },
      violations: [
        {
          path: "/allyFormation/units/enhancement/gears",
          slotKey: "ally:FRONT:0",
          gearIndex: 3,
          code: "GEAR_STAT_COUNT_OVER_LIMIT",
          message: "アルファの攻撃力のギアが4枚あります。同一ステータスのギアは3枚までです。",
          severity: "warning",
        },
      ],
    });

    const warning = screen.getByText(
      "アルファの攻撃力のギアが4枚あります。同一ステータスのギアは3枚までです。",
    );
    // 警告はエラーではないため`aria-invalid`は立てないが、入力へは結びつける。
    const stat = screen.getByLabelText("ギア4 の対象ステータス");
    expect(stat).toHaveAttribute("aria-invalid", "false");
    expect(stat.getAttribute("aria-describedby")?.split(" ")).toContain(warning.id);
  });

  it("UI-CT-118: shows a server level violation on the level input", () => {
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

  it("UI-CT-119: shows a server gear violation on the gear slot it came from, not on the sent array index", () => {
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

  it("UI-CT-041: annotates the tier and grade options with the increase the chosen combination gives, using % for a ratio stat", () => {
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    renderDialog({
      gearEffects: GEAR_EFFECTS,
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    const tier = within(screen.getByLabelText("ギア1 の種別"));
    // ランクSが選ばれているので、種別の選択肢はそのランクでの上昇値を示す。
    expect(tier.getByRole("option", { name: "ギアII（+2.49%）" })).toBeInTheDocument();
    expect(tier.getByRole("option", { name: "ギアIII（+3.33%）" })).toBeInTheDocument();

    const grade = within(screen.getByLabelText("ギア1 のランク"));
    expect(grade.getByRole("option", { name: "D（+1%）" })).toBeInTheDocument();
    expect(grade.getByRole("option", { name: "S（+3.33%）" })).toBeInTheDocument();
  });

  it("UI-CT-126: distinguishes a point addition from a ratio correction in the notation (R-ENH-06)", () => {
    const gear: GearInput = { stat: "CRITICAL_RATE", tier: "III", grade: "S" };
    renderDialog({
      gearEffects: GEAR_EFFECTS,
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    const grade = within(screen.getByLabelText("ギア1 のランク"));
    expect(grade.getByRole("option", { name: "D（+2%pt）" })).toBeInTheDocument();
    expect(grade.getByRole("option", { name: "S（+7%pt）" })).toBeInTheDocument();
  });

  it("UI-CT-042: shows the range across the other axis while only the stat is chosen", () => {
    const gear = { stat: "ATTACK" } as unknown as GearInput;
    renderDialog({
      gearEffects: GEAR_EFFECTS,
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    const tier = within(screen.getByLabelText("ギア1 の種別"));
    expect(tier.getByRole("option", { name: "ギアIII（+1〜3.33%）" })).toBeInTheDocument();
  });

  it("UI-CT-043: falls back to plain rank names when the response carries no gear effect table", () => {
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    renderDialog({
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    const grade = within(screen.getByLabelText("ギア1 のランク"));
    expect(grade.getByRole("option", { name: "S" })).toBeInTheDocument();
    expect(screen.queryByText(/%pt/)).not.toBeInTheDocument();
  });

  it("UI-CT-127: falls back to plain names for a stat the published table does not cover", () => {
    const gear: GearInput = { stat: "DEFENSE", tier: "III", grade: "S" };
    renderDialog({
      gearEffects: GEAR_EFFECTS,
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    const grade = within(screen.getByLabelText("ギア1 のランク"));
    expect(grade.getByRole("option", { name: "S" })).toBeInTheDocument();
  });

  it("clears the gear when its tier is emptied, instead of keeping the previous tier", async () => {
    const user = userEvent.setup();
    const gear: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };
    const { onGearChange } = renderDialog({
      enhancement: {
        level: 200,
        linkExcluded: false,
        gears: [gear, ...Array<undefined>(8).fill(undefined)],
      },
    });

    await user.selectOptions(screen.getByLabelText("ギア1 の種別"), "");

    expect(onGearChange).toHaveBeenLastCalledWith(0, undefined);
  });
});

// docs/ui-design/01_UI要求・画面設計.md §5.7「リンクから外す」（UI-AC-036/037、UI-CMP-024）
describe("UnitEnhancementDialog — レベルリンク", () => {
  const linked: LevelLinkInput = { enabled: true, level: 260 };

  it("hides the exclusion control while the side's link is off", () => {
    renderDialog();

    expect(screen.queryByRole("checkbox", { name: /リンク/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("現在レベル")).not.toHaveAttribute("readonly");
  });

  // UI-CT-076
  it("shows the link level read-only while the slot follows the link", () => {
    renderDialog({
      levelLink: linked,
      enhancement: { ...createInitialUnitEnhancement(), level: 180 },
    });

    const level = screen.getByLabelText("現在レベル");
    expect(level).toHaveValue(260);
    // `disabled`にはしない——focusできなくなると、この入力へ結びつけたサーバー違反の
    // 説明が読み上げから外れる（UI-AC-039）。
    expect(level).toHaveAttribute("readonly");
    expect(screen.getByText(/レベルリンク中（Lv260）/)).toBeInTheDocument();
  });

  it("reports the exclusion intent without editing the level itself", async () => {
    const user = userEvent.setup();
    const { onLinkExclusionChange, onLevelChange } = renderDialog({
      levelLink: linked,
      enhancement: { ...createInitialUnitEnhancement(), level: 180 },
    });

    await user.click(screen.getByRole("checkbox", { name: "レベルリンクから外す" }));

    expect(onLinkExclusionChange).toHaveBeenCalledWith(true);
    expect(onLevelChange).not.toHaveBeenCalled();
  });

  it("edits the slot's own level again once the slot is excluded", async () => {
    const user = userEvent.setup();
    const { onLevelChange } = renderDialog({
      levelLink: linked,
      enhancement: { ...createInitialUnitEnhancement(), level: 180, linkExcluded: true },
    });

    const level = screen.getByLabelText("現在レベル");
    expect(level).toHaveValue(180);
    expect(level).not.toHaveAttribute("readonly");
    expect(screen.getByRole("checkbox", { name: "レベルリンクから外す" })).toBeChecked();

    await user.clear(level);

    expect(onLevelChange).toHaveBeenLastCalledWith("");
  });

  // UI-CT-079: R-ENH-05 #5 の422はリンク中でも該当入力へ出し、逃げ道を示す。
  it("keeps showing a server violation on the read-only level input, with the way out", () => {
    renderDialog({
      levelLink: linked,
      violations: [
        {
          path: "/allyFormation/units/0/enhancement/level",
          slotKey: "ally:FRONT:0",
          code: "SERVER_VIOLATION",
          message: 'must be 200 because "UNIT_A" declares no levelGrowth, got 260',
          severity: "error",
        },
      ],
    });

    const level = screen.getByLabelText("現在レベル");
    expect(level).toHaveAttribute("readonly");
    expect(level).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/declares no levelGrowth/)).toBeInTheDocument();
    const wayOut = screen.getByText(
      "成長値を持たないユニットはレベル200だけを受け付けます。「レベルリンクから外す」を選び、レベルを200に戻してください。",
    );
    expect(wayOut).toBeInTheDocument();
    // UI-AC-039: 逃げ道の文言も入力へ結びつける（`readOnly`を選んだ理由と同じ）。
    expect(level.getAttribute("aria-describedby")?.split(" ")).toContain(wayOut.id);
  });

  it("does not show the way-out hint while the level is valid", () => {
    renderDialog({ levelLink: linked });

    expect(screen.queryByText(/レベルを200に戻してください/)).not.toBeInTheDocument();
  });
});
