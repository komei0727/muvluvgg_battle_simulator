import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions } from "../features/simulation/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  CatalogApiResult,
} from "../features/simulation/api-contract.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

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
