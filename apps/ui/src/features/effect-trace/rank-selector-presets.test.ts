import { describe, expect, it } from "vitest";
import { rankSelectorSpecOf } from "./rank-selector-presets.js";

describe("rankSelectorSpecOf", () => {
  it("maps a single-winner rank selector to its comparison axis (UI-UT-RSP-001)", () => {
    expect(rankSelectorSpecOf("ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH")).toEqual({
      orderKey: "HIGHEST_ATTACK",
      field: "attack",
      direction: "DESC",
      label: "攻撃力が最も高い",
    });
    expect(rankSelectorSpecOf("ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW")).toMatchObject({
      orderKey: "LOWEST_ATTACK",
      direction: "ASC",
    });
  });

  it("has no entry for an effect no rank selector chooses (UI-UT-RSP-002)", () => {
    expect(rankSelectorSpecOf("ACT_SUIRAN_CHAOS_AS1_DEBUFF")).toBeUndefined();
    expect(rankSelectorSpecOf("ACT_NOT_IN_ANY_CATALOG")).toBeUndefined();
  });

  /**
   * 表へ載せる条件は「その効果を適用しうる**全ての**経路が単一勝者の順位セレクタであること」で
   * あり、「順位セレクタの経路が1つでもあること」ではない。
   *
   * `SKL_SUIRAN_CASINO_AS1`は`MARKER_SUIRAN_CASINO_THREE_CARD`の有無で、同じ
   * `ACT_SUIRAN_CASINO_AS1_DAMAGE`を`count: 3`の binding と`count: 1`の binding へ振り分ける。
   * `count: 1`の経路だけを見て表へ載せると、3体へ正当に付与された場合に2件が
   * 「復元した1位と一致しません」になる（付与を見ただけではどちらの経路か分からないため）。
   */
  it("has no entry for an effect that a multi-target selector can also apply (UI-UT-RSP-003)", () => {
    expect(rankSelectorSpecOf("ACT_SUIRAN_CASINO_AS1_DAMAGE")).toBeUndefined();
  });

  /** 複数の順位キーから到達する効果も、どちらで選ばれたか逆算できないので載せない。 */
  it("has no entry for an effect reachable from two different rank keys (UI-UT-RSP-004)", () => {
    expect(rankSelectorSpecOf("ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE")).toBeUndefined();
  });
});
