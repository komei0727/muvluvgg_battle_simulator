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
  TacticalExerciseResponse,
} from "../features/simulation/api-contract.js";
import type { TacticalExerciseRequest } from "../features/exercise/exercise-request-mapper.js";
import type {
  BattleSimulationRequest,
  FormationStatPreviewRequest,
} from "../features/formation/request-mapper.js";
import { toStoredDraft } from "../features/formation/persistence.js";
import { createInitialDraft, slotKeyOf } from "../features/formation/types.js";
import type { BattleDraft } from "../features/formation/types.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

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
async function placeUnit(user: UserEvent, side: "ally" | "enemy", unitName: string) {
  const section = screen.getByRole("region", {
    name: side === "ally" ? /ALLY FORMATION/ : /ENEMY FORMATION/,
  });
  await user.click(within(section).getByRole("button", { name: "前衛1にユニットを追加" }));
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

    const battleTab = screen.getByRole("tab", { name: "通常戦闘" });
    expect(battleTab).toHaveAttribute("aria-selected", "true");

    battleTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "戦術演習" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "通常戦闘" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("POST /api/v1/tactical-exercises")).toBeInTheDocument();
  });
});

// UI-CT-028
describe("BattleSimulatorPage — exercise formation constraints (UI-CT-028)", () => {
  it("hides the enemy memory slots and the turn limit input, and offers only one enemy unit slot", async () => {
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

  it("cannot place a second enemy unit: only the FRONT 1 enemy slot exists", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitForCatalog();
    await switchMode(user, "戦術演習");

    await placeUnit(user, "enemy", "エクサ");

    // 味方側の空き枠は6枠、敵側は埋まった1枠だけ。敵の2体目を置く導線が存在しない。
    expect(screen.getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: /: エクサを変更/ })).toHaveLength(1);
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
    await placeUnit(user, "ally", "アルファ");
    await placeUnit(user, "enemy", "ブラボー");
    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));
    await waitFor(() => {
      expect(simulateImpl).toHaveBeenCalledTimes(1);
    });

    await switchMode(user, "戦術演習");
    // 演習側のdraftは独立: 通常戦闘の編成を引き継がない。
    expect(screen.getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(7);

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
      if (modeLabel === "戦術演習") {
        await switchMode(user, modeLabel);
      }

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
