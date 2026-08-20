// 順位セレクタで対象が決まる効果の表。`effect-trace-projector.ts`と同じく、
// ロジック側は効果IDで分岐せず、この表だけが「どの効果がどの順位で選ばれたか」を知っている。
//
// **この対応はCatalogから機械的に導いた**（catalogRevision 2026-08-19.3 時点）。採用条件は
// 「`targetBindings`の`selector`が`kind: SELECT`／`count: 1`／filterなしで、
// `order`の先頭がステータス由来の順位キー1つだけ」であり、その binding へ適用される
// `effectActionDefinitionId`を集めたもの。複数の順位キーから到達する効果は「どちらで選ばれたか」を
// 逆算できないため表に入れない（ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE）。
//
// HP割合・EXゲージ割合の順位キー（`HIGHEST_HP_RATIO`等）は扱わない。比較に要る系列が
// `combatStats`ではなく`hp`／`resources`にあり、`combat-stat-timeline.ts`が復元しないためである。
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
  ACT_SUIRAN_CASINO_AS1_DAMAGE: "HIGHEST_MAX_HP",
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

/** 順位セレクタで選ばれた効果なら、その比較軸を返す。 */
export function rankSelectorSpecOf(effectActionDefinitionId: string): RankSelectorSpec | undefined {
  const orderKey = RANK_SELECTED_EFFECTS[effectActionDefinitionId];
  if (orderKey === undefined) {
    return undefined;
  }
  return { orderKey, ...RANK_ORDER_SPECS[orderKey] };
}
