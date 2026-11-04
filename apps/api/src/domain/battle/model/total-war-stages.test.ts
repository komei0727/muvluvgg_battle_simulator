import { describe, expect, it } from "vitest";
import {
  closeStageHistory,
  openNextStage,
  recordStageDefeat,
  startStageHistory,
} from "./total-war-stages.js";

describe("total war stage history (R-TWR-06 #4)", () => {
  it("UT-R-TWR-06-007: the first stage pairs both first formations from turn 1 and, left undecided, ends at the completed turn with no defeated side", () => {
    expect(closeStageHistory(startStageHistory(), 15)).toEqual([
      {
        stageNumber: 1,
        allyFormationNumber: 1,
        enemyFormationNumber: 1,
        startTurn: 1,
        endTurn: 15,
        defeatedSides: [],
      },
    ]);
  });

  it("UT-R-TWR-06-008: a wipe ends the current stage at its turn, and the next deployment opens a new stage with the formations then on the board", () => {
    const afterWipe = recordStageDefeat(startStageHistory(), "ENEMY", 3);
    const afterDeploy = openNextStage(
      afterWipe,
      { allyFormationNumber: 1, enemyFormationNumber: 2 },
      4,
    );

    expect(closeStageHistory(afterDeploy, 9)).toEqual([
      {
        stageNumber: 1,
        allyFormationNumber: 1,
        enemyFormationNumber: 1,
        startTurn: 1,
        endTurn: 3,
        defeatedSides: ["ENEMY"],
      },
      {
        stageNumber: 2,
        allyFormationNumber: 1,
        enemyFormationNumber: 2,
        startTurn: 4,
        endTurn: 9,
        defeatedSides: [],
      },
    ]);
  });

  it("UT-R-TWR-06-009: wipes in the same stage are kept in the order they occurred, not in the ally-first order", () => {
    const history = recordStageDefeat(
      recordStageDefeat(startStageHistory(), "ENEMY", 2),
      "ALLY",
      2,
    );

    expect(closeStageHistory(history, 2)[0]?.defeatedSides).toEqual(["ENEMY", "ALLY"]);
  });
});
