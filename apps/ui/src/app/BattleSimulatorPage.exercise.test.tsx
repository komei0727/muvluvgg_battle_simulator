import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions, SimulateOptions } from "../features/simulation/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  CatalogApiResult,
  ExecutionApiResult,
  FormationStatPreviewApiResult,
  SimulationApiResult,
  TacticalExerciseEvaluationApiResult,
  TacticalExerciseEvaluationResponse,
  TacticalExerciseResponse,
} from "../features/simulation/api-contract.js";
import type {
  TacticalExerciseEvaluationRequest,
  TacticalExerciseRequest,
} from "../features/exercise/exercise-request-mapper.js";
import type {
  BattleSimulationRequest,
  FormationStatPreviewRequest,
} from "../features/formation/request-mapper.js";
import { toStoredDraft } from "../features/formation/persistence.js";
import { createInitialDraft, slotKeyOf } from "../features/formation/types.js";
import type { BattleDraft } from "../features/formation/types.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

type EvaluateImpl = (
  request: TacticalExerciseEvaluationRequest,
  options: SimulateOptions,
) => Promise<TacticalExerciseEvaluationApiResult>;

vi.mock("../features/catalog-selection/definition-image-map.js", () => ({
  unitImageMap: {},
  memoryImageMap: {},
  definitionImageMap: {},
}));

// プレビューはpage自身が編成の変化に反応して取りに行く。実fetchへ出さない。
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function catalogResponse(): BattleSimulationCatalogResponse {
  return {
    schemaVersion: 1,
    catalogRevision: "rev-1",
    units: [
      {
        unitDefinitionId: "UNIT_A",
        displayName: "アルファ",
        characterName: "Alpha",
        attribute: "CUTE",
        unitType: "ATTACKER",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT"],
      },
      {
        unitDefinitionId: "UNIT_B",
        displayName: "ブラボー",
        characterName: "Bravo",
        attribute: "SMART",
        unitType: "ATTACKER",
        role: "TANK",
        positionAptitudes: ["FRONT"],
      },
      // R-TEX-11 #1: 演習専用ユニット。通常戦闘のプールには現れない。
      {
        unitDefinitionId: "UNIT_EX",
        displayName: "エクサ",
        characterName: "Exa",
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        attribute: "COOL",
        unitType: "ATTACKER",
        role: "TANK",
        positionAptitudes: ["FRONT"],
      },
      {
        unitDefinitionId: "UNIT_EX_CLOSED",
        displayName: "エクサ旧",
        characterName: "Exa Closed",
        category: "EXERCISE_ENEMY",
        exerciseActive: false,
        attribute: "COOL",
        unitType: "ATTACKER",
        role: "TANK",
        positionAptitudes: ["FRONT"],
      },
    ],
    memories: [{ memoryDefinitionId: "MEM_A", displayName: "メモリーA" }],
  };
}

function readyGetCatalogImpl() {
  return vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
    Promise.resolve({ ok: true, response: catalogResponse() }),
  );
}

function unitState(battleUnitId: string, unitDefinitionId: string, side: string) {
  return {
    battleUnitId,
    unitDefinitionId,
    side,
    combatStatus: "ACTIVE",
    hp: { current: 100, maximum: 100 },
  };
}

function unitSummary(battleUnitId: string, side: string) {
  return {
    battleUnitId,
    side,
    damageDealt: 0,
    damageTaken: 0,
    healingDone: 0,
    finalHp: 100,
    maximumHp: 100,
    combatStatus: "ACTIVE",
  };
}

function exerciseResponse(
  overrides: Partial<TacticalExerciseResponse> = {},
): TacticalExerciseResponse {
  const units = [unitState("ally:1", "UNIT_A", "ALLY"), unitState("enemy:1", "UNIT_EX", "ENEMY")];
  return {
    schemaVersion: 1,
    battleId: "exercise-01J",
    catalogRevision: "rev-1",
    result: {
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 5,
      totalScore: 4200,
      breakCount: 2,
      breaks: [
        { breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 1500 },
        { breakNumber: 2, turnNumber: 4, cumulativeScoreAtBreak: 3600 },
      ],
    },
    initialState: { units },
    finalState: { units },
    unitSummaries: [unitSummary("ally:1", "ALLY"), unitSummary("enemy:1", "ENEMY")],
    events: [],
    stateTransitions: [],
    ...overrides,
  };
}

function battleResponse(): BattleSimulationResponse {
  const units = [unitState("ally:1", "UNIT_A", "ALLY"), unitState("enemy:1", "UNIT_B", "ENEMY")];
  return {
    schemaVersion: 1,
    battleId: "battle-01J",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units },
    finalState: { units },
    unitSummaries: [unitSummary("ally:1", "ALLY"), unitSummary("enemy:1", "ENEMY")],
    events: [],
    stateTransitions: [],
  };
}

async function waitForCatalog() {
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
  });
}

/** 指定陣営の前衛1へユニットを置く。枠は陣営のsectionへスコープして選ぶ。 */
async function placeUnit(
  user: UserEvent,
  side: "ally" | "enemy",
  unitName: string,
  positionLabel = "前衛1",
) {
  const section = screen.getByRole("region", {
    name: side === "ally" ? /ALLY FORMATION/ : /ENEMY FORMATION/,
  });
  await user.click(
    within(section).getByRole("button", { name: `${positionLabel}にユニットを追加` }),
  );
  await user.click(screen.getByRole("button", { name: `${unitName}を選択` }));
}

async function switchMode(user: UserEvent, label: "通常戦闘" | "戦術演習") {
  await user.click(screen.getByRole("tab", { name: label }));
}

// UI-CT-027
describe("BattleSimulatorPage — mode tabs (UI-CT-027)", () => {
  it("switches between the battle and exercise modes from the keyboard, tracking aria-selected", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();

    const exerciseTab = screen.getByRole("tab", { name: "戦術演習" });
    expect(exerciseTab).toHaveAttribute("aria-selected", "true");

    exerciseTab.focus();
    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("tab", { name: "通常戦闘" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "戦術演習" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("POST /api/v1/battle-simulations")).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "戦術演習" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("POST /api/v1/tactical-exercises")).toBeInTheDocument();
  });
});

// UI-CT-028
describe("BattleSimulatorPage — exercise formation constraints (UI-CT-028)", () => {
  it("hides the enemy memory slots and the turn limit input", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");

    expect(screen.queryByLabelText("ターン上限")).not.toBeInTheDocument();
    expect(screen.getByText("5ターン固定")).toBeInTheDocument();
    expect(screen.queryByText("ENEMY MEMORY / 0-6")).not.toBeInTheDocument();
    expect(screen.getByText("ALLY MEMORY / 0-6")).toBeInTheDocument();
  });

  it("cannot place a second enemy unit: choosing another slot moves the single enemy there", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    const enemy = screen.getByRole("region", { name: /ENEMY FORMATION/ });

    await placeUnit(user, "enemy", "エクサ");
    await placeUnit(user, "enemy", "エクサ旧", "後衛3");

    // 敵陣営に居るのは常に1体。前衛1は空き枠へ戻り、選んだ枠だけが埋まる。
    expect(within(enemy).getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(5);
    expect(
      within(enemy).getByRole("button", { name: "後衛3: エクサ旧を変更" }),
    ).toBeInTheDocument();
    expect(
      within(enemy).getByRole("button", { name: "前衛1にユニットを追加" }),
    ).toBeInTheDocument();
  });
});

// UI-CT-029
describe("BattleSimulatorPage — exercise request (UI-CT-029)", () => {
  it("posts no turnLimit, exactly one enemy unit and an empty enemy memory array", async () => {
    const user = userEvent.setup();
    const simulateTacticalExerciseImpl = vi.fn<
      (
        request: TacticalExerciseRequest,
        options: SimulateOptions,
      ) => Promise<ExecutionApiResult<TacticalExerciseResponse>>
    >(() => Promise.resolve({ ok: true, response: exerciseResponse() }));

    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={simulateTacticalExerciseImpl}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");

    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));

    await waitFor(() => {
      expect(simulateTacticalExerciseImpl).toHaveBeenCalledTimes(1);
    });
    const request = simulateTacticalExerciseImpl.mock.calls[0]![0];
    expect(request).not.toHaveProperty("turnLimit");
    expect(request.enemyFormation).toEqual({
      units: [{ unitDefinitionId: "UNIT_EX", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    });
    expect(request.allyFormation.units).toHaveLength(1);
  });

  // UI-CT-060: 敵の配置座標はそのままリクエストへ載る（`POSITION_ROW`条件・
  // 前後列優先の対象順が参照するため、敵1体でも配置で結果が変わる）。
  it("posts the enemy position the user chose, not a fixed front-left one", async () => {
    const user = userEvent.setup();
    const simulateTacticalExerciseImpl = vi.fn<
      (
        request: TacticalExerciseRequest,
        options: SimulateOptions,
      ) => Promise<ExecutionApiResult<TacticalExerciseResponse>>
    >(() => Promise.resolve({ ok: true, response: exerciseResponse() }));

    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={simulateTacticalExerciseImpl}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ", "後衛3");

    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));

    await waitFor(() => {
      expect(simulateTacticalExerciseImpl).toHaveBeenCalledTimes(1);
    });
    const request = simulateTacticalExerciseImpl.mock.calls[0]![0];
    expect(request.enemyFormation.units).toEqual([
      { unitDefinitionId: "UNIT_EX", position: { column: 2, row: "REAR" } },
    ]);
  });

  it("keeps the exercise submit disabled until an enemy unit is chosen", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");

    expect(screen.getByRole("button", { name: "戦術演習を開始" })).toBeDisabled();
    expect(
      screen.getByText("戦術演習では敵ユニットを1体だけ設定してください。"),
    ).toBeInTheDocument();
  });
});

// UI-CT-030
describe("BattleSimulatorPage — exercise result (UI-CT-030)", () => {
  async function runExercise(response: TacticalExerciseResponse) {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={vi.fn(() => Promise.resolve({ ok: true as const, response }))}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));
    await waitFor(() => {
      expect(screen.getByText("戦術演習が完了しました。")).toBeInTheDocument();
    });
    return user;
  }

  it("shows the total score, break count, completion reason and the break history", async () => {
    await runExercise(exerciseResponse());

    expect(screen.getByText("TOTAL SCORE").parentElement).toHaveTextContent("4,200");
    expect(screen.getByText("BREAK COUNT").parentElement).toHaveTextContent("2");
    expect(screen.getByText("COMPLETION REASON").parentElement).toHaveTextContent("ターン上限到達");
    const breakTimeline = screen.getByRole("region", { name: /BREAK TIMELINE/ });
    const breakRows = within(breakTimeline).getAllByRole("row").slice(1);
    expect(breakRows).toHaveLength(2);
    expect(breakRows[0]).toHaveTextContent("1,500");
    expect(breakRows[1]).toHaveTextContent("3,600");
    expect(screen.queryByText("OUTCOME")).not.toBeInTheDocument();
  });

  it("still renders the result when no break happened", async () => {
    await runExercise(
      exerciseResponse({
        result: {
          completionReason: "ALLY_DEFEATED",
          completedTurn: 3,
          totalScore: 0,
          breakCount: 0,
          breaks: [],
        },
      }),
    );

    expect(screen.getByText("TOTAL SCORE").parentElement).toHaveTextContent("0");
    expect(screen.getByText("COMPLETION REASON").parentElement).toHaveTextContent("味方陣営全滅");
    expect(screen.getByText("ブレイクは発生しませんでした。")).toBeInTheDocument();
  });

  it("treats a result that breaks the exercise contract as RESPONSE_CONTRACT_MISMATCH", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={vi.fn(() =>
          Promise.resolve({
            ok: false as const,
            status: 200,
            error: {
              kind: "RESPONSE_CONTRACT_MISMATCH" as const,
              message: "Tactical exercise response result is malformed.",
            },
          }),
        )}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));

    await waitFor(() => {
      expect(screen.getByText("レスポンスの形式が想定と異なります。")).toBeInTheDocument();
    });
  });
});

// UI-CT-031
describe("BattleSimulatorPage — exercise events in the timeline (UI-CT-031)", () => {
  it("renders score, break and revive events, and survives unknown exercise details", async () => {
    const user = userEvent.setup();
    const response = exerciseResponse({
      events: [
        {
          type: "EXERCISE_SCORE_ACCUMULATED",
          details: {
            targetUnitId: "enemy:1",
            amount: 1500,
            totalScore: 1500,
            causeEventId: "evt-1",
          },
        },
        {
          type: "UNIT_BROKEN",
          details: {
            unitId: "enemy:1",
            breakNumber: 1,
            turnNumber: 2,
            totalScore: 1500,
            causeEventId: "evt-2",
          },
        },
        { type: "UNIT_REVIVED", details: { unitId: "enemy:1", breakNumber: 1, hpAfter: 100 } },
        // 未知shapeの演習details・未知の演習イベント: どちらも汎用表示へ落ちる。
        { type: "UNIT_BROKEN", details: { unitId: 7 } },
        { type: "EXERCISE_FUTURE_EVENT", details: { anything: true } },
      ],
    });
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={vi.fn(() => Promise.resolve({ ok: true as const, response }))}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));
    await waitFor(() => {
      expect(screen.getByText("戦術演習が完了しました。")).toBeInTheDocument();
    });

    expect(screen.getAllByText("EXERCISE_SCORE_ACCUMULATED").length).toBeGreaterThan(0);
    expect(screen.getAllByText("UNIT_BROKEN")).toHaveLength(2);
    expect(screen.getAllByText("UNIT_REVIVED").length).toBeGreaterThan(0);
    expect(screen.getAllByText("EXERCISE_FUTURE_EVENT").length).toBeGreaterThan(0);
    expect(screen.getByText(/スコアが1,500加算されました/)).toBeInTheDocument();
  });
});

// UI-CT-032
describe("BattleSimulatorPage — per-mode state isolation (UI-CT-032)", () => {
  it("keeps each mode's draft and latest result, and a late old-mode success never overwrites the other mode", async () => {
    const user = userEvent.setup();
    let resolveBattle: ((result: SimulationApiResult) => void) | undefined;
    const simulateImpl = vi.fn<
      (request: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(
      () =>
        new Promise<SimulationApiResult>((resolve) => {
          resolveBattle = resolve;
        }),
    );

    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
        simulateTacticalExerciseImpl={vi.fn(() =>
          Promise.resolve({ ok: true as const, response: exerciseResponse() }),
        )}
      />,
    );
    await waitForCatalog();

    // 通常戦闘: 編成して送信し、応答を保留したままモードを離れる。
    await switchMode(user, "通常戦闘");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "ブラボー");
    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));
    await waitFor(() => {
      expect(simulateImpl).toHaveBeenCalledTimes(1);
    });

    await switchMode(user, "戦術演習");
    // 演習側のdraftは独立: 通常戦闘の編成を引き継がない（味方6枠・敵6枠とも空）。
    expect(screen.getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(12);

    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));
    await waitFor(() => {
      expect(screen.getByText("戦術演習が完了しました。")).toBeInTheDocument();
    });

    // 旧モードの応答がここで遅れて到着しても、表示中の演習結果を壊さない。
    resolveBattle?.({ ok: true, response: battleResponse() });
    await waitFor(() => {
      expect(screen.getByText("TOTAL SCORE")).toBeInTheDocument();
    });
    expect(screen.getByText("戦術演習が完了しました。")).toBeInTheDocument();
    expect(screen.queryByText("OUTCOME")).not.toBeInTheDocument();

    // 通常戦闘へ戻ると、そのモードのdraftと結果がそのまま残っている。
    await switchMode(user, "通常戦闘");
    await waitFor(() => {
      expect(screen.getByText("戦闘が完了しました。")).toBeInTheDocument();
    });
    expect(screen.getByText("ALLY WIN / 味方勝利")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /: アルファを変更/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /: ブラボーを変更/ })).toHaveLength(1);
    expect(screen.queryByText("TOTAL SCORE")).not.toBeInTheDocument();
  });
});

// UI-CT-053〜055: R-TEX-11 #2 #3 #4 の編成プール分離とバッジ。
describe("BattleSimulatorPage — unit pools (UI-CT-053/054/055)", () => {
  async function openUnitDialog(user: UserEvent, side: "ally" | "enemy") {
    const section = screen.getByRole("region", {
      name: side === "ally" ? /ALLY FORMATION/ : /ENEMY FORMATION/,
    });
    await user.click(within(section).getByRole("button", { name: "前衛1にユニットを追加" }));
  }

  function renderPage() {
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
  }

  it("UI-CT-053: offers only exercise enemies, badged with their event status, for the exercise enemy slot", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await switchMode(user, "戦術演習");

    await openUnitDialog(user, "enemy");

    expect(screen.getByRole("button", { name: "エクサを選択" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "エクサ旧を選択" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "アルファを選択" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ブラボーを選択" })).not.toBeInTheDocument();
    expect(screen.getByText("開催中")).toBeInTheDocument();
    expect(screen.getByText("開催終了")).toBeInTheDocument();
  });

  it.each([
    ["戦術演習", "ally"],
    ["通常戦闘", "ally"],
    ["通常戦闘", "enemy"],
  ] as const)(
    "UI-CT-054: offers only playable units for the %s %s slot",
    async (modeLabel, side) => {
      const user = userEvent.setup();
      renderPage();
      await waitForCatalog();
      await switchMode(user, modeLabel);

      await openUnitDialog(user, side);

      // `category`を持たないUNIT_A／UNIT_Bは`PLAYABLE`扱い（R-TEX-11 #1）。
      expect(screen.getByRole("button", { name: "アルファを選択" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "ブラボーを選択" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "エクサを選択" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "エクサ旧を選択" })).not.toBeInTheDocument();
    },
  );

  it("UI-CT-055: lets a closed exercise enemy be chosen and submitted", async () => {
    const user = userEvent.setup();
    const simulateTacticalExerciseImpl = vi.fn<
      (
        request: TacticalExerciseRequest,
        options: SimulateOptions,
      ) => Promise<ExecutionApiResult<TacticalExerciseResponse>>
    >(() => Promise.resolve({ ok: true, response: exerciseResponse() }));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={simulateTacticalExerciseImpl}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ旧");

    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));

    await waitFor(() => {
      expect(simulateTacticalExerciseImpl).toHaveBeenCalledTimes(1);
    });
    expect(simulateTacticalExerciseImpl.mock.calls[0]![0].enemyFormation.units).toEqual([
      { unitDefinitionId: "UNIT_EX_CLOSED", position: { column: 0, row: "FRONT" } },
    ]);
  });
});

// UI-CT-056: ダイアログの絞り込みを迂回して枠へ残った誤プールのユニット
// （保存draftの復元）も、送信前検証で止める。
describe("BattleSimulatorPage — restored draft with a mismatched pool (UI-CT-056)", () => {
  it("blocks the battle submission when a restored slot holds an exercise-only unit", async () => {
    const base = createInitialDraft();
    const draft: BattleDraft = {
      ...base,
      allySlots: base.allySlots.map((slot) =>
        slot.slotKey === slotKeyOf("ally", "FRONT", 0)
          ? { ...slot, unitDefinitionId: "UNIT_EX" }
          : slot,
      ),
      enemySlots: base.enemySlots.map((slot) =>
        slot.slotKey === slotKeyOf("enemy", "FRONT", 0)
          ? { ...slot, unitDefinitionId: "UNIT_B" }
          : slot,
      ),
    };
    window.localStorage.setItem("mlgg:last-draft", JSON.stringify(toStoredDraft(draft)));
    const simulateImpl = vi.fn<
      (request: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: battleResponse() }));

    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await waitForCatalog();
    await switchMode(userEvent.setup(), "通常戦闘");

    expect(screen.getByRole("button", { name: "戦闘を開始" })).toBeDisabled();
    expect(
      screen.getByText("この枠には戦術演習専用ユニットを設定できません。選び直してください。"),
    ).toBeInTheDocument();
    expect(simulateImpl).not.toHaveBeenCalled();
  });
});

// UI-CT-057: R-TEX-11 #5。演習の敵枠はEXERCISE_ENEMYなので、モードを送らないと
// プレビューが422になり枠のステータス表示が落ちる。
describe("BattleSimulatorPage — stat preview mode (UI-CT-057)", () => {
  function previewImpl() {
    return vi.fn<
      (
        request: FormationStatPreviewRequest,
        options: SimulateOptions,
      ) => Promise<FormationStatPreviewApiResult>
    >(() =>
      Promise.resolve({
        ok: true,
        response: { schemaVersion: 1, catalogRevision: "rev-1", units: [] },
      }),
    );
  }

  it("sends mode TACTICAL_EXERCISE in the exercise mode and omits it in the battle mode", async () => {
    const user = userEvent.setup();
    const previewFormationStatsImpl = previewImpl();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        previewFormationStatsImpl={previewFormationStatsImpl}
      />,
    );
    await waitForCatalog();

    await switchMode(user, "通常戦闘");
    await placeUnit(user, "ally", "アルファ");
    await waitFor(() => {
      expect(previewFormationStatsImpl).toHaveBeenCalled();
    });
    expect(previewFormationStatsImpl.mock.calls.at(-1)![0]).not.toHaveProperty("mode");

    await switchMode(user, "戦術演習");
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");

    await waitFor(() => {
      expect(previewFormationStatsImpl.mock.calls.at(-1)![0].mode).toBe("TACTICAL_EXERCISE");
    });
  });
});

// UI-CT-058 / UI-CT-059: 戦術演習を既定モードにし、演習draftも通常戦闘と同じく
// リロードをまたいで復元する。
describe("BattleSimulatorPage — exercise mode as the default (UI-CT-058/059)", () => {
  function renderPage() {
    return render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
  }

  it("UI-CT-058: opens on the tactical exercise tab", async () => {
    renderPage();
    await waitForCatalog();

    expect(screen.getByRole("tab", { name: "戦術演習" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "通常戦闘" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("POST /api/v1/tactical-exercises")).toBeInTheDocument();
  });

  it("UI-CT-059: restores the exercise formation after a remount", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    first.unmount();

    renderPage();
    await waitForCatalog();

    expect(
      within(screen.getByRole("region", { name: /ALLY FORMATION/ })).getByRole("button", {
        name: /前衛1: アルファを変更/,
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: /ENEMY FORMATION/ })).getByRole("button", {
        name: /前衛1: エクサを変更/,
      }),
    ).toBeInTheDocument();
  });

  // 両モードのdraftは別々のキーへ保存する。片方の編成がもう片方へ現れてはならない。
  it("keeps the battle draft separate from the exercise draft across a remount", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await switchMode(user, "通常戦闘");
    await placeUnit(user, "enemy", "ブラボー");
    first.unmount();

    renderPage();
    await waitForCatalog();

    // 既定は演習モード: 演習の敵枠が戻る。
    expect(
      within(screen.getByRole("region", { name: /ENEMY FORMATION/ })).getByRole("button", {
        name: /前衛1: エクサを変更/,
      }),
    ).toBeInTheDocument();

    await switchMode(user, "通常戦闘");
    expect(
      within(screen.getByRole("region", { name: /ENEMY FORMATION/ })).getByRole("button", {
        name: /前衛1: ブラボーを変更/,
      }),
    ).toBeInTheDocument();
  });
});

// UI-CT-083 / UI-CT-084: Issue #539。演習の実行はログレベルではなく実行モードで
// 選ぶ。統計実行の実行基盤は後続Issueなので、選んでも実行できないことを示す。
describe("BattleSimulatorPage — 戦術演習の実行モード (UI-CT-083/084)", () => {
  it("UI-CT-083: swaps the log level select for the execution mode switch in the exercise mode only", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();

    expect(screen.getByLabelText("実行モード")).toBeInTheDocument();
    expect(screen.queryByLabelText("ログレベル")).not.toBeInTheDocument();

    await switchMode(user, "通常戦闘");

    expect(screen.getByLabelText("ログレベル")).toBeInTheDocument();
    expect(screen.queryByLabelText("実行モード")).not.toBeInTheDocument();
  });

  it("UI-CT-084: blocks the run while the run count is out of range and re-enables it once fixed", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={vi.fn(() =>
          Promise.resolve({ ok: true as const, response: exerciseResponse() }),
        )}
      />,
    );
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");

    await user.selectOptions(screen.getByLabelText("実行モード"), "STATISTICS");

    expect(screen.getByRole("button", { name: "戦術演習を開始" })).toBeEnabled();

    await user.clear(screen.getByLabelText("実行回数"));

    expect(screen.getByRole("button", { name: "戦術演習を開始" })).toBeDisabled();

    await user.type(screen.getByLabelText("実行回数"), "2");

    expect(screen.getByRole("button", { name: "戦術演習を開始" })).toBeEnabled();
  });

  it("UI-CT-084: shows the run count violation on the run count input", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.selectOptions(screen.getByLabelText("実行モード"), "STATISTICS");

    await user.clear(screen.getByLabelText("実行回数"));

    expect(screen.getByLabelText("実行回数")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText(/実行回数は1～2,000の整数/).length).toBeGreaterThan(0);
  });

  it("UI-CT-083: keeps the exercise execution input out of the battle mode draft", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();
    await user.selectOptions(screen.getByLabelText("実行モード"), "STATISTICS");

    await switchMode(user, "通常戦闘");
    await switchMode(user, "戦術演習");

    expect(screen.getByLabelText("実行モード")).toHaveValue("STATISTICS");
  });
});

// UI-CT-086: Issue #541。統計実行が指定回数をチャンクへ割って逐次送り、進捗・中断・
// 結果件数を出す。
describe("BattleSimulatorPage — 統計実行 (UI-CT-086)", () => {
  function evaluationResponse(
    runs: number,
    catalogRevision = "rev-1",
    seed = "abc#0",
  ): TacticalExerciseEvaluationResponse {
    const indices = Array.from({ length: runs }, (_value, index) => index);
    return {
      schemaVersion: 1,
      catalogRevision,
      seed,
      runsPerCandidate: runs,
      candidates: [
        {
          completedRuns: runs,
          scores: indices.map(() => 1000),
          breakCounts: indices.map(() => 1),
          completedTurns: indices.map(() => 5),
          completionReasons: indices.map(() => "TURN_LIMIT_REACHED"),
          allyUnitDamageTotals: indices.map(() => [500]),
          allyUnitBreakCounts: indices.map(() => [1]),
        },
      ],
    };
  }

  async function startStatisticsRun(
    user: UserEvent,
    evaluateTacticalExerciseImpl: EvaluateImpl,
    runCount: string,
  ) {
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        evaluateTacticalExerciseImpl={evaluateTacticalExerciseImpl}
      />,
    );
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.selectOptions(screen.getByLabelText("実行モード"), "STATISTICS");
    await user.clear(screen.getByLabelText("実行回数"));
    await user.type(screen.getByLabelText("実行回数"), runCount);
    await user.type(screen.getByLabelText("シード"), "abc");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));
  }

  it("runs the requested runs as sequential chunks and reports how many were aggregated", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(({ runsPerCandidate, seed }) =>
      Promise.resolve({ ok: true, response: evaluationResponse(runsPerCandidate, "rev-1", seed) }),
    );

    await startStatisticsRun(user, evaluateImpl, "301");

    await waitFor(() => {
      expect(screen.getByText(/301試行を集計しました/)).toBeInTheDocument();
    });
    expect(evaluateImpl.mock.calls.map(([request]) => request.runsPerCandidate)).toEqual([300, 1]);
    expect(evaluateImpl.mock.calls.map(([request]) => request.seed)).toEqual(["abc#0", "abc#300"]);
  });

  it("shows the progress and a cancel control while the run is in flight", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(
      (_request, options) =>
        new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
          });
        }),
    );

    await startStatisticsRun(user, evaluateImpl, "600");

    expect(await screen.findByRole("progressbar", { name: "統計実行の進捗" })).toHaveAttribute(
      "max",
      "600",
    );
    expect(screen.getByRole("button", { name: "中断して結果を見る" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "実行中…" })).toBeDisabled();
    // 単一実行と同じく、実行中の編成編集は止める。走っているチャンクは実行開始時の
    // 編成で送られ続けるため、編集できると画面と結果が食い違う。
    expect(
      within(screen.getByRole("region", { name: /ALLY FORMATION/ })).getByRole("button", {
        name: /前衛1: アルファを変更/,
      }),
    ).toBeDisabled();
  });

  // ロックは演習タブの中に閉じる。統計実行の進捗も中断ボタンも演習タブにしか無いため、
  // 通常戦闘まで止めると「止める手段が無いまま数分待たされる」状態になる。
  it("does not lock the battle mode while the statistics run is in flight", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(
      (_request, options) =>
        new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
          });
        }),
    );

    await startStatisticsRun(user, evaluateImpl, "600");
    await screen.findByRole("progressbar", { name: "統計実行の進捗" });

    await switchMode(user, "通常戦闘");

    expect(screen.queryByRole("button", { name: "実行中…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "キャンセル" })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: /ALLY FORMATION/ })).getByRole("button", {
        name: "前衛1にユニットを追加",
      }),
    ).toBeEnabled();

    // 演習タブへ戻れば実行は続いており、中断できる。
    await switchMode(user, "戦術演習");

    expect(screen.getByRole("button", { name: "中断して結果を見る" })).toBeInTheDocument();
  });

  it("keeps the chunks already completed when the run is cancelled", async () => {
    const user = userEvent.setup();
    let call = 0;
    const evaluateImpl = vi.fn<EvaluateImpl>((_request, options) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({ ok: true, response: evaluationResponse(300, "rev-1", "abc#0") });
      }
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
        });
      });
    });

    await startStatisticsRun(user, evaluateImpl, "900");

    await waitFor(() => {
      expect(evaluateImpl).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole("button", { name: "中断して結果を見る" }));

    await waitFor(() => {
      expect(screen.getByText(/300試行を集計しました/)).toBeInTheDocument();
    });
    expect(evaluateImpl).toHaveBeenCalledTimes(2);
  });

  it("explains a 404 ENDPOINT_DISABLED as this deployment not offering the statistics run", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        error: {
          kind: "SERVER",
          status: 404,
          code: "ENDPOINT_DISABLED",
          message: "This endpoint is not enabled on this server.",
        },
      }),
    );

    await startStatisticsRun(user, evaluateImpl, "300");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この環境では統計実行を利用できません",
    );
  });

  // `EVALUATION_MAX_TOTAL_RUNS`を300未満へ絞った配備では全チャンクが422になる。サーバーは
  // `/runsPerCandidate`をJSON Pointerで返すので、送信前検証と同じ実行回数入力へ出す。
  it("shows a 422 on the run count input, not only as a message", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        error: {
          kind: "VALIDATION",
          status: 422,
          code: "INVALID_COMMAND",
          message: "invalid",
          violations: [
            {
              path: "/runsPerCandidate",
              message: "candidates x runsPerCandidate must not exceed 100 total runs, got 300",
            },
          ],
        },
      }),
    );

    await startStatisticsRun(user, evaluateImpl, "300");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("入力内容を確認してください。");
    });
    expect(screen.getByLabelText("実行回数")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText(/must not exceed 100 total runs/).length).toBeGreaterThan(0);
  });

  // 422の枠表示は統計実行の中に閉じる。slotKeyは`side:row:column`でモード間共通のため、
  // 絞らないと通常戦闘の同じ座標の枠が、説明の無いまま赤くなる。
  it("keeps a 422 formation violation out of the other modes", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        error: {
          kind: "VALIDATION",
          status: 422,
          code: "DEFINITION_NOT_FOUND",
          message: "unknown unit",
          violations: [
            {
              path: "/candidates/0/allyFormation/units/0/unitDefinitionId",
              message: "定義が見つかりません",
            },
          ],
        },
      }),
    );

    await startStatisticsRun(user, evaluateImpl, "300");

    // 統計実行のタブでは、送信した編成の枠へ出る。
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(
      within(screen.getByRole("region", { name: /ALLY FORMATION/ })).getByRole("button", {
        name: /前衛1: アルファを変更、入力エラーがあります/,
      }),
    ).toBeInTheDocument();

    await switchMode(user, "通常戦闘");

    expect(screen.queryByRole("button", { name: /入力エラーがあります/ })).not.toBeInTheDocument();

    // 単一実行へ戻したときも、統計実行の失敗は残さない。
    await switchMode(user, "戦術演習");
    await user.selectOptions(screen.getByLabelText("実行モード"), "SINGLE");

    expect(screen.queryByRole("button", { name: /入力エラーがあります/ })).not.toBeInTheDocument();
  });

  // 実行後は編成を編集できる。結果はそのまま残るため、いまの編成の結果に見えてしまう。
  it("marks a finished result as stale once the formation changes", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(({ runsPerCandidate, seed }) =>
      Promise.resolve({ ok: true, response: evaluationResponse(runsPerCandidate, "rev-1", seed) }),
    );

    await startStatisticsRun(user, evaluateImpl, "2");

    await waitFor(() => {
      expect(screen.getByText(/2試行を集計しました/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/変更前の条件/)).not.toBeInTheDocument();

    await placeUnit(user, "ally", "ブラボー", "前衛2");

    expect(screen.getByText(/変更前の条件/)).toBeInTheDocument();
  });

  it("runs the single-run endpoint, not the evaluation endpoint, in the single mode", async () => {
    const user = userEvent.setup();
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({ ok: true, response: evaluationResponse(1) }),
    );
    const simulateTacticalExerciseImpl = vi.fn(() =>
      Promise.resolve({ ok: true as const, response: exerciseResponse() }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={simulateTacticalExerciseImpl}
        evaluateTacticalExerciseImpl={evaluateImpl}
      />,
    );
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");

    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));

    await waitFor(() => {
      expect(simulateTacticalExerciseImpl).toHaveBeenCalledOnce();
    });
    expect(evaluateImpl).not.toHaveBeenCalled();
  });
});

// UI-CT-091: Issue #542。統計実行の結果は演習サマリ（Panel 02）とキャラ別統計
// （Panel 03）を差し替える。単一実行の表示は現行のままにする。
describe("BattleSimulatorPage — 統計可視化パネル (UI-CT-091)", () => {
  function statisticsResponse(
    runs: number,
    seed: string,
    catalogRevision = "rev-1",
  ): TacticalExerciseEvaluationResponse {
    const indices = Array.from({ length: runs }, (_value, index) => index);
    return {
      schemaVersion: 1,
      catalogRevision,
      seed,
      runsPerCandidate: runs,
      candidates: [
        {
          completedRuns: runs,
          scores: indices.map((index) => 1000 + index * 10),
          breakCounts: indices.map((index) => index % 3),
          completedTurns: indices.map(() => 5),
          completionReasons: indices.map(() => "TURN_LIMIT_REACHED"),
          allyUnitDamageTotals: indices.map((index) => [400 + index]),
          allyUnitBreakCounts: indices.map((index) => [index % 3]),
        },
      ],
    };
  }

  async function runStatistics(user: UserEvent, runCount = "40") {
    const evaluateImpl = vi.fn<EvaluateImpl>(({ runsPerCandidate, seed }) =>
      Promise.resolve({ ok: true, response: statisticsResponse(runsPerCandidate, seed) }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        evaluateTacticalExerciseImpl={evaluateImpl}
      />,
    );
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.selectOptions(screen.getByLabelText("実行モード"), "STATISTICS");
    await user.clear(screen.getByLabelText("実行回数"));
    await user.type(screen.getByLabelText("実行回数"), runCount);
    await user.type(screen.getByLabelText("シード"), "abc");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));
    await screen.findByText(/試行を集計しました/);
    return evaluateImpl;
  }

  it("replaces the exercise summary and details panels with the statistics panels", async () => {
    const user = userEvent.setup();
    await runStatistics(user);

    expect(screen.getByRole("heading", { name: /演習統計サマリ/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /キャラ別統計/ })).toBeInTheDocument();
    expect(screen.getByText("完了 RUN").closest("div")).toHaveTextContent("40");
    // 単一実行の表示（ブレイク履歴・詳細タブ）は統計実行では出ない。
    expect(screen.queryByRole("heading", { name: /ブレイク履歴/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /イベント/ })).not.toBeInTheDocument();
  });

  // 列に名前を付けられるのは送信時の編成だけである。
  it("names the per-unit columns with the submitted formation", async () => {
    const user = userEvent.setup();
    await runStatistics(user);

    // 与ダメージ表とブレイク回数表の両方に同じ列が並ぶ。
    expect(screen.getAllByRole("rowheader", { name: "アルファ" })).toHaveLength(2);
  });

  // 統計は表示のたびに再計算される。実行後に編成を編集しても、結果は送信時の編成の
  // ものであり、その旨は`StatisticsRunFeedback`が示す。
  it("keeps the statistics panels after the formation is edited", async () => {
    const user = userEvent.setup();
    await runStatistics(user);

    await placeUnit(user, "ally", "ブラボー", "前衛2");

    expect(await screen.findByText("この結果は変更前の条件です。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /演習統計サマリ/ })).toBeInTheDocument();
  });

  // 中断は「完了済みチャンクまでで確定した結果」であり、要求どおり完走したのとは違う。
  // 集約が持つのは送信したチャンクの合計であって利用者が入力した実行回数ではないため、
  // それを「要求」として出すと、すぐ上の実行結果（要求600試行）と食い違う。
  it("keeps the requested run count of the user when the run was cancelled", async () => {
    const user = userEvent.setup();
    let call = 0;
    const evaluateImpl = vi.fn<EvaluateImpl>((request, options) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          response: statisticsResponse(request.runsPerCandidate, request.seed),
        });
      }
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
        });
      });
    });
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        evaluateTacticalExerciseImpl={evaluateImpl}
      />,
    );
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.selectOptions(screen.getByLabelText("実行モード"), "STATISTICS");
    await user.clear(screen.getByLabelText("実行回数"));
    await user.type(screen.getByLabelText("実行回数"), "600");
    await user.type(screen.getByLabelText("シード"), "abc");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));

    await waitFor(() => {
      expect(evaluateImpl).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole("button", { name: "中断して結果を見る" }));
    await screen.findByText(/300試行を集計しました/);

    // 実行結果の要約と統計サマリが同じ「要求」を指す。
    expect(screen.getByText(/300試行を集計しました/).closest("p")).toHaveTextContent(
      "要求 600試行",
    );
    expect(screen.getByText("完了 RUN").closest("div")).toHaveTextContent("/ 600 要求");
    expect(screen.getByText(/600試行の要求に対し300試行/)).toBeInTheDocument();
  });

  it("shows the single-run panels when the mode is a single run", async () => {
    const user = userEvent.setup();
    const simulateTacticalExerciseImpl = vi.fn(() =>
      Promise.resolve({ ok: true as const, response: exerciseResponse() }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTacticalExerciseImpl={simulateTacticalExerciseImpl}
      />,
    );
    await waitForCatalog();
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "エクサ");
    await user.click(screen.getByRole("button", { name: "戦術演習を開始" }));

    expect(await screen.findByRole("heading", { name: /演習サマリ/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /演習統計サマリ/ })).not.toBeInTheDocument();
  });
});
