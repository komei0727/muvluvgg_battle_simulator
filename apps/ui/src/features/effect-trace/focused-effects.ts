// 注目効果プリセット。`effectActionDefinitionId`を並べた**表**であり、分岐を持たない。
// 投影（`effect-trace-projector.ts`）は全インスタンスを総称的に扱い、どれを最初に開くかだけを
// この表が決める。Catalogから追跡対象を自動列挙（順位セレクタ持ち・単発消費持ち）へ広げる
// ときは、この定数の作り方だけが変わる。
//
// 選ぶ基準は「解決順で対象が変わり、スコアが動く」効果である:
//
// - `ACT_SUIRAN_CHAOS_AS1_DEBUFF`（【混沌の立役者】劉翠蘭 AS1、被ダメージ+70%）は
//   `NEXT_INCOMING_ATTACK`の1回消費であり、直後に殴る味方が誰かで価値が変わる。
// - `ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH`（【心色見つめるムードメーカー】エレーナ・
//   パステルコワ EX）は`HIGHEST_ATTACK`で味方を選ぶため、高火力キャラへ乗ったかで
//   スコアが変わる。
export const FOCUSED_EFFECT_ACTION_DEFINITION_IDS: readonly string[] = [
  "ACT_SUIRAN_CHAOS_AS1_DEBUFF",
  "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
];
