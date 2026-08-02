import type { BattleUnit } from "../model/battle-unit.js";
import type { PiercingModifierState } from "../model/applied-effect.js";

/** R-DMG-03の3つの貫通率。`DamagePayload.piercing`と同じ形。 */
export type PiercingRates = PiercingModifierState;

const NO_PIERCING: PiercingRates = {
  defenseIgnoreRate: 0,
  shieldIgnoreRate: 0,
  damageReductionIgnoreRate: 0,
};

/**
 * 「無視されずに残る割合」の積から合成率を求める: `1 - Π(1 - 各無視率)`。
 *
 * R-DMG-03は個々の率の意味（`0`なら通常処理、`1`なら全量無視）だけを定める。
 * 複数の貫通が同時に効く場合の合成規約をここで定義する（`TEMP_PIERCING_GRANT`、
 * DMG-003、Issue #196）。積を採る理由は2つ:
 *
 * - 定義域[0, 1]で閉じる。単純加算だと1を超えるため人為的なクランプが必要になり、
 *   「50%無視を2つ持つと全量無視」という、原文のどこにも根拠のない挙動になる。
 * - 順序に依存しない。各率を「まだ無視されていない残りのうち何割をさらに無視するか」
 *   と読むため、付与順が結果を変えない（`AppliedEffect`の並び順は解決経路で変わりうる）。
 *
 * `1`が1つでもあればその率は`1`に飽和し、`0`は恒等元として寄与しない。
 */
function composeRate(staticRate: number, grants: readonly number[]): number {
  return 1 - grants.reduce((remaining, rate) => remaining * (1 - rate), 1 - staticRate);
}

/**
 * R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003、Issue #196）: そのDAMAGE定義自身が持つ
 * 静的な貫通率（`DamagePayload.piercing`）と、攻撃側が保持している
 * `APPLY_PIERCING_MOD`由来の一時貫通（`AppliedEffect.piercing`）を合成する。
 *
 * `composeDamageModifiers`（R-DMG-04）と同じ責務分割で、`AppliedEffect`を知らない
 * `calculateDamage`が受け取るのは合成後の率だけである。`APPLY_PIERCING_MOD`の
 * `stacking.mode`は`STACKABLE`のみのため、保持している全インスタンスが常に有効で
 * R-EFF-05の最強選択は行わない。
 */
export function composePiercing(
  definitionPiercing: PiercingRates,
  attacker: BattleUnit,
): PiercingRates {
  const grants = attacker.appliedEffects
    .map((effect) => effect.piercing)
    .filter((piercing): piercing is PiercingModifierState => piercing !== undefined);
  if (grants.length === 0) {
    return definitionPiercing;
  }
  return {
    defenseIgnoreRate: composeRate(
      definitionPiercing.defenseIgnoreRate,
      grants.map((grant) => grant.defenseIgnoreRate),
    ),
    shieldIgnoreRate: composeRate(
      definitionPiercing.shieldIgnoreRate,
      grants.map((grant) => grant.shieldIgnoreRate),
    ),
    damageReductionIgnoreRate: composeRate(
      definitionPiercing.damageReductionIgnoreRate,
      grants.map((grant) => grant.damageReductionIgnoreRate),
    ),
  };
}

export { NO_PIERCING };
