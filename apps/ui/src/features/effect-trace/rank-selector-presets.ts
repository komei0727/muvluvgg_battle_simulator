// 順位セレクタで対象が決まる効果の表。`effect-trace-projector.ts`と同じく、
// ロジック側は効果IDで分岐せず、この表だけが「どの効果がどの順位で選ばれたか」を知っている。
//
// **この対応はCatalogから機械的に導いた**（catalogRevision 2026-08-19.3 時点）。ある効果を表へ載せるのは、
// **その効果を適用しうる全ての経路**が「`selector`が`kind: SELECT`／`count: 1`／filterなしで、
// `order`の先頭がステータス由来の順位キー1つ」を満たし、かつ全経路の順位キーが一致する場合だけである。
//
// 「満たさない経路は無視して、満たす経路だけを見る」ではないことが要点である。1つでも別種の経路が
// あると、付与を見ただけではどちらで選ばれたのか分からず、単一勝者として比較すると
// 正しく選ばれた対象に「一致しません」と誤警告を出す。実例として
// `SKL_SUIRAN_CASINO_AS1`は同じ`ACT_SUIRAN_CASINO_AS1_DAMAGE`を
// `MARKER_SUIRAN_CASINO_THREE_CARD`の有無で`count: 3`の binding と`count: 1`の binding へ振り分ける。
// 上位3体すべてが正当な対象であるのに、2件が「一致しません」になっていた。
//
// 除外した効果（順位セレクタからも到達するが、別種の経路も持つもの）:
//   - ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE（他経路: HIGHEST_ATTACK, LOWEST_ATTACK）
//   - ACT_SUIRAN_CASINO_AS1_DAMAGE（他経路: TGT_TRIPLE）
//
// HP割合・EXゲージ割合の順位キー（`HIGHEST_HP_RATIO`等）は扱わない。比較に要る系列が
// `combatStats`ではなく`hp`／`resources`にあり、`combat-stat-timeline.ts`が復元しないためである。
// 複数体が同時に選ばれる順位セレクタ（`count`が2以上）も扱わない —— 比較が単一勝者を前提にしている。
//
// Catalogが増えてもこの表が古いだけなら、その効果に比較が出ないだけで表示は壊れない
// （`UI-CMP-006`「黙って切り捨てない」と同じく、知らないものは知らないと扱う）。

import type { CombatStatField } from "./combat-stat-timeline.js";

/** `target-selector-definition.ts`の`TARGET_ORDER_KEYS`のうち、`combatStats`で比較できるもの。 */
export type RankOrderKey =
  | "HIGHEST_ATTACK"
  | "LOWEST_ATTACK"
  | "HIGHEST_MAX_HP"
  | "LOWEST_MAX_HP"
  | "FASTEST";

export interface RankSelectorSpec {
  readonly orderKey: RankOrderKey;
  readonly field: CombatStatField;
  /** `DESC`＝大きいほど先に選ばれる。 */
  readonly direction: "ASC" | "DESC";
  /** 画面に出す比較軸の名前。 */
  readonly label: string;
}

const RANK_ORDER_SPECS: Readonly<Record<RankOrderKey, Omit<RankSelectorSpec, "orderKey">>> = {
  HIGHEST_ATTACK: { field: "attack", direction: "DESC", label: "攻撃力が最も高い" },
  LOWEST_ATTACK: { field: "attack", direction: "ASC", label: "攻撃力が最も低い" },
  HIGHEST_MAX_HP: { field: "maximumHp", direction: "DESC", label: "最大HPが最も高い" },
  LOWEST_MAX_HP: { field: "maximumHp", direction: "ASC", label: "最大HPが最も低い" },
  FASTEST: { field: "actionSpeed", direction: "DESC", label: "行動速度が最も高い" },
};

const RANK_SELECTED_EFFECTS: Readonly<Record<string, RankOrderKey>> = {
  ACT_CHIZURU_DOMESTIC_PS1_DAMAGE: "LOWEST_MAX_HP",
  ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH: "HIGHEST_ATTACK",
  ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW: "LOWEST_ATTACK",
  ACT_ELENA_MOODMAKER_EX_DMGUP_HIGH: "HIGHEST_ATTACK",
  ACT_ELENA_MOODMAKER_EX_DMGUP_LOW: "LOWEST_ATTACK",
  ACT_HIIRO_LONEWOLF_EX_STUN: "HIGHEST_ATTACK",
  ACT_HIIRO_LONEWOLF_PS1_DAMAGE: "HIGHEST_ATTACK",
  ACT_HIIRO_LONEWOLF_PS1_PP_ZERO: "HIGHEST_ATTACK",
  ACT_MAIA_LAZY_AS3_AP_UP: "HIGHEST_ATTACK",
  ACT_MAIA_LAZY_AS3_ATK_UP: "HIGHEST_ATTACK",
  ACT_MERU_FLATSPIN_AS1_AP_DOWN: "HIGHEST_ATTACK",
  ACT_MERU_FLATSPIN_AS1_DAMAGE: "HIGHEST_ATTACK",
  ACT_MERU_SIRIUS_EX_STUN: "HIGHEST_ATTACK",
  ACT_MERU_SIRIUS_PS2_DAMAGE: "HIGHEST_ATTACK",
  ACT_MERU_SIRIUS_PS2_DMG_DOWN: "HIGHEST_ATTACK",
  ACT_NADYA_SUCCESSOR_AS1_DAMAGE: "FASTEST",
  ACT_NADYA_SUCCESSOR_AS1_DAMAGE_BOOSTED: "FASTEST",
  ACT_NADYA_SUCCESSOR_AS1_DMG_DOWN_DEBUFF: "FASTEST",
  ACT_NADYA_SUCCESSOR_AS1_MARK: "FASTEST",
  ACT_NADYA_SUCCESSOR_AS1_SPEED_DOWN: "FASTEST",
  ACT_NADYA_SUCCESSOR_EX_DAMAGE: "HIGHEST_ATTACK",
  ACT_NADYA_SUCCESSOR_EX_STUN: "HIGHEST_ATTACK",
  ACT_NANAE_COMMANDER_AS2_STUN: "HIGHEST_ATTACK",
  ACT_NANAE_COMMANDER_PS2_COUNTER: "HIGHEST_ATTACK",
  ACT_SHOUKA_SCHEMER_AS2_ATK_DOWN: "HIGHEST_ATTACK",
  ACT_SHOUKA_SCHEMER_AS2_DAMAGE: "HIGHEST_ATTACK",
  ACT_SHOUKA_SCHEMER_AS2_DEF_UP: "HIGHEST_ATTACK",
  ACT_TATIANA_SAGE_AS1_CLEAR_OMEN: "HIGHEST_ATTACK",
  ACT_TATIANA_SAGE_AS1_DAMAGE: "HIGHEST_ATTACK",
  ACT_TATIANA_SAGE_AS1_DAZZLE: "HIGHEST_ATTACK",
  ACT_TATIANA_SAGE_AS1_DOT: "HIGHEST_ATTACK",
  ACT_TATIANA_SAGE_AS1_FOLLOWUP: "HIGHEST_ATTACK",
  ACT_TATIANA_SAGE_AS1_MARK: "HIGHEST_ATTACK",
  ACT_URUU_SUMMER_AS1_DAMAGE: "HIGHEST_ATTACK",
  ACT_URUU_SUMMER_AS1_MARKER_SHIOSAI: "HIGHEST_ATTACK",
  ACT_URUU_TIMID_PS1_ALLY_CRIT_UP: "HIGHEST_ATTACK",
  ACT_URUU_TIMID_PS2_ATK_UP: "HIGHEST_ATTACK",
  ACT_URUU_TIMID_PS2_CRIT_UP: "HIGHEST_ATTACK",
};

/** 順位セレクタで**単一の**対象が決まった効果なら、その比較軸を返す。 */
export function rankSelectorSpecOf(effectActionDefinitionId: string): RankSelectorSpec | undefined {
  const orderKey = RANK_SELECTED_EFFECTS[effectActionDefinitionId];
  if (orderKey === undefined) {
    return undefined;
  }
  return { orderKey, ...RANK_ORDER_SPECS[orderKey] };
}
