import { slotKeyOf } from "../formation/types.js";

/**
 * UI-CMP-011: 演習で唯一操作できる敵枠。座標はそのまま`FormationRequest`へ載る。
 * component本体とは別ファイルにして、`ExerciseEnemySlot.tsx`をcomponentだけの
 * exportに保つ（react-refresh）。
 */
export const EXERCISE_ENEMY_SLOT_KEY = slotKeyOf("enemy", "FRONT", 0);
