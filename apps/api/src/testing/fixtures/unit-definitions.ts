import type { SkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type {
  UnitDefinition,
  UnitMetadata,
} from "../../domain/catalog/definitions/unit-definition.js";
import { unitDefinition, type UnitDefinitionOverrides } from "../scenario/definition-builders.js";

export interface TestUnitDefinitionOverrides extends Omit<
  UnitDefinitionOverrides,
  "extraSkillDefinitionId"
> {
  readonly metadata?: Partial<UnitMetadata>;
  /**
   * `null` はEXスキル参照そのものを持たないユニットを表す。既定の
   * `SKL_EX_DEFAULT` は定義グラフへ登録されない参照のため、EXスキル解決を
   * 経由するテストではダングリング参照を作らないよう `null` を選ぶ。
   */
  readonly extraSkillDefinitionId?: SkillDefinitionId | null;
}

/**
 * production-catalogテスト向けの「PSなし・特殊効果なし」Unit定義。scenario層の
 * `unitDefinition` と異なり、会心（criticalRate）と属性相性（affinityBonus）を
 * 既定で0にする — 実Catalogの定義を対象にするテストは乱数消費・補正を検証対象の
 * Capabilityだけへ閉じる必要があるため。Memory所属条件（affiliations）を検証する
 * テストのために metadata overrides も受け付ける。
 */
export function testUnitDefinition(
  id: string,
  overrides: TestUnitDefinitionOverrides = {},
): UnitDefinition {
  const { metadata, baseStats, extraSkillDefinitionId, ...rest } = overrides;
  const base = unitDefinition(id, {
    ...rest,
    ...(extraSkillDefinitionId != null ? { extraSkillDefinitionId } : {}),
    baseStats: { criticalRate: 0, affinityBonus: 0, ...baseStats },
  });
  return {
    ...base,
    // `UnitDefinition.extraSkillDefinitionId` は必須フィールドだが、EXスキルを
    // 一切解決しないテストでは参照自体を持たない方が安全なため、`null` 指定時
    // だけ契約を意図的に緩めて `undefined` を焼き込む（型上は非undefined）。
    ...(extraSkillDefinitionId === null
      ? { extraSkillDefinitionId: undefined as unknown as SkillDefinitionId }
      : {}),
    metadata: { ...base.metadata, characterId: `CHAR_${id}`, ...metadata },
  };
}
