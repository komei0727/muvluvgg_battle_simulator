import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions, SimulateOptions } from "../shared/api/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  CatalogApiResult,
  FormationStatPreviewApiResult,
  FormationStatPreviewRequest,
  TotalWarApiResult,
  TotalWarRequest,
  TotalWarResponse,
} from "../shared/api/api-contract.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

vi.mock("../features/catalog-selection/definition-image-map.js", () => ({
  unitImageMap: {},
  memoryImageMap: {},
  definitionImageMap: {},
}));

// プレビューは編成の変化に反応して取りに行く。既定では実fetchへ出さずnetwork失敗にする。
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
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
        positionAptitudes: ["FRONT", "BACK"],
      },
      {
        unitDefinitionId: "UNIT_B",
        displayName: "ベータ",
        characterName: "Beta",
        attribute: "SMART",
        unitType: "DEFENDER",
        role: "TANK",
        positionAptitudes: ["FRONT", "BACK"],
      },
      {
        unitDefinitionId: "TEX_ENEMY",
        displayName: "演習の敵",
        characterName: "Exercise",
        attribute: "SMART",
        unitType: "DEFENDER",
        role: "TANK",
        positionAptitudes: ["FRONT"],
        category: "EXERCISE_ENEMY",
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

function totalWarResponse(): TotalWarResponse {
  return {
    schemaVersion: 1,
    battleId: "total-war-01J",
    catalogRevision: "rev-1",
    result: {
      outcome: "DRAW",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 15,
      stages: [],
      defeatedFormationCounts: { ally: 0, enemy: 0 },
    },
    initialState: { units: [] },
    unitRoster: [],
    unitSummaries: [],
    events: [],
    stateTransitions: [],
  };
}

type SimulateTotalWarFn = (
  request: TotalWarRequest,
  options: SimulateOptions,
) => Promise<TotalWarApiResult>;

function succeedingSimulate() {
  return vi.fn<SimulateTotalWarFn>(() =>
    Promise.resolve({ ok: true, response: totalWarResponse() }),
  );
}

function renderPage(simulateTotalWarImpl = succeedingSimulate()) {
  const result = render(
    <BattleSimulatorPage
      apiBaseUrl="https://api.example.com"
      getCatalogImpl={readyGetCatalogImpl()}
      simulateTotalWarImpl={simulateTotalWarImpl}
    />,
  );
  return { ...result, simulateTotalWarImpl };
}

async function openTotalWar(user: UserEvent) {
  await user.click(screen.getByRole("tab", { name: "総力戦" }));
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
  });
}

function allySection() {
  return screen.getByRole("region", { name: /ALLY FORMATION/ });
}

function enemySection() {
  return screen.getByRole("region", { name: /ENEMY FORMATION/ });
}

/** 陣営の編成タブ・追加・削除・エディタを包む領域。 */
function allyPanel() {
  return allySection().closest("[data-formation-side='ally']") as HTMLElement;
}

function enemyPanel() {
  return enemySection().closest("[data-formation-side='enemy']") as HTMLElement;
}

function allyTabs() {
  return screen.getByRole("tablist", { name: "味方の編成" });
}

function enemyTabs() {
  return screen.getByRole("tablist", { name: "敵の編成" });
}

async function placeUnit(
  user: UserEvent,
  section: HTMLElement,
  slotLabel: string,
  displayName: string,
) {
  await user.click(within(section).getByRole("button", { name: slotLabel }));
  await user.click(screen.getByRole("button", { name: `${displayName}を選択` }));
}

/** 両陣営の表示中の編成の前衛1へユニットを置く。 */
async function fillDisplayedFormations(user: UserEvent, ally = "アルファ", enemy = "アルファ") {
  await placeUnit(user, allySection(), "前衛1にユニットを追加", ally);
  await placeUnit(user, enemySection(), "前衛1にユニットを追加", enemy);
}

function submitButton() {
  return screen.getByRole("button", { name: "総力戦を開始" });
}

describe("TotalWarMode — mode tab (UI-UC-007)", () => {
  it("UI-CT-164: offers a 総力戦 mode tab, keeps the exercise default, and keeps the total war result across mode switches", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining(["通常戦闘", "戦術演習", "総力戦"]),
    );
    expect(screen.getByRole("tab", { name: "戦術演習" })).toHaveAttribute("aria-selected", "true");

    await openTotalWar(user);
    await fillDisplayedFormations(user);
    await user.click(submitButton());
    await waitFor(() => {
      expect(screen.getByText(/総力戦が完了しました/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("tab", { name: "通常戦闘" }));
    expect(screen.queryByText(/総力戦が完了しました/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "総力戦" }));

    expect(screen.getByText(/総力戦が完了しました/)).toBeInTheDocument();
    expect(screen.getAllByText(/total-war-01J/).length).toBeGreaterThan(0);
  });

  it("offers only playable units for both sides", async () => {
    const user = userEvent.setup();
    renderPage();
    await openTotalWar(user);

    await user.click(within(enemySection()).getByRole("button", { name: "前衛1にユニットを追加" }));

    expect(screen.getByRole("button", { name: "アルファを選択" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "演習の敵を選択" })).not.toBeInTheDocument();
  });
});

describe("TotalWarMode — formation tabs", () => {
  it("UI-CT-165: switches the displayed formation per side by click and keyboard, without moving the other side", async () => {
    const user = userEvent.setup();
    renderPage();
    await openTotalWar(user);

    await placeUnit(user, allySection(), "前衛1にユニットを追加", "アルファ");
    await placeUnit(user, enemySection(), "前衛1にユニットを追加", "ベータ");
    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));

    expect(within(allyTabs()).getByRole("tab", { name: /編成2/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(allySection()).getByRole("button", { name: "前衛1にユニットを追加" }),
    ).toBeVisible();
    expect(
      within(enemySection()).getByRole("button", { name: /前衛1: ベータを変更/ }),
    ).toBeVisible();

    within(allyTabs()).getByRole("tab", { name: /編成2/ }).focus();
    await user.keyboard("{ArrowLeft}");

    expect(within(allyTabs()).getByRole("tab", { name: "編成1" })).toHaveFocus();
    expect(
      within(allySection()).getByRole("button", { name: /前衛1: アルファを変更/ }),
    ).toBeVisible();
    expect(within(enemyTabs()).getAllByRole("tab")).toHaveLength(1);
  });

  it("UI-CT-166: adds an empty formation tab up to 3 and removes the displayed formation, shifting later ones forward", async () => {
    const user = userEvent.setup();
    renderPage();
    await openTotalWar(user);

    await placeUnit(user, allySection(), "前衛1にユニットを追加", "アルファ");
    expect(within(allyPanel()).queryByRole("button", { name: "この編成を削除" })).toBeNull();

    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, allySection(), "前衛1にユニットを追加", "ベータ");
    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));

    expect(within(allyTabs()).getAllByRole("tab")).toHaveLength(3);
    expect(within(allyTabs()).getByRole("tab", { name: /編成3/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(allyPanel()).queryByRole("button", { name: "編成を追加" })).toBeNull();

    await user.click(within(allyTabs()).getByRole("tab", { name: /編成1/ }));
    await user.click(within(allyPanel()).getByRole("button", { name: "この編成を削除" }));

    expect(within(allyTabs()).getAllByRole("tab")).toHaveLength(2);
    expect(
      within(allySection()).getByRole("button", { name: /前衛1: ベータを変更/ }),
    ).toBeVisible();
  });
});

describe("TotalWarMode — validation", () => {
  it("UI-CT-167: flags a non-displayed formation's violations on its tab and the summary, blocking the submit until fixed", async () => {
    const user = userEvent.setup();
    renderPage();
    await openTotalWar(user);
    await fillDisplayedFormations(user);
    expect(submitButton()).toBeEnabled();

    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));
    await user.click(within(allyTabs()).getByRole("tab", { name: /編成1/ }));

    expect(within(allyTabs()).getByRole("tab", { name: "編成2 要修正" })).toBeInTheDocument();
    expect(
      screen.getByText("味方の編成2: 味方ユニットを1～5体設定してください。"),
    ).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    await user.click(within(allyTabs()).getByRole("tab", { name: "編成2 要修正" }));
    await placeUnit(user, allySection(), "前衛1にユニットを追加", "ベータ");

    expect(within(allyTabs()).getByRole("tab", { name: "編成2" })).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it("UI-CT-168: flags a second copy within one formation, but badges a reappearance in a later formation without blocking", async () => {
    const user = userEvent.setup();
    renderPage();
    await openTotalWar(user);
    await fillDisplayedFormations(user);

    await placeUnit(user, allySection(), "前衛2にユニットを追加", "アルファ");
    expect(
      within(allySection()).getByRole("button", {
        name: "前衛2: アルファを変更、入力エラーがあります",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "味方の編成1: 1つの編成に同じユニットは1体までです。別の編成へ移してください。",
      ),
    ).toBeInTheDocument();
    await user.click(within(allySection()).getByRole("button", { name: /前衛2: アルファを変更/ }));
    await user.click(screen.getByRole("button", { name: "この枠を空にする" }));

    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, allySection(), "前衛1にユニットを追加", "アルファ");

    const reappearing = within(allySection()).getByRole("button", {
      name: "前衛1: アルファを変更、再登場 −99%",
    });
    expect(submitButton()).toBeEnabled();
    await user.hover(reappearing);
    expect(screen.getByText("再登場による −99% 補正は含みません")).toBeInTheDocument();

    // 相手陣営の編成は数えない。
    expect(
      within(enemySection()).getByRole("button", { name: "前衛1: アルファを変更" }),
    ).toBeInTheDocument();
  });

  it("UI-CT-171: shows a 422 on formation 2 of the ally on that formation's slot and marks its tab", async () => {
    const user = userEvent.setup();
    const simulate = vi.fn<SimulateTotalWarFn>(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        error: {
          kind: "VALIDATION",
          code: "INVALID_COMMAND",
          message: "Invalid command.",
          violations: [{ path: "/allyFormations/1/units/0/unitDefinitionId", message: "gone" }],
        },
      }),
    );
    renderPage(simulate);
    await openTotalWar(user);
    await fillDisplayedFormations(user);
    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, allySection(), "後衛2にユニットを追加", "ベータ");
    await user.click(within(allyTabs()).getByRole("tab", { name: /編成1/ }));

    await user.click(submitButton());

    await waitFor(() => {
      expect(within(allyTabs()).getByRole("tab", { name: "編成2 要修正" })).toBeInTheDocument();
    });
    expect(
      within(allySection()).getByRole("button", { name: "前衛1: アルファを変更" }),
    ).toBeInTheDocument();

    await user.click(within(allyTabs()).getByRole("tab", { name: "編成2 要修正" }));
    expect(
      within(allySection()).getByRole("button", {
        name: "後衛2: ベータを変更、入力エラーがあります",
      }),
    ).toBeInTheDocument();
  });
});

describe("TotalWarMode — enhancement", () => {
  it("UI-CT-169: shares side enhancement across formations, keeps enemy unit enhancement per formation, and shares ally unit enhancement", async () => {
    const user = userEvent.setup();
    const simulate = succeedingSimulate();
    renderPage(simulate);
    await openTotalWar(user);
    await fillDisplayedFormations(user);

    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, allySection(), "前衛1にユニットを追加", "アルファ");
    await user.click(within(enemyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, enemySection(), "前衛1にユニットを追加", "アルファ");
    await user.click(within(enemyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, enemySection(), "前衛1にユニットを追加", "ベータ");

    // 敵の編成2のタブで学園レベルを変える。
    await user.click(within(enemyTabs()).getByRole("tab", { name: /編成2/ }));
    await user.click(within(enemySection()).getByRole("checkbox", { name: /強化/ }));
    const physical = within(enemySection()).getByLabelText("物理");
    await user.clear(physical);
    await user.type(physical, "40");

    // 敵の編成2のアルファだけレベルを変える。
    await user.click(
      within(enemySection()).getByRole("button", { name: /前衛1: アルファの強化を編集/ }),
    );
    const enemyLevel = screen.getByLabelText("現在レベル");
    await user.clear(enemyLevel);
    await user.type(enemyLevel, "150");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    // 味方の編成2のアルファのレベルを変える（手持ちデータ）。
    await user.click(within(allySection()).getByRole("checkbox", { name: /強化/ }));
    await user.click(
      within(allySection()).getByRole("button", { name: /前衛1: アルファの強化を編集/ }),
    );
    const allyLevel = screen.getByLabelText("現在レベル");
    await user.clear(allyLevel);
    await user.type(allyLevel, "180");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    await user.click(submitButton());

    const [request] = simulate.mock.calls[0]!;
    expect(request.enemyFormations).toHaveLength(3);
    for (const formation of request.enemyFormations) {
      expect(formation.enhancement?.academyLevels?.unitTypes?.["PHYSICAL"]).toBe(40);
    }
    expect(request.enemyFormations[0]?.units[0]?.enhancement?.level).not.toBe(150);
    expect(request.enemyFormations[1]?.units[0]?.enhancement?.level).toBe(150);
    expect(
      request.allyFormations.map((formation) => formation.units[0]?.enhancement?.level),
    ).toEqual([180, 180]);
    expect(localStorage.getItem("mlgg:player-data")).toContain("180");
  });
});

describe("TotalWarMode — execution", () => {
  it("UI-CT-170: shows only the log level with a fixed 15 turns, and sends one FormationRequest per formation without turnLimit", async () => {
    const user = userEvent.setup();
    const { simulateTotalWarImpl } = renderPage();
    await openTotalWar(user);

    expect(screen.queryByLabelText(/ターン上限/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("実行モード")).not.toBeInTheDocument();
    expect(screen.getByText("15ターン固定")).toBeInTheDocument();
    expect(screen.getByText("POST /api/v1/total-war-simulations")).toBeInTheDocument();

    await fillDisplayedFormations(user);
    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, allySection(), "前衛1にユニットを追加", "ベータ");
    await user.selectOptions(screen.getByLabelText("ログレベル"), "DETAILED");

    await user.click(submitButton());

    expect(simulateTotalWarImpl).toHaveBeenCalledTimes(1);
    const [request, options] = simulateTotalWarImpl.mock.calls[0]!;
    expect(request).not.toHaveProperty("turnLimit");
    expect(request.options).toEqual({ logLevel: "DETAILED" });
    expect(request.allyFormations.map((f) => f.units.map((u) => u.unitDefinitionId))).toEqual([
      ["UNIT_A"],
      ["UNIT_B"],
    ]);
    expect(request.enemyFormations).toHaveLength(1);
    expect(options.baseUrl).toBe("https://api.example.com");
  });

  it("cancels an in-flight run and marks a shown result stale after the draft changes", async () => {
    const user = userEvent.setup();
    let resolveSecond: ((result: TotalWarApiResult) => void) | undefined;
    const simulate = vi
      .fn<SimulateTotalWarFn>()
      .mockResolvedValueOnce({ ok: true, response: totalWarResponse() })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    renderPage(simulate);
    await openTotalWar(user);
    await fillDisplayedFormations(user);
    await user.click(submitButton());
    await waitFor(() => {
      expect(screen.getByText(/総力戦が完了しました/)).toBeInTheDocument();
    });

    await placeUnit(user, allySection(), "前衛2にユニットを追加", "ベータ");
    expect(screen.getByText("この結果は変更前の条件です。")).toBeInTheDocument();

    await user.click(submitButton());
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(screen.getByText("キャンセルを要求しました。")).toBeInTheDocument();
    resolveSecond?.({ ok: true, response: totalWarResponse() });
  });

  it("requests the stat preview for the displayed ally and enemy formations", async () => {
    const user = userEvent.setup();
    const previewImpl = vi.fn<
      (
        request: FormationStatPreviewRequest,
        options: SimulateOptions,
      ) => Promise<FormationStatPreviewApiResult>
    >(() =>
      Promise.resolve({ ok: false, error: { kind: "NETWORK", message: "x", retryable: true } }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateTotalWarImpl={succeedingSimulate()}
        previewFormationStatsImpl={previewImpl}
      />,
    );
    await openTotalWar(user);
    await fillDisplayedFormations(user, "アルファ", "アルファ");
    await user.click(within(enemyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, enemySection(), "後衛3にユニットを追加", "ベータ");

    await waitFor(() => {
      const [request] = previewImpl.mock.calls.at(-1)!;
      // 既定の`NORMAL`は送らない（旧APIとの互換。`buildFormationStatPreviewRequest`）。
      expect(request).not.toHaveProperty("mode");
      expect(request.allyFormation.units.map((u) => u.unitDefinitionId)).toEqual(["UNIT_A"]);
      expect(request.enemyFormation.units.map((u) => u.unitDefinitionId)).toEqual(["UNIT_B"]);
    });
  });
});

describe("TotalWarMode — persistence", () => {
  it("UI-CT-175: restores the total war draft on remount with formation 1 open, apart from the other modes' drafts", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await openTotalWar(user);
    await fillDisplayedFormations(user, "アルファ", "ベータ");
    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));
    await placeUnit(user, allySection(), "前衛1にユニットを追加", "ベータ");
    unmount();

    renderPage();
    await openTotalWar(user);

    expect(within(allyTabs()).getAllByRole("tab")).toHaveLength(2);
    expect(within(allyTabs()).getByRole("tab", { name: "編成1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(allySection()).getByRole("button", { name: /前衛1: アルファを変更/ }),
    ).toBeInTheDocument();
    expect(
      within(enemySection()).getByRole("button", { name: /前衛1: ベータを変更/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "通常戦闘" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });
    expect(
      within(allySection()).getByRole("button", { name: "前衛1にユニットを追加" }),
    ).toBeInTheDocument();
  });

  it("resets only the total war draft to one empty formation per side", async () => {
    const user = userEvent.setup();
    renderPage();
    await openTotalWar(user);
    await fillDisplayedFormations(user);
    await user.click(within(allyPanel()).getByRole("button", { name: "編成を追加" }));

    await user.click(screen.getByRole("button", { name: "編成をクリア" }));

    expect(within(allyTabs()).getAllByRole("tab")).toHaveLength(1);
    expect(
      within(allySection()).getByRole("button", { name: "前衛1にユニットを追加" }),
    ).toBeInTheDocument();
  });
});
