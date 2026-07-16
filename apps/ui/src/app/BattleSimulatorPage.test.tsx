import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SimulateOptions } from "../features/simulation/api-client.js";
import type { GetCatalogOptions } from "../features/simulation/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  CatalogApiResult,
  SimulationApiResult,
} from "../features/simulation/api-contract.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";
import type { BattleSimulationRequest } from "../features/formation/request-mapper.js";

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
        selectable: true,
        unavailableCapabilities: [],
      },
      {
        unitDefinitionId: "UNIT_LOCKED",
        displayName: "ロック",
        characterName: "Locked",
        attribute: "SMART",
        unitType: "ATTACKER",
        role: "TANK",
        positionAptitudes: ["FRONT"],
        selectable: false,
        unavailableCapabilities: ["CAP_LOCKED"],
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

  it("does not offer a non-selectable unit for selection, showing its capability reason (UI-CT-006)", async () => {
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

    expect(screen.getByRole("button", { name: "ロックを選択" })).toBeDisabled();
    expect(screen.getByText(/CAP_LOCKED/)).toBeInTheDocument();
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

  it("shows a failed execution instead of a fabricated success when the response fails contract validation (review: PR #123 finalState/roster contract mismatch)", async () => {
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
