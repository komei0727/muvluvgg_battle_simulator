import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions, SimulateOptions } from "../shared/api/api-client.js";
import type { BattleDraft } from "../entities/battle-draft.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationRequest,
  BattleSimulationResponse,
  CatalogApiResult,
  FormationStatPreviewApiResult,
  FormationStatPreviewRequest,
  SimulationApiResult,
  TacticalExerciseEvaluationApiResult,
  TacticalExerciseEvaluationRequest,
  TacticalExerciseResponse,
} from "../shared/api/api-contract.js";

import { toStoredDraft } from "../features/formation/persistence.js";
import { createInitialDraft, slotKeyOf } from "../features/formation/types.js";
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

// UI-CT-032: NormalBattleMode / TacticalExerciseModeは常時マウントされたまま
// 非活性時にnullを返すだけであり（REF-059）、モードを跨いでも互いのstateを
// 破壊しないことを両コンテナ越しに検証する。
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

// UI-CT-054: R-TEX-11 #2 #3。「playable」プールが両モードのally枠・通常戦闘の
// enemy枠で一致することを、両コンテナ越しに検証する（UI-CT-053/055は
// `TacticalExerciseMode.test.tsx`、REF-059）。
describe("BattleSimulatorPage — unit pools (UI-CT-054)", () => {
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

// 両モードのdraftは別々のキーへ保存する。片方の編成がもう片方へ現れてはならない
// （UI-CT-058/059の単体復元は`TacticalExerciseMode.test.tsx`、REF-059）。
describe("BattleSimulatorPage — exercise mode as the default (UI-CT-058/059)", () => {
  function renderPage() {
    return render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
  }

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
// 選ぶ（実行モード切替そのものの検証はモード横断のためここに残す。UI-CT-084/110は
// `TacticalExerciseMode.test.tsx`、REF-059）。
describe("BattleSimulatorPage — 戦術演習の実行モード (UI-CT-083/109)", () => {
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

  it("UI-CT-109: keeps the exercise execution input out of the battle mode draft", async () => {
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

// UI-CT-086: Issue #541。統計実行が他モードへ影響しないことの検証（ロックの範囲・
// 422の枠表示）は両コンテナ越しの関心事のためここに残す（単体の挙動は
// `TacticalExerciseMode.test.tsx`、REF-059）。
describe("BattleSimulatorPage — 統計実行 (UI-CT-086)", () => {
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
});
