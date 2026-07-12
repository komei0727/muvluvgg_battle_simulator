/**
 * R-STA-02/03: reusable stat-effect合成器。`AppliedEffect`本体はまだ存在しない
 * (M3以降) ため、ここでは戦闘中割合補正の値だけを持つ最小入力を受け取る。
 * 戦闘開始時・再計算時のどちらからも同じ形で呼べることを目的とする。
 */
export interface StackableStatEffect {
  readonly stacking: "STACKABLE";
  readonly value: number;
}

export interface NonStackableStatEffect {
  readonly stacking: "NON_STACKABLE";
  /** 同じ`EffectKindKey`を持つ効果同士が一つのグループになる (R-STA-03)。 */
  readonly kindKey: string;
  readonly value: number;
}

export type StatEffect = StackableStatEffect | NonStackableStatEffect;

/** R-STA-03: グループ内で強度(絶対値)が最も大きい1件だけを採用する。 */
function strongestPerGroup(effects: readonly NonStackableStatEffect[]): number {
  const strongestByKind = new Map<string, number>();
  for (const effect of effects) {
    const current = strongestByKind.get(effect.kindKey);
    if (current === undefined || Math.abs(effect.value) > Math.abs(current)) {
      strongestByKind.set(effect.kindKey, effect.value);
    }
  }
  return [...strongestByKind.values()].reduce((sum, value) => sum + value, 0);
}

/**
 * R-STA-02: 重複あり効果を符号付きで加算する。
 * R-STA-03: 重複なし効果は`EffectKindKey`ごとに最強の1件だけを合算する。
 */
export function combineEffects(effects: readonly StatEffect[]): number {
  const stackableSum = effects
    .filter((effect): effect is StackableStatEffect => effect.stacking === "STACKABLE")
    .reduce((sum, effect) => sum + effect.value, 0);

  const nonStackable = effects.filter(
    (effect): effect is NonStackableStatEffect => effect.stacking === "NON_STACKABLE",
  );

  return stackableSum + strongestPerGroup(nonStackable);
}
