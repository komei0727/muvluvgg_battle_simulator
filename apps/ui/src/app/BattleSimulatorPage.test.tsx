import {
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulateOptions } from "../features/simulation/api-client.js";
import type { GetCatalogOptions } from "../features/simulation/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  CatalogApiResult,
  FormationStatPreviewApiResult,
  SimulationApiResult,
} from "../features/simulation/api-contract.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";
import type {
  BattleSimulationRequest,
  FormationStatPreviewRequest,
} from "../features/formation/request-mapper.js";

// The real definition-image-map.ts globs locally-synced, gitignored assets
// (apps/ui/scripts/sync-character-images.mjs) that are absent in CI. Mock it
// with a fixed map so the top-level imageMap wiring itself can be asserted
// deterministically, independent of what's synced on the machine running
// this test.
vi.mock("../features/catalog-selection/definition-image-map.js", () => ({
  unitImageMap: { UNIT_A: "/assets/unit-a.webp" },
  memoryImageMap: {},
  definitionImageMap: { UNIT_A: "/assets/unit-a.webp" },
}));

// 編成ステータスプレビューはpage自身が編成の変化に反応して取りに行くため、
// `previewFormationStatsImpl`を渡さないテストでも呼ばれる。実fetchへ出さない
// よう、既定ではnetwork失敗にしておく（プレビュー失敗は他の表示を変えない）。
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 既定モードは戦術演習（`UI-AC-018`）。この fileは通常戦闘モードの挙動だけを見るため、
 * render直後に通常戦闘タブへ切り替える。モードタブはCatalogの取得状態に関わらず
 * 描画されるので、Catalog未取得の状態を見るtestからも同じように呼べる。
 */
function render(ui: ReactElement) {
  const result = renderComponent(ui);
  fireEvent.click(screen.getByRole("tab", { name: "通常戦闘" }));
  return result;
}

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
        unitDefinitionId: "UNIT_LOCKED",
        displayName: "ロック",
        characterName: "Locked",
        attribute: "SMART",
        unitType: "ATTACKER",
        role: "TANK",
        positionAptitudes: ["FRONT"],
      },
    ],
    memories: [],
  };
}

function readyGetCatalogImpl() {
  return vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
    Promise.resolve({ ok: true, response: catalogResponse() }),
  );
}

describe("BattleSimulatorPage — build revision", () => {
  it("passes the buildRevision prop through to the AppShell footer", () => {
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        buildRevision="deadbeef"
      />,
    );

    expect(screen.getByRole("contentinfo")).toHaveTextContent("deadbeef");
  });
});

describe("BattleSimulatorPage — catalog loading", () => {
  it("shows a loading indication and keeps formation slots disabled while the catalog is loading", () => {
    const getCatalogImpl = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(
      () => new Promise(() => {}),
    );
    render(
      <BattleSimulatorPage apiBaseUrl="https://api.example.com" getCatalogImpl={getCatalogImpl} />,
    );

    expect(screen.getByText(/読込中/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(0);
  });

  it("shows a manual reload action when the catalog fails, and disables formation editing", async () => {
    const getCatalogImpl = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
      Promise.resolve({ ok: false, error: { kind: "SERVER", message: "boom" } }),
    );
    render(
      <BattleSimulatorPage apiBaseUrl="https://api.example.com" getCatalogImpl={getCatalogImpl} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /再読込/ })).toBeInTheDocument();
    });
    expect(screen.queryAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(0);
  });

  it("retries via getCatalogImpl when the reload button is activated", async () => {
    const user = userEvent.setup();
    const getCatalogImpl = vi
      .fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>()
      .mockResolvedValueOnce({ ok: false, error: { kind: "SERVER", message: "boom" } })
      .mockResolvedValueOnce({ ok: true, response: catalogResponse() });
    render(
      <BattleSimulatorPage apiBaseUrl="https://api.example.com" getCatalogImpl={getCatalogImpl} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /再読込/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /再読込/ }));

    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });
  });
});

describe("BattleSimulatorPage — formation editing once the catalog is ready", () => {
  it("renders both formation editors and an initial validation error for empty formations", async () => {
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: /ENEMY FORMATION/ })).toBeInTheDocument();
    expect(screen.getByText("味方ユニットを1～5体設定してください。")).toBeInTheDocument();
    expect(screen.getByText("敵ユニットを1～5体設定してください。")).toBeInTheDocument();
  });

  it("opens the unit selection dialog from an empty slot, focused on the search input (UI-CT-003)", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });

    await user.click(screen.getAllByRole("button", { name: "前衛1にユニットを追加" })[0]!);

    expect(screen.getByRole("dialog", { name: "ユニットを選択" })).toBeInTheDocument();
    expect(screen.getByLabelText("ユニットを検索")).toHaveFocus();
  });

  it("selects a unit into the slot, closes the dialog, and returns focus to the slot (UI-CT-004)", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });

    const slotButton = screen.getAllByRole("button", { name: "前衛1にユニットを追加" })[0]!;
    await user.click(slotButton);
    await user.click(screen.getByRole("button", { name: "アルファを選択" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /前衛1: アルファを変更/ })).toHaveFocus();
  });

  it("renders the mapped image for a unit once selected into a formation slot", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });

    await user.click(screen.getAllByRole("button", { name: "前衛1にユニットを追加" })[0]!);
    await user.click(screen.getByRole("button", { name: "アルファを選択" }));

    const images = screen.getAllByRole("img", { name: "アルファ" });
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.tagName).toBe("IMG");
      expect(image.getAttribute("src")).toBe("/assets/unit-a.webp");
    }
  });

  it("blocks a 6th ally unit selection with a capacity notice instead of a state change (UI-CT-007)", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });

    const emptySlotLabels = [
      "前衛1にユニットを追加",
      "前衛2にユニットを追加",
      "前衛3にユニットを追加",
      "後衛1にユニットを追加",
      "後衛2にユニットを追加",
    ];
    for (const label of emptySlotLabels) {
      await user.click(screen.getAllByRole("button", { name: label })[0]!);
      await user.click(screen.getByRole("button", { name: "アルファを選択" }));
    }

    await user.click(screen.getAllByRole("button", { name: "後衛3にユニットを追加" })[0]!);

    expect(screen.getByText("1陣営に設定できるユニットは5体までです。")).toBeInTheDocument();
  });
});

function simulationResponse(): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-01J",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: [] },
    finalState: { units: [] },
    unitSummaries: [],
    events: [],
    stateTransitions: [],
  };
}

async function setUpMinimalFormation(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
  });
  await user.click(screen.getAllByRole("button", { name: "前衛1にユニットを追加" })[0]!);
  await user.click(screen.getByRole("button", { name: "アルファを選択" }));
  await user.click(screen.getByRole("button", { name: "前衛1にユニットを追加" }));
  await user.click(screen.getByRole("button", { name: "アルファを選択" }));
}

describe("BattleSimulatorPage — battle execution (UI-UC-002)", () => {
  it("submits the built request and shows the success feedback", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: simulationResponse() }));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    expect(simulateImpl).toHaveBeenCalledTimes(1);
    const [sentRequest, options] = simulateImpl.mock.calls[0]!;
    expect(sentRequest.allyFormation.units).toEqual([
      { unitDefinitionId: "UNIT_A", position: { column: 0, row: "FRONT" } },
    ]);
    expect(options.baseUrl).toBe("https://api.example.com");

    await waitFor(() => {
      expect(screen.getByText(/戦闘が完了しました/)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/battle-01J/).length).toBeGreaterThan(0);
  });

  it("shows a failed execution instead of a fabricated success when the response fails contract validation (finalState/roster contract mismatch)", async () => {
    // validateSimulationResponse (response-validator.ts) rejects a 200 body
    // whose finalState is missing a battleUnitId present in initialState
    // before the reducer ever reaches "succeeded" (simulation-response-
    // validator.test.ts covers that rule directly). This test guards the
    // page-level consequence: such a failure must not show a completed
    // battle summary or details section.
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: false,
        error: {
          kind: "RESPONSE_CONTRACT_MISMATCH",
          message:
            "Simulation response finalState is missing a battleUnitId present in initialState.",
        },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    await waitFor(() => {
      expect(screen.getByText("レスポンスの形式が想定と異なります。")).toBeInTheDocument();
    });
    expect(screen.queryByText(/戦闘が完了しました/)).not.toBeInTheDocument();
    expect(screen.queryByText("ALLY UNIT SUMMARY")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "時系列イベント" })).not.toBeInTheDocument();
  });

  it("disables the start button while submitting and shows a cancel button", async () => {
    const user = userEvent.setup();
    let resolveSimulate!: (result: SimulationApiResult) => void;
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(
      () =>
        new Promise((resolve) => {
          resolveSimulate = resolve;
        }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    expect(screen.getByRole("button", { name: "実行中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();

    resolveSimulate({ ok: true, response: simulationResponse() });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "戦闘を開始" })).toBeInTheDocument();
    });
  });

  it("shows a structured error with code and requestId on failure, keeping the request unretried", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        requestId: "srv-req-err",
        error: { kind: "CAPACITY", message: "Server busy.", code: "CAPACITY_EXCEEDED" },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    await waitFor(() => {
      expect(screen.getByText(/Server busy\./)).toBeInTheDocument();
    });
    expect(screen.getByText(/CAPACITY_EXCEEDED/)).toBeInTheDocument();
    expect(screen.getByText(/srv-req-err/)).toBeInTheDocument();
    expect(simulateImpl).toHaveBeenCalledTimes(1);
  });

  it("prompts and performs a catalog reload on a DEFINITION_NOT_FOUND failure (UI-API-004)", async () => {
    const user = userEvent.setup();
    const getCatalogImpl = vi
      .fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>()
      .mockResolvedValue({ ok: true, response: catalogResponse() });
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        error: {
          kind: "VALIDATION",
          code: "DEFINITION_NOT_FOUND",
          message: "Definition not found.",
          violations: [{ path: "/allyFormation/units/0/unitDefinitionId", message: "gone" }],
        },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={getCatalogImpl}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Catalogを再読込/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Catalogを再読込/ }));

    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });
  });

  it("blocks the result panels and prompts a catalog reload when the response ran against a different catalog revision (Issue #96 P1)", async () => {
    const user = userEvent.setup();
    const getCatalogImpl = vi
      .fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>()
      .mockResolvedValue({ ok: true, response: catalogResponse() });
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: true,
        response: { ...simulationResponse(), catalogRevision: "rev-2" },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={getCatalogImpl}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    await waitFor(() => {
      expect(screen.getByText(/Catalogが更新されたため/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/battle-01J/)).not.toBeInTheDocument();
    expect(screen.queryByText("ALLY UNIT SUMMARY")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "時系列イベント" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Catalogを再読込/ }));
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps the stale mismatched result hidden while the reload it triggered is still pending (PR review: leaving catalog.status !== "ready" must not un-block display)', async () => {
    const user = userEvent.setup();
    let resolveSecondCatalogGet!: (result: CatalogApiResult) => void;
    const getCatalogImpl = vi
      .fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>()
      .mockResolvedValueOnce({ ok: true, response: catalogResponse() })
      .mockImplementationOnce(
        () =>
          new Promise<CatalogApiResult>((resolve) => {
            resolveSecondCatalogGet = resolve;
          }),
      );
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: true,
        response: { ...simulationResponse(), catalogRevision: "rev-2" },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={getCatalogImpl}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);
    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));
    await waitFor(() => {
      expect(screen.getByText(/Catalogが更新されたため/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Catalogを再読込/ }));
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });

    // The second GET is still in flight (catalog.status === "loading"), so the
    // revision cannot yet be confirmed to match. The stale result must stay
    // hidden rather than reappearing just because status left "ready".
    expect(screen.queryByText(/battle-01J/)).not.toBeInTheDocument();
    expect(screen.queryByText("ALLY UNIT SUMMARY")).not.toBeInTheDocument();
    expect(screen.getByText(/Catalogが更新されたため/)).toBeInTheDocument();

    resolveSecondCatalogGet({ ok: true, response: catalogResponse() });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });
    // Reloaded catalog is still "rev-1" while the stale result ran against
    // "rev-2": still mismatched, still hidden.
    expect(screen.queryByText(/battle-01J/)).not.toBeInTheDocument();
  });

  it("keeps the stale mismatched result hidden after the reload it triggered fails (PR review)", async () => {
    const user = userEvent.setup();
    const getCatalogImpl = vi
      .fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>()
      .mockResolvedValueOnce({ ok: true, response: catalogResponse() })
      .mockResolvedValueOnce({ ok: false, error: { kind: "SERVER", message: "boom" } });
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: true,
        response: { ...simulationResponse(), catalogRevision: "rev-2" },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={getCatalogImpl}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);
    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));
    await waitFor(() => {
      expect(screen.getByText(/Catalogが更新されたため/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Catalogを再読込/ }));
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });

    // The reload failed (catalog.status === "failed"), so the revision is
    // still unconfirmed. The stale result must stay hidden.
    expect(screen.queryByText(/battle-01J/)).not.toBeInTheDocument();
    expect(screen.queryByText("ALLY UNIT SUMMARY")).not.toBeInTheDocument();
  });

  it("cancels an in-flight submission via the cancel button", async () => {
    const user = userEvent.setup();
    let capturedSignal: AbortSignal | undefined;
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >((_req, options) => {
      capturedSignal = options.signal;
      return new Promise<SimulationApiResult>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }).catch(() => ({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } }));
    });
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    // cancel() transitions to cancelled synchronously (P1): no waitFor needed,
    // and this also proves a subsequently-arriving CANCELLED result is a no-op.
    expect(capturedSignal?.aborted).toBe(true);
    expect(screen.getByText(/キャンセルを要求しました/)).toBeInTheDocument();
  });
});

describe("BattleSimulatorPage — 強化指定 (M11, UI-AC-023〜026)", () => {
  async function submitWith(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));
  }

  it("UI-CT-033: a submit with the enhancement toggle off (default) sends no enhancement property at all", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: simulationResponse() }));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await submitWith(user);

    const [sentRequest] = simulateImpl.mock.calls[0]!;
    expect(sentRequest.allyFormation).not.toHaveProperty("enhancement");
    expect(sentRequest.enemyFormation).not.toHaveProperty("enhancement");
    expect(sentRequest.allyFormation.units[0]).not.toHaveProperty("enhancement");
    expect(JSON.stringify(sentRequest)).not.toContain("enhancement");
  });

  it("UI-CT-034: turning the toggle on sends the nine academy levels, and a blank level blocks the submit with a field error", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: simulationResponse() }));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    const allyToggle = screen.getAllByRole("checkbox", { name: /強化/ })[0]!;
    await user.click(allyToggle);
    const physical = screen.getAllByLabelText("物理")[0]!;
    await user.clear(physical);

    expect(screen.getByRole("button", { name: "戦闘を開始" })).toBeDisabled();
    expect(
      screen.getAllByText("学園レベルは1以上の整数で入力してください。").length,
    ).toBeGreaterThan(0);

    await user.type(physical, "50");
    await submitWith(user);

    const [sentRequest] = simulateImpl.mock.calls[0]!;
    expect(sentRequest.allyFormation.enhancement).toEqual({
      academyLevels: {
        unitTypes: { PHYSICAL: 50, ENERGY: 1, AGILE: 1 },
        attributes: { AGGRESSIVE: 1, SHY: 1, CUTE: 1, SMART: 1, COMICAL: 1, CLEVER: 1 },
      },
    });
    expect(sentRequest.enemyFormation).not.toHaveProperty("enhancement");
  });

  it("UI-CT-036: the unit enhancement dialog stays closed while the side's toggle is off, and the screen says to turn it on", async () => {
    const user = userEvent.setup();
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
    await setUpMinimalFormation(user);

    const enhancementButton = screen.getAllByRole("button", { name: /の強化を編集/ })[0]!;
    expect(enhancementButton).toBeDisabled();
    await user.click(enhancementButton);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("強化をONにすると、ユニットごとのレベル・ギアを編集できます。").length,
    ).toBeGreaterThan(0);
  });

  it("UI-CT-035: with the toggle on, the dialog edits the level and a gear, and the submit carries them", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: simulationResponse() }));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getAllByRole("checkbox", { name: /強化/ })[0]!);
    await user.click(screen.getAllByRole("button", { name: /の強化を編集/ })[0]!);

    const level = screen.getByLabelText("現在レベル");
    await user.clear(level);
    await user.type(level, "220");
    await user.selectOptions(screen.getByLabelText("ギア3 の対象ステータス"), "ATTACK");
    await user.selectOptions(screen.getByLabelText("ギア3 の種別"), "III");
    await user.selectOptions(screen.getByLabelText("ギア3 のランク"), "S");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    await submitWith(user);

    const [sentRequest] = simulateImpl.mock.calls[0]!;
    expect(sentRequest.allyFormation.units[0]?.enhancement).toEqual({
      level: 220,
      gears: [{ stat: "ATTACK", tier: "III", grade: "S" }],
    });
  });

  it("UI-CT-037: a 422 violation under enhancement is shown on the input it came from", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        error: {
          kind: "VALIDATION",
          code: "INVALID_COMMAND",
          message: "リクエストに不備があります。",
          violations: [
            {
              path: "/allyFormation/units/0/enhancement/level",
              message: 'must be 200 because "UNIT_A" declares no levelGrowth, got 220',
            },
            {
              path: "/allyFormation/enhancement/academyLevels/unitTypes/PHYSICAL",
              message: "must be an integer of at least 1, got 0",
            },
          ],
        },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getAllByRole("checkbox", { name: /強化/ })[0]!);
    await user.click(screen.getAllByRole("button", { name: /の強化を編集/ })[0]!);
    const level = screen.getByLabelText("現在レベル");
    await user.clear(level);
    await user.type(level, "220");
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    await submitWith(user);

    await waitFor(() => {
      expect(screen.getAllByLabelText("物理")[0]).toHaveAttribute("aria-invalid", "true");
    });

    // 成長値を持たないユニットのレベル違反はダイアログ内の該当入力へ表示する。
    await user.click(screen.getAllByRole("button", { name: /の強化を編集/ })[0]!);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("現在レベル")).toHaveAttribute("aria-invalid", "true");
    expect(dialog.getByText(/declares no levelGrowth/)).toBeInTheDocument();
  });

  it("UI-CT-033/UI-CMP-014: turning the toggle back off after editing a unit level keeps the submit available and sends no enhancement", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: simulationResponse() }));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    const allyToggle = screen.getAllByRole("checkbox", { name: /強化/ })[0]!;
    await user.click(allyToggle);
    await user.click(screen.getAllByRole("button", { name: /の強化を編集/ })[0]!);
    const level = screen.getByLabelText("現在レベル");
    await user.clear(level);
    await user.type(level, "220");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    // draftへ残ったLv220は、トグルOFFでは送信対象から外れるだけで送信を妨げない。
    await user.click(allyToggle);

    expect(
      screen.queryByText("ユニット強化は陣営の強化をONにしてから設定してください。"),
    ).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "戦闘を開始" });
    expect(submit).toBeEnabled();
    await user.click(submit);

    const [sentRequest] = simulateImpl.mock.calls[0]!;
    expect(JSON.stringify(sentRequest)).not.toContain("enhancement");
  });
});

describe("BattleSimulatorPage — 編成ステータスプレビュー (UI-AC-027)", () => {
  function previewUnit(side: string, maximumHp: number) {
    return {
      side,
      unitDefinitionId: "UNIT_A",
      formationPosition: { column: 0, row: "FRONT" },
      maximumHp,
      combatStats: {
        attack: 100,
        defense: 50,
        criticalRate: 12.5,
        actionSpeed: 12,
        affinityBonus: 25,
        criticalDamageBonus: 50,
      },
    };
  }

  /**
   * 応答は要求された枠数と同じ件数を返す（UI側の対応づけは並び順のため）。
   * 味方の最大HPは強化指定の有無で変え、「強化を変えると表示が追随する」ことを
   * 呼び出し回数に依存せず観測できるようにする。
   */
  function previewImplFor(allyEnhancedMaximumHp: number, allyPlainMaximumHp: number) {
    return vi.fn<
      (
        request: FormationStatPreviewRequest,
        options: SimulateOptions,
      ) => Promise<FormationStatPreviewApiResult>
    >((request) =>
      Promise.resolve({
        ok: true,
        response: {
          schemaVersion: 1,
          catalogRevision: "rev-1",
          units: [
            ...request.allyFormation.units.map(() =>
              previewUnit(
                "ALLY",
                request.allyFormation.enhancement === undefined
                  ? allyPlainMaximumHp
                  : allyEnhancedMaximumHp,
              ),
            ),
            ...request.enemyFormation.units.map(() => previewUnit("ENEMY", 999)),
          ],
        },
      }),
    );
  }

  function allyRegion() {
    return screen.getByRole("region", { name: /ALLY FORMATION/ });
  }

  it("UI-CT-039: refetches the preview when the enhancement changes, and the hovered slot shows the new values", async () => {
    const user = userEvent.setup();
    const previewFormationStatsImpl = previewImplFor(2500, 1000);
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        previewFormationStatsImpl={previewFormationStatsImpl}
      />,
    );

    await setUpMinimalFormation(user);
    await waitFor(() => {
      expect(previewFormationStatsImpl).toHaveBeenCalled();
    });
    // 強化トグルOFFの陣営は強化なしの値を見ている。
    const [firstRequest] = previewFormationStatsImpl.mock.calls[0]!;
    expect(JSON.stringify(firstRequest)).not.toContain("enhancement");

    const allySlot = within(allyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ });
    await user.hover(allySlot);
    await waitFor(() => {
      expect(within(allyRegion()).getByText("1,000")).toBeInTheDocument();
    });
    await user.unhover(allySlot);

    const callsBeforeToggle = previewFormationStatsImpl.mock.calls.length;
    await user.click(within(allyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));

    await waitFor(() => {
      expect(previewFormationStatsImpl.mock.calls.length).toBeGreaterThan(callsBeforeToggle);
    });
    const [lastRequest] = previewFormationStatsImpl.mock.calls.at(-1)!;
    expect(lastRequest.allyFormation.enhancement).toBeDefined();
    expect(lastRequest.enemyFormation.enhancement).toBeUndefined();

    await user.hover(within(allyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ }));
    await waitFor(() => {
      expect(within(allyRegion()).getByText("2,500")).toBeInTheDocument();
    });
  });

  it("UI-CT-040: keeps the battle submittable when the preview request fails", async () => {
    const user = userEvent.setup();
    const previewFormationStatsImpl = vi.fn<
      (
        request: FormationStatPreviewRequest,
        options: SimulateOptions,
      ) => Promise<FormationStatPreviewApiResult>
    >(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        error: { kind: "SERVER", message: "boom" },
      }),
    );
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        previewFormationStatsImpl={previewFormationStatsImpl}
      />,
    );

    await setUpMinimalFormation(user);
    await waitFor(() => {
      expect(previewFormationStatsImpl).toHaveBeenCalled();
    });

    expect(screen.getByRole("button", { name: "戦闘を開始" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.hover(within(allyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ }));
    expect(within(allyRegion()).getByText("ステータスを取得できませんでした")).toBeInTheDocument();
  });
});

// 01_UI要求・画面設計.md §5.9 / UI-AC-029〜031.
describe("BattleSimulatorPage — input persistence", () => {
  function allyRegion() {
    return screen.getByRole("region", { name: /ALLY FORMATION/ });
  }

  function enemyRegion() {
    return screen.getByRole("region", { name: /ENEMY FORMATION/ });
  }

  function renderPage() {
    return render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
      />,
    );
  }

  async function waitForCatalog() {
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });
  }

  async function placeUnit(
    user: ReturnType<typeof userEvent.setup>,
    region: HTMLElement,
    slotName: string,
  ) {
    await user.click(within(region).getByRole("button", { name: slotName }));
    await user.click(screen.getByRole("button", { name: "アルファを選択" }));
  }

  async function openAllyEnhancementDialog(
    user: ReturnType<typeof userEvent.setup>,
    slotName: RegExp,
  ) {
    await user.click(within(allyRegion()).getByRole("button", { name: slotName }));
  }

  it("UI-CT-044: restores the previous session's formation, memories and turn limit after a remount", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await waitForCatalog();
    await placeUnit(user, allyRegion(), "前衛1にユニットを追加");
    await placeUnit(user, enemyRegion(), "後衛3にユニットを追加");
    const turnLimit = screen.getByLabelText(/ターン上限/);
    await user.clear(turnLimit);
    await user.type(turnLimit, "42");
    first.unmount();

    renderPage();
    await waitForCatalog();

    expect(
      within(allyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ }),
    ).toBeInTheDocument();
    expect(
      within(enemyRegion()).getByRole("button", { name: /後衛3: アルファを変更/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/ターン上限/)).toHaveValue(42);
  });

  it("UI-CT-045: clears only the slots whose definitions left the catalog", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await waitForCatalog();
    await placeUnit(user, allyRegion(), "前衛1にユニットを追加");
    await user.click(within(allyRegion()).getByRole("button", { name: "前衛2にユニットを追加" }));
    await user.click(screen.getByRole("button", { name: "ロックを選択" }));
    first.unmount();

    // "UNIT_LOCKED" だけがCatalogから消えた版で起動し直す。
    const shrunkCatalog = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
      Promise.resolve({
        ok: true,
        response: {
          ...catalogResponse(),
          catalogRevision: "rev-2",
          units: catalogResponse().units.filter((unit) => unit.unitDefinitionId === "UNIT_A"),
        },
      }),
    );
    render(
      <BattleSimulatorPage apiBaseUrl="https://api.example.com" getCatalogImpl={shrunkCatalog} />,
    );
    await waitForCatalog();

    expect(
      within(allyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(allyRegion()).getByRole("button", { name: "前衛2にユニットを追加" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Catalogに存在しない定義です。選択し直してください。")).toBeNull();
  });

  it("UI-CT-046: prefills a re-placed ally unit from the saved growth data, and never prefills the enemy side", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await user.click(within(allyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));
    await user.click(within(enemyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));
    await placeUnit(user, allyRegion(), "前衛1にユニットを追加");
    await openAllyEnhancementDialog(user, /前衛1: アルファの強化を編集/);
    const level = screen.getByLabelText("現在レベル");
    await user.clear(level);
    await user.type(level, "220");
    await user.selectOptions(screen.getByLabelText("ギア1 の対象ステータス"), "ATTACK");
    await user.selectOptions(screen.getByLabelText("ギア1 の種別"), "III");
    await user.selectOptions(screen.getByLabelText("ギア1 のランク"), "S");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    // 枠から外して別の枠へ置き直す（配置の入れ替え相当）。
    await user.click(within(allyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ }));
    await user.click(screen.getByRole("button", { name: "この枠を空にする" }));
    await placeUnit(user, allyRegion(), "後衛1にユニットを追加");
    await openAllyEnhancementDialog(user, /後衛1: アルファの強化を編集/);

    expect(screen.getByLabelText("現在レベル")).toHaveValue(220);
    expect(screen.getByLabelText("ギア1 の対象ステータス")).toHaveValue("ATTACK");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    await placeUnit(user, enemyRegion(), "前衛1にユニットを追加");
    await user.click(
      within(enemyRegion()).getByRole("button", { name: /前衛1: アルファの強化を編集/ }),
    );

    expect(screen.getByLabelText("現在レベル")).toHaveValue(200);
    expect(screen.getByLabelText("ギア1 の対象ステータス")).toHaveValue("");
  });

  it("UI-CT-049: keeps the edited growth data when the same unit occupies another ally slot", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await user.click(within(allyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));
    // 同じユニット定義を2枠へ配置する（01_UI要求・画面設計.md §5.1）。
    await placeUnit(user, allyRegion(), "前衛1にユニットを追加");
    await placeUnit(user, allyRegion(), "後衛3にユニットを追加");

    // 前方の枠だけを編集する。後方の枠は既定値のまま残る。
    await openAllyEnhancementDialog(user, /前衛1: アルファの強化を編集/);
    const level = screen.getByLabelText("現在レベル");
    await user.clear(level);
    await user.type(level, "220");
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    // 別の入力を動かして保存を1回走らせる。
    const turnLimit = screen.getByLabelText(/ターン上限/);
    await user.clear(turnLimit);
    await user.type(turnLimit, "11");

    // 編集した値が未編集の同一ユニット枠に潰されていない。
    await placeUnit(user, allyRegion(), "後衛1にユニットを追加");
    await openAllyEnhancementDialog(user, /後衛1: アルファの強化を編集/);

    expect(screen.getByLabelText("現在レベル")).toHaveValue(220);
  });

  it("keeps the saved growth data when the edited slot is swapped with an unedited one (UI-CT-049 × unitMoved)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await user.click(within(allyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));
    // 同じユニット定義を2枠へ配置し、前衛1だけを編集して保存値を250にする。
    await placeUnit(user, allyRegion(), "前衛1にユニットを追加");
    await placeUnit(user, allyRegion(), "後衛3にユニットを追加");
    await openAllyEnhancementDialog(user, /前衛1: アルファの強化を編集/);
    const level = screen.getByLabelText("現在レベル");
    await user.clear(level);
    await user.type(level, "250");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    // 編集済み枠（前衛1）と未編集枠（後衛3・既定値200）をキーボード移動で
    // 入れ替える。移動で前衛1へ移ってきた未編集の値が保存対象になってはならない。
    await user.click(within(allyRegion()).getByRole("button", { name: "前衛1: アルファを移動" }));
    await user.click(within(allyRegion()).getByRole("button", { name: /後衛3: アルファを変更/ }));
    // 別の入力を動かして保存をもう1回走らせる。
    const turnLimit = screen.getByLabelText(/ターン上限/);
    await user.clear(turnLimit);
    await user.type(turnLimit, "12");

    // 入れ替え後も保存済みの250が残り、新しい配置へプリフィルされる。
    await placeUnit(user, allyRegion(), "後衛1にユニットを追加");
    await openAllyEnhancementDialog(user, /後衛1: アルファの強化を編集/);

    expect(screen.getByLabelText("現在レベル")).toHaveValue(250);
  });

  it("UI-CT-047: keeps working when every localStorage write fails", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("exceeded", "QuotaExceededError");
    });
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: simulationResponse() }));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={readyGetCatalogImpl()}
        simulateImpl={simulateImpl}
      />,
    );
    await setUpMinimalFormation(user);

    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    expect(simulateImpl).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText(/戦闘が完了しました/)).toBeInTheDocument();
    });
    setItem.mockRestore();
  });

  it("UI-AC-031: falls back to an empty formation when the stored draft is corrupt", async () => {
    window.localStorage.setItem("mlgg:last-draft", "{not json");
    renderPage();
    await waitForCatalog();

    expect(
      within(allyRegion()).getByRole("button", { name: "前衛1にユニットを追加" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/ターン上限/)).toHaveValue(10);
  });

  it("UI-AC-031: ignores a stored draft written by a different schema version", async () => {
    window.localStorage.setItem(
      "mlgg:last-draft",
      JSON.stringify({ schemaVersion: 0, draft: { turnLimit: 77 } }),
    );
    renderPage();
    await waitForCatalog();

    expect(screen.getByLabelText(/ターン上限/)).toHaveValue(10);
  });

  it("prefills the ally academy levels from the saved growth data after clearing the formation", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await user.click(within(allyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));
    const physical = within(allyRegion()).getByLabelText("物理");
    await user.clear(physical);
    await user.type(physical, "50");

    await user.click(screen.getByRole("button", { name: "編成をクリア" }));

    expect(within(allyRegion()).getByLabelText("物理")).toHaveValue(50);
    expect(within(enemyRegion()).getByLabelText("物理")).toHaveValue(1);
  });

  it("UI-CT-048: the two reset actions each clear only their own data", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await user.click(within(allyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));
    await placeUnit(user, allyRegion(), "前衛1にユニットを追加");
    await placeUnit(user, enemyRegion(), "前衛1にユニットを追加");
    await openAllyEnhancementDialog(user, /前衛1: アルファの強化を編集/);
    const level = screen.getByLabelText("現在レベル");
    await user.clear(level);
    await user.type(level, "220");
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    await user.click(screen.getByRole("button", { name: "編成をクリア" }));

    expect(
      within(allyRegion()).getByRole("button", { name: "前衛1にユニットを追加" }),
    ).toBeInTheDocument();
    expect(
      within(enemyRegion()).getByRole("button", { name: "前衛1にユニットを追加" }),
    ).toBeInTheDocument();

    // 手持ちデータは残っているので、置き直せばレベルが戻る。
    await user.click(within(allyRegion()).getByRole("checkbox", { name: "強化を有効にする" }));
    await placeUnit(user, allyRegion(), "前衛1にユニットを追加");
    await openAllyEnhancementDialog(user, /前衛1: アルファの強化を編集/);
    expect(screen.getByLabelText("現在レベル")).toHaveValue(220);
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    await placeUnit(user, enemyRegion(), "前衛1にユニットを追加");
    await user.click(screen.getByRole("button", { name: "保存した育成データをクリア" }));

    // 配置と敵側の入力は残し、味方の育成入力だけが既定へ戻る。
    expect(
      within(allyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ }),
    ).toBeInTheDocument();
    expect(
      within(enemyRegion()).getByRole("button", { name: /前衛1: アルファを変更/ }),
    ).toBeInTheDocument();
    await openAllyEnhancementDialog(user, /前衛1: アルファの強化を編集/);
    expect(screen.getByLabelText("現在レベル")).toHaveValue(200);
  });
});
