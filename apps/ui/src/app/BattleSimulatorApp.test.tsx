import { fireEvent, render as renderComponent, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions, SimulateOptions } from "../shared/api/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationRequest,
  CatalogApiResult,
  SimulationApiResult,
} from "../shared/api/api-contract.js";
import { BattleSimulatorApp } from "./BattleSimulatorApp.js";

/**
 * 既定モードは戦術演習（`UI-AC-018`）。ここで見るのは通常戦闘モードの配線なので、
 * render直後に通常戦闘タブへ切り替える。接続設定エラーの表示ではタブ自体が
 * 描画されないため、存在するときだけ押す。
 */
function render(ui: ReactElement) {
  const result = renderComponent(ui);
  const battleTab = screen.queryByRole("tab", { name: "通常戦闘" });
  if (battleTab !== null) {
    fireEvent.click(battleTab);
  }
  return result;
}

// The real definition-image-map.ts globs locally-synced, gitignored assets
// (apps/ui/scripts/sync-character-images.mjs) that are absent in CI.
vi.mock("../features/catalog-selection/definition-image-map.js", () => ({
  unitImageMap: {},
  memoryImageMap: {},
  definitionImageMap: {},
}));

// Never let this suite reach the real fetch-based catalog client: it would
// attempt an actual network request to the placeholder API origin.
function pendingGetCatalogImpl() {
  return vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(
    () => new Promise(() => {}),
  );
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
    ],
    memories: [],
  };
}

describe("BattleSimulatorApp", () => {
  it("renders the app shell and setup panel when the API base URL is configured", () => {
    render(
      <BattleSimulatorApp
        apiBaseUrlResult={{ ok: true, url: "https://api.example.com" }}
        getCatalogImpl={pendingGetCatalogImpl()}
      />,
    );

    expect(screen.getByRole("banner")).toHaveTextContent("BATTLE ANALYTICS CONSOLE");
    expect(screen.getByRole("region", { name: "戦闘パラメータ" })).toBeInTheDocument();
  });

  it("shows a fatal configuration error instead of the app shell when the API base URL is invalid", () => {
    render(<BattleSimulatorApp apiBaseUrlResult={{ ok: false, reason: "MISSING" }} />);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/設定/);
  });

  // getCatalogImpl と対称に、simulateImpl も BattleSimulatorPage へ委譲する。
  // 委譲が無いと実行系のみ実 fetch へ落ち、この層でAPI clientを差し替えられない。
  it("delegates simulateImpl to the page so the execution client stays injectable", async () => {
    const user = userEvent.setup();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => new Promise(() => {}));
    render(
      <BattleSimulatorApp
        apiBaseUrlResult={{ ok: true, url: "https://api.example.com" }}
        getCatalogImpl={vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
          Promise.resolve({ ok: true, response: catalogResponse() }),
        )}
        simulateImpl={simulateImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
    });
    await user.click(screen.getAllByRole("button", { name: "前衛1にユニットを追加" })[0]!);
    await user.click(screen.getByRole("button", { name: "アルファを選択" }));
    await user.click(screen.getByRole("button", { name: "前衛1にユニットを追加" }));
    await user.click(screen.getByRole("button", { name: "アルファを選択" }));
    await user.click(screen.getByRole("button", { name: "戦闘を開始" }));

    expect(simulateImpl).toHaveBeenCalledTimes(1);
    expect(simulateImpl.mock.calls[0]![1].baseUrl).toBe("https://api.example.com");
  });
});
