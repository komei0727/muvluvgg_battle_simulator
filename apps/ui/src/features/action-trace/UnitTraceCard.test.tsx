import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TraceUnitCardView } from "./trace-board-view.js";
import { UnitTraceCard } from "./UnitTraceCard.js";

const BASE: TraceUnitCardView = {
  battleUnitId: "enemy:1",
  side: "ENEMY",
  column: 0,
  row: "FRONT",
  displayName: "【夜の帳】敵ユニット",
  name: "敵ユニット",
  hp: { before: 1000, after: 1000, maximum: 1000 },
  shield: { before: 0, after: 0 },
  ap: { before: 2, after: 2, maximum: 4 },
  pp: { before: 1, after: 1, maximum: 3 },
  extraGauge: { before: 30, after: 30, maximum: 100 },
  chips: [],
  roles: { actor: false, activator: false, target: false },
  defeated: false,
};

function renderCard(overrides: Partial<TraceUnitCardView> = {}) {
  render(<UnitTraceCard card={{ ...BASE, ...overrides }} />);
  return screen.getByRole("group", { name: /敵ユニット/ });
}

/** SVGのrectのうち、classに`name`を含むもの。 */
function rectsWithClass(root: HTMLElement, name: string): readonly SVGRectElement[] {
  return [...root.querySelectorAll("rect")].filter((rect) =>
    (rect.getAttribute("class") ?? "").includes(name),
  );
}

describe("UnitTraceCard", () => {
  it("UI-CT-189: ダメージを受けた対象のカードが「対象」のタグ・ダメージ合計・ヒット数・会心・シールド吸収を出し、HPバーに減った分を残す", () => {
    const card = renderCard({
      hp: { before: 800, after: 300, maximum: 1000 },
      shield: { before: 150, after: 0 },
      damage: { total: 650, hits: 2, critical: true, shieldAbsorbed: 150 },
      roles: { actor: false, activator: false, target: true },
    });
    expect(within(card).getByText("対象")).toBeInTheDocument();
    expect(within(card).getByText("−650")).toBeInTheDocument();
    expect(within(card).getByText("2 HIT")).toBeInTheDocument();
    expect(within(card).getByText("会心")).toBeInTheDocument();
    expect(within(card).getByText("盾 −150")).toBeInTheDocument();
    expect(within(card).getByText("300")).toBeInTheDocument();
    // 現在のHPまでを塗り、前のHPまでを減った分として残す（幅は最大HPに対する割合）
    expect(rectsWithClass(card, "hpFill")[0]).toHaveAttribute("width", "30");
    const lost = rectsWithClass(card, "hpLost")[0];
    expect(lost).toHaveAttribute("x", "30");
    expect(lost).toHaveAttribute("width", "50");
    expect(rectsWithClass(card, "hpGained")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "HP 300 / 1,000（−500）" })).toBeInTheDocument();
  });

  it("UI-CT-190: 回復を受けたカードが回復量と回復した分を出し、シールドを模様で重ねて合計値を添える。0回復も示す", () => {
    const card = renderCard({
      hp: { before: 400, after: 600, maximum: 1000 },
      shield: { before: 0, after: 120 },
      heal: { total: 200 },
    });
    expect(within(card).getByText("+200")).toBeInTheDocument();
    const gained = rectsWithClass(card, "hpGained")[0];
    expect(gained).toHaveAttribute("x", "40");
    expect(gained).toHaveAttribute("width", "20");
    expect(rectsWithClass(card, "hpFill")[0]).toHaveAttribute("width", "40");
    const shield = rectsWithClass(card, "shieldFill")[0];
    expect(shield).toHaveAttribute("x", "60");
    expect(shield).toHaveAttribute("width", "12");
    expect(shield?.getAttribute("fill")).toMatch(/^url\(#.+\)$/);
    expect(within(card).getByText("盾 120")).toBeInTheDocument();
  });

  it("UI-CT-191: 効果の印が分類で色分けされ、付いたものを枠付き、外れたものを取り消し線で示し、定義IDの全文をツールチップとaccessible nameに持つ", () => {
    const card = renderCard({
      chips: [
        {
          key: "effect:E1",
          label: "EFF_ATTACK_UP_LONG_NAME",
          kind: "BUFF",
          change: "kept",
          remaining: "1T",
          ineffective: false,
        },
        {
          key: "effect:E3",
          label: "EFF_DEFENSE_DOWN",
          kind: "DEBUFF",
          change: "added",
          remaining: "3行動",
          ineffective: true,
        },
        {
          key: "effect:E2",
          label: "EFF_POISON",
          kind: "STATUS_ABNORMALITY",
          change: "removed",
          ineffective: false,
        },
        {
          key: "marker:M1",
          label: "MARKER_SCAR",
          kind: "MARKER",
          change: "added",
          remaining: "×3",
          ineffective: false,
        },
      ],
    });
    const items = within(card).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "バフ EFF_ATTACK_UP_LONG_NAME 残り1T",
      "デバフ EFF_DEFENSE_DOWN 残り3行動 次点 付与",
      "状態異常 EFF_POISON 解除",
      "マーカー MARKER_SCAR ×3 付与",
    ]);
    expect(items[0]).toHaveAttribute("title", "バフ EFF_ATTACK_UP_LONG_NAME 残り1T");
    expect(items[0]?.className).toMatch(/chipBuff/);
    expect(items[1]?.className).toMatch(/chipDebuff/);
    expect(items[1]?.className).toMatch(/chipAdded/);
    expect(items[1]?.className).toMatch(/chipIneffective/);
    expect(items[2]?.className).toMatch(/chipStatus/);
    expect(items[2]?.className).toMatch(/chipRemoved/);
    expect(items[3]?.className).toMatch(/chipMarker/);
  });

  it("UI-CT-192: 行動者に「行動中」、PS発動者に「PS発動」のタグと枠が付き、撃破されたユニットに撃破が出る", () => {
    const { rerender } = render(
      <UnitTraceCard card={{ ...BASE, roles: { actor: true, activator: false, target: false } }} />,
    );
    const card = screen.getByRole("group", { name: /敵ユニット/ });
    expect(within(card).getByText("行動中")).toBeInTheDocument();
    expect(card.className).toMatch(/actor/);
    expect(card).toHaveAttribute("aria-label", "【夜の帳】敵ユニット（敵 前衛1）行動中");

    rerender(
      <UnitTraceCard
        card={{ ...BASE, roles: { actor: false, activator: true, target: false }, defeated: true }}
      />,
    );
    expect(within(card).getByText("PS発動")).toBeInTheDocument();
    expect(card.className).toMatch(/activator/);
    expect(within(card).getByText("撃破")).toBeInTheDocument();
    expect(card.className).toMatch(/defeated/);
    expect(card).toHaveAttribute("aria-label", "【夜の帳】敵ユニット（敵 前衛1）PS発動 撃破");
  });

  it("UI-CT-193: AP・PPの点が範囲内で消費した分と獲得した分を区別し、EXゲージを出す", () => {
    const card = renderCard({
      ap: { before: 3, after: 1, maximum: 4 },
      pp: { before: 0, after: 2, maximum: 3 },
      extraGauge: { before: 30, after: 55, maximum: 100 },
      actionOrder: 2,
    });
    expect(within(card).getByText("順2")).toBeInTheDocument();
    const ap = screen.getByRole("img", { name: "AP 1 / 4（2消費）" });
    expect(ap.querySelectorAll("[data-pip='on']")).toHaveLength(1);
    expect(ap.querySelectorAll("[data-pip='spent']")).toHaveLength(2);
    expect(ap.querySelectorAll("[data-pip='empty']")).toHaveLength(1);
    const pp = screen.getByRole("img", { name: "PP 2 / 3（2獲得）" });
    expect(pp.querySelectorAll("[data-pip='gain']")).toHaveLength(2);
    const ex = screen.getByRole("img", { name: "EX 55 / 100（+25）" });
    expect(rectsWithClass(ex, "exFill")[0]).toHaveAttribute("width", "55");
  });
});
