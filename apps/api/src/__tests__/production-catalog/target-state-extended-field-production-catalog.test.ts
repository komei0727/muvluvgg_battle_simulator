import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPassiveCandidates } from "../../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../../domain/battle/triggering/passive-activation-guard.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { Side } from "../../domain/shared/side.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import {
  loadProductionSnapshot,
  skillFrom,
  testBattleUnit,
  unitFrom,
} from "../../testing/fixtures/index.js";

/**
 * M7-001E（Issue #248、`CAP_TARGET_STATE_EXTENDED_FIELD`）: `BattleUnit`だけからは
 * 解決できない`TARGET_STATE.field`を、実 `catalog/` の未改変定義に対して検証する。
 *
 * - trigger scopeの`UNIT_TYPE`: Catalogの`UnitDefinition`参照
 *   （`SKL_LUCIE_MAID_PS1`のtrigger条件「物理型／敏捷型の味方が…」）
 *
 * RES-004-STATUS-CONDITION（Issue #224）: `HAS_STATUS`のproduction利用は0件になった。
 * `SKL_NANAE_COMMANDER_PS1`など「対象が状態異常だった場合」という総称の照会は、
 * 気絶／凍結／暗闇の3項ORでは毒・炎上を取りこぼす近似だったため、単一の分類元
 * （`effect-category-classifier.ts`）に基づく`TARGET_HAS_EFFECT.categories: ["STATUS"]`
 * へ移した（`target-effect-query-production-catalog.test.ts`が検証する）。`HAS_STATUS`
 * 自体はR-EFF-02の照会粒度#2「個別の状態異常種別を保持しているか」として残り、
 * `UT-R-SKL-06-064`/`065`がUnitレベルで固定する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function unitOf(
  id: string,
  side: Side,
  unitDefinitionId: string,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  return testBattleUnit({ battleUnitId: id, unitDefinitionId, side, position, overrides });
}

describe("production Catalog TARGET_STATE extended fields (CAP_TARGET_STATE_EXTENDED_FIELD, M7-001E Issue #248)", () => {
  it("IT-CAP-TARGET-STATE-FIELD-PROD-002: SKL_LUCIE_MAID_PS1's real UNIT_TYPE trigger condition reads the attacker's UnitDefinition through the unitDefinitions the passive matcher threads through", () => {
    const unitId = "UNIT_LUCIE_MAID";
    const skillId = "SKL_LUCIE_MAID_PS1";
    const attackerUnitId = "UNIT_TEST_ATTACKER";
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const skill = skillFrom(snapshot, skillId);
    expect(skill.requiredCapabilities).toContain("CAP_TARGET_STATE_EXTENDED_FIELD");
    const trigger = skill.triggers[0]!;
    // 未改変の定義（TRIGGER_SOURCEのUNIT_TYPEが物理型または敏捷型）を評価対象にする。
    expect(trigger).toMatchObject({ eventType: "UnitBeingAttacked", sourceSelector: "ENEMY" });
    expect(JSON.stringify(trigger.condition)).toContain("UNIT_TYPE");

    const owner = unitOf("owner", "ALLY", unitId, { column: "LEFT", row: "FRONT" });
    const attacker = unitOf("attacker", "ENEMY", attackerUnitId, {
      column: "LEFT",
      row: "FRONT",
    });
    const ownerDefinition = unitFrom(snapshot, unitId);
    const detect = (attackerUnitType: "PHYSICAL" | "ENERGY" | "AGILE") =>
      detectPassiveCandidates({
        event: {
          eventType: trigger.eventType,
          category: trigger.category,
          sourceUnitId: attacker.battleUnitId,
          targetUnitIds: [owner.battleUnitId],
          payload: {},
        },
        units: [owner, attacker],
        unitDefinitions: new Map([
          [
            createUnitDefinitionId(unitId),
            {
              ...ownerDefinition,
              passiveSkillDefinitionIds: [createSkillDefinitionId(skillId)],
            },
          ],
          [
            createUnitDefinitionId(attackerUnitId),
            {
              ...ownerDefinition,
              unitDefinitionId: createUnitDefinitionId(attackerUnitId),
              unitType: attackerUnitType,
              passiveSkillDefinitionIds: [],
            },
          ],
        ]),
        skillDefinitions: new Map([[createSkillDefinitionId(skillId), skill]]),
        activationGuard: createEmptyPassiveActivationGuard(),
        turnNumber: 1,
      });

    // 物理型・敏捷型の攻撃者なら候補になる。
    expect(detect("PHYSICAL").length).toBeGreaterThan(0);
    expect(detect("AGILE").length).toBeGreaterThan(0);
    // EN型では同じtrigger条件が不成立になる
    // （`unitDefinitions`が実際に評価へ効いていることの証跡）。
    expect(detect("ENERGY")).toEqual([]);
  });
});
