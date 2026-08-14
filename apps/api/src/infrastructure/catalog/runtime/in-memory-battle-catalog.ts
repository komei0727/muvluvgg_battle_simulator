import type {
  EffectActionDefinitionId,
  MemoryDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  collectEffectActionReferences,
  type CatalogIndex,
} from "../../../domain/catalog/integrity/catalog-integrity.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import type { MemoryDefinition } from "../../../domain/catalog/definitions/memory-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../../domain/ports/battle-catalog.js";
import { toReadonlyMap } from "../../../domain/shared/readonly-map.js";
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../../domain/catalog/definitions/unit-definition.js";

/**
 * `BattleCatalog` Port adapter (`09_アプリケーション設計.md`,
 * `11_インフラストラクチャ設計.md` の InMemoryBattleCatalog). Wraps an
 * already-validated `CatalogIndex` (`catalog-integrity.ts`) so `loadSnapshot`
 * never touches the filesystem — the whole Catalog is read and verified once
 * at process/Worker startup by `catalog-file-loader.ts`.
 */
export class InMemoryBattleCatalog implements BattleCatalog {
  readonly catalogRevision: string;
  private readonly index: CatalogIndex;

  constructor(catalogRevision: string, index: CatalogIndex) {
    this.catalogRevision = catalogRevision;
    this.index = index;
  }

  loadSnapshot(
    unitDefinitionIds: readonly UnitDefinitionId[],
    memoryDefinitionIds: readonly MemoryDefinitionId[],
  ): BattleCatalogSnapshot {
    const units = new Map<UnitDefinitionId, UnitDefinition>();
    const skills = new Map<SkillDefinitionId, SkillDefinition>();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>();
    const memories = new Map<MemoryDefinitionId, MemoryDefinition>();

    const includeEffectAction = (effectActionId: EffectActionDefinitionId): void => {
      if (effectActions.has(effectActionId)) {
        return;
      }
      const effectAction = this.index.effectActions.get(effectActionId);
      if (effectAction === undefined) {
        return;
      }
      effectActions.set(effectActionId, effectAction);
      // R-SUB-02第3項（`SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`、DMG-005、Issue #190）:
      // EffectAction同士の参照も推移閉包へ含める。追加デバフはスキルのstepからは
      // 参照されず`APPLY_SUBUNIT`の payload からだけ指されるため、ここで辿らないと
      // 実戦闘のsnapshotに存在せず、付与時点で「Catalogに無い」として失敗する。
      if (effectAction.kind === "APPLY_SUBUNIT") {
        const debuff = effectAction.payload.additionalDamage.debuff;
        if (debuff !== undefined) {
          includeEffectAction(debuff.effectActionDefinitionId);
        }
      }
      // R-FUP-01（Issue #474）: 追撃のonHitEffectも同じ理由（`APPLY_FOLLOW_UP_ATTACK`の
      // payloadからだけ指される）で推移閉包へ含める。
      if (effectAction.kind === "APPLY_FOLLOW_UP_ATTACK") {
        const onHitEffect = effectAction.payload.onHitEffect;
        if (onHitEffect !== undefined) {
          includeEffectAction(onHitEffect.effectActionDefinitionId);
        }
      }
    };

    const includeSkill = (skillId: SkillDefinitionId): void => {
      if (skills.has(skillId)) {
        return;
      }
      const skill = this.index.skills.get(skillId);
      if (skill === undefined) {
        return;
      }
      skills.set(skillId, skill);
      const stepGroups =
        skill.resolution.kind === "CHARGE"
          ? [skill.resolution.steps, skill.resolution.chargeRelease.steps]
          : [skill.resolution.steps];
      for (const steps of stepGroups) {
        for (const ref of collectEffectActionReferences(steps)) {
          includeEffectAction(ref.effectActionDefinitionId);
        }
      }
    };

    for (const unitId of unitDefinitionIds) {
      const unit = this.index.units.get(unitId);
      if (unit === undefined) {
        continue;
      }
      units.set(unitId, unit);
      for (const skillId of [
        ...unit.activeSkillDefinitionIds,
        ...unit.passiveSkillDefinitionIds,
        unit.extraSkillDefinitionId,
      ]) {
        includeSkill(skillId);
      }
    }

    for (const memoryId of memoryDefinitionIds) {
      const memory = this.index.memories.get(memoryId);
      if (memory === undefined) {
        continue;
      }
      memories.set(memoryId, memory);
      for (const triggeredEffect of memory.triggeredEffects) {
        for (const ref of collectEffectActionReferences(triggeredEffect.effectSequence.steps)) {
          includeEffectAction(ref.effectActionDefinitionId);
        }
      }
    }

    return {
      catalogRevision: this.catalogRevision,
      units: toReadonlyMap(units),
      skills: toReadonlyMap(skills),
      effectActions: toReadonlyMap(effectActions),
      memories: toReadonlyMap(memories),
    };
  }
}
