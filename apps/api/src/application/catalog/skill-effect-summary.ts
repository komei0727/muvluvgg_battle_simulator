import type { SkillType } from "../../domain/catalog/definitions/catalog-enums.js";
import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type {
  EffectActionDefinition,
  EffectActionKind,
} from "../../domain/catalog/definitions/effect-action-definition.js";
import type { FormulaDefinition } from "../../domain/catalog/definitions/formula-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";

/**
 * `10_API設計.md`「CatalogSkillSummaryResponse」: 戦闘ログの`skillDefinitionId`を
 * 「どのユニットのどの枠のスキルか」へ読み替えるための表示用要約。
 *
 * `ownerUnitDefinitionId`/`slotLabel`は、そのスキルを宣言しているユニットが
 * ちょうど1体のときだけ持つ。0体・複数体では枠を1つに決められないため省略する。
 */
export interface BattleSimulationSkillSummary {
  readonly skillDefinitionId: SkillDefinitionId;
  readonly displayName: string;
  readonly skillType: SkillType;
  readonly ownerUnitDefinitionId?: UnitDefinitionId;
  readonly slotLabel?: string;
}

/**
 * `10_API設計.md`「CatalogEffectSummaryResponse」: 戦闘ログの
 * `effectActionDefinitionId`を「何をどれだけ変える効果か」へ読み替えるための
 * 表示用要約。分類項目はそのkindが宣言するものだけを持つ。
 *
 * `constantMagnitude`は`formula`が`CONSTANT`のときの値で、付与時に評価される
 * `EffectApplied.magnitude`と同じ尺度である。それ以外のFormulaは付与ごとに
 * 値が変わるため公開しない（量は戦闘ログ側の`magnitude`が持つ）。
 */
export interface BattleSimulationEffectSummary {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly kind: EffectActionKind;
  readonly stat?: string;
  readonly valueType?: string;
  readonly direction?: string;
  readonly damageType?: string;
  readonly status?: string;
  readonly constantMagnitude?: number;
}

interface SkillSlot {
  readonly ownerUnitDefinitionId: UnitDefinitionId;
  readonly slotLabel: string;
}

function slotsOf(unit: UnitDefinition): readonly [SkillDefinitionId, string][] {
  return [
    ...unit.activeSkillDefinitionIds.map((id, index): [SkillDefinitionId, string] => [
      id,
      `AS${(index + 1).toString()}`,
    ]),
    ...unit.passiveSkillDefinitionIds.map((id, index): [SkillDefinitionId, string] => [
      id,
      `PS${(index + 1).toString()}`,
    ]),
    [unit.extraSkillDefinitionId, "EX"],
  ];
}

/** 宣言ユニットが1体だけのスキルの枠。複数体が宣言するスキルは`undefined`で潰す。 */
function indexSkillSlots(
  units: Iterable<UnitDefinition>,
): ReadonlyMap<SkillDefinitionId, SkillSlot | undefined> {
  const slots = new Map<SkillDefinitionId, SkillSlot | undefined>();
  for (const unit of units) {
    for (const [skillDefinitionId, slotLabel] of slotsOf(unit)) {
      slots.set(
        skillDefinitionId,
        slots.has(skillDefinitionId)
          ? undefined
          : { ownerUnitDefinitionId: unit.unitDefinitionId, slotLabel },
      );
    }
  }
  return slots;
}

export function buildSkillSummaries(
  skills: Iterable<SkillDefinition>,
  units: Iterable<UnitDefinition>,
): BattleSimulationSkillSummary[] {
  const slots = indexSkillSlots(units);
  return [...skills]
    .map((skill) => {
      const slot = slots.get(skill.skillDefinitionId);
      return {
        skillDefinitionId: skill.skillDefinitionId,
        displayName: skill.metadata.displayName,
        skillType: skill.skillType,
        ...(slot === undefined
          ? {}
          : { ownerUnitDefinitionId: slot.ownerUnitDefinitionId, slotLabel: slot.slotLabel }),
      };
    })
    .sort((a, b) => a.skillDefinitionId.localeCompare(b.skillDefinitionId));
}

function constantMagnitudeOf(formula: FormulaDefinition): { constantMagnitude?: number } {
  return formula.kind === "CONSTANT" ? { constantMagnitude: formula.value } : {};
}

function classificationOf(
  effect: EffectActionDefinition,
): Omit<BattleSimulationEffectSummary, "effectActionDefinitionId" | "kind"> {
  switch (effect.kind) {
    case "APPLY_STAT_MOD":
      return {
        stat: effect.payload.stat,
        valueType: effect.payload.valueType,
        ...constantMagnitudeOf(effect.payload.formula),
      };
    case "APPLY_DAMAGE_MOD":
      return {
        direction: effect.payload.direction,
        // `null`は全ダメージ種別に効く補正であり、項目の省略で表す。
        ...(effect.payload.damageType === null ? {} : { damageType: effect.payload.damageType }),
        ...constantMagnitudeOf(effect.payload.formula),
      };
    case "APPLY_STATUS":
      return { status: effect.payload.status };
    default:
      return {};
  }
}

export function buildEffectSummaries(
  effects: Iterable<EffectActionDefinition>,
): BattleSimulationEffectSummary[] {
  return [...effects]
    .map((effect) => ({
      effectActionDefinitionId: effect.effectActionDefinitionId,
      kind: effect.kind,
      ...classificationOf(effect),
    }))
    .sort((a, b) => a.effectActionDefinitionId.localeCompare(b.effectActionDefinitionId));
}
