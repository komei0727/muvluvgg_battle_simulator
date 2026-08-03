import type {
  UnitDefinition,
  UnitMetadata,
} from "../../domain/catalog/definitions/unit-definition.js";
import { unitDefinition, type UnitDefinitionOverrides } from "../scenario/definition-builders.js";

export interface TestUnitDefinitionOverrides extends UnitDefinitionOverrides {
  readonly metadata?: Partial<UnitMetadata>;
}

/**
 * production-catalogテスト向けの「PSなし・特殊効果なし」Unit定義。scenario層の
 * `unitDefinition` と異なり、会心（criticalRate）と属性相性（affinityBonus）を
 * 既定で0にする — 実Catalogの定義を対象にするテストは乱数消費・補正を検証対象の
 * Capabilityだけへ閉じる必要があるため。Memory所属条件（affiliations）を検証する
 * テストのために metadata overrides も受け付ける。
 *
 * `extraSkillDefinitionId` は必須フィールドのため常に実在の値を持ち、既定は
 * placeholder の `SKL_EX_DEFAULT` になる。EXスキルを実際に解決するテストは、
 * `CatalogBuilder.build()` が合成Catalogへ no-op EX定義を補完するのと同様に、
 * 参照先の `SkillDefinition` を自分で定義グラフへ登録する必要がある。
 */
export function testUnitDefinition(
  id: string,
  overrides: TestUnitDefinitionOverrides = {},
): UnitDefinition {
  const { metadata, baseStats, ...rest } = overrides;
  const base = unitDefinition(id, {
    ...rest,
    baseStats: { criticalRate: 0, affinityBonus: 0, ...baseStats },
  });
  return {
    ...base,
    metadata: { ...base.metadata, characterId: `CHAR_${id}`, ...metadata },
  };
}
