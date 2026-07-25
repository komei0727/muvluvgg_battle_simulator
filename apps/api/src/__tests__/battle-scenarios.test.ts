import { describe, expect, it } from "vitest";
import { ApplicationError } from "../application/contracts/application-error.js";
import { createCapabilityDefinition } from "../domain/catalog/capability/capability-definition.js";
import { createCapabilityId } from "../domain/catalog/definitions/catalog-ids.js";
import { CatalogBuilder } from "../testing/scenario/catalog-builder.js";
import {
  battleCommand,
  formationSlot,
  unitDefinition,
} from "../testing/scenario/definition-builders.js";
import { runScenario } from "../testing/scenario/run-scenario.js";

/**
 * harness ベースの Battle シナリオ（`12_テスト戦略.md`「基準シナリオ」）。散在する既存の
 * `SCN-BTL-*` とは別に、`runScenario` + `CatalogBuilder` を実運用へ載せる集約先。
 * ルール未実装の SCN-BTL-015〜018（シールド/リンク/DoT/状態異常）は該当ルール実装後に追加する。
 */
describe("battle scenarios (harness)", () => {
  it("SCN-BTL-022: a definition graph requiring an unimplemented Capability is rejected with UNSUPPORTED_RULE before the battle starts", () => {
    const capabilityId = createCapabilityId("CAP_UNSUPPORTED");
    const gatedUnit = unitDefinition("UNIT_GATED", { requiredCapabilities: [capabilityId] });
    const catalog = new CatalogBuilder()
      .withUnit(gatedUnit)
      .withCapability(
        createCapabilityDefinition({
          capabilityId: "CAP_UNSUPPORTED",
          schemaStatus: "SUPPORTED",
          runtimeStatus: "PLANNED",
          implementationTaskId: "TEST-SCN-022",
          description: "not yet implemented",
          verification: {
            productionDefinitionIds: ["TEST_DEFINITION"],
            testCaseIds: ["TEST-SCN-022"],
          },
        }),
      )
      .build();

    const command = battleCommand({
      allyFormation: { slots: [formationSlot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
      enemyFormation: { slots: [formationSlot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
    });

    try {
      runScenario({ catalog, command });
      expect.fail("expected runScenario to reject the unsupported Capability");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
    }
  });
});
