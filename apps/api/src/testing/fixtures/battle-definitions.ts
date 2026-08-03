import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { testUnitDefinition } from "./unit-definitions.js";

export interface DefinitionsWithOptions {
  /**
   * snapshotへ含まれない相手役ユニット（`UNIT_TEST_ENEMY` 等）。stringは
   * `testUnitDefinition` の既定値で補い、ステータスが検証に関わる場合は
   * 完全な `UnitDefinition` で明示する。
   */
  readonly units?: readonly (string | UnitDefinition)[];
  /** snapshot外の合成スキル定義を `skillDefinitions` へ追加する。 */
  readonly skills?: readonly SkillDefinition[];
  /** `memoriesBySide` など、標準形に無いフィールドを最後に重ねる。 */
  readonly overrides?: Partial<BattleDefinitions>;
}

/** Catalog snapshotの定義グラフを `BattleDefinitions` へ写す。 */
export function definitionsWith(
  snapshot: BattleCatalogSnapshot,
  options: DefinitionsWithOptions = {},
): BattleDefinitions {
  const unitDefinitions = new Map(snapshot.units);
  for (const entry of options.units ?? []) {
    const definition = typeof entry === "string" ? testUnitDefinition(entry) : entry;
    unitDefinitions.set(definition.unitDefinitionId, definition);
  }
  const skillDefinitions = new Map(snapshot.skills);
  for (const skill of options.skills ?? []) {
    skillDefinitions.set(skill.skillDefinitionId, skill);
  }
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(snapshot.effectActions),
    unitDefinitions,
    skillDefinitions,
    ...options.overrides,
  };
}

/**
 * snapshot全体を持ち込まず、検証対象スキル1件とそのEffectAction群だけの最小
 * 定義グラフを組む（`applyEffectActionGroups` 直呼びテスト用。`unitDefinitions`
 * が空なのでPS検出を経由する経路には使えない）。
 */
export function definitionsForSkill(
  skill: SkillDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions: new Map(),
    skillDefinitions: new Map([[skill.skillDefinitionId, skill]]),
  };
}
