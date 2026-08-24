import { fireEvent, render as renderComponent, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions } from "../shared/api/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  CatalogApiResult,
} from "../shared/api/api-contract.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

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
