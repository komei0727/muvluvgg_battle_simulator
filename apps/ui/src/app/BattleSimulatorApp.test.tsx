import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions } from "../features/simulation/api-client.js";
import type { CatalogApiResult } from "../features/simulation/api-contract.js";
import { BattleSimulatorApp } from "./BattleSimulatorApp.js";

// Never let this suite reach the real fetch-based catalog client: it would
// attempt an actual network request to the placeholder API origin.
function pendingGetCatalogImpl() {
  return vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(
    () => new Promise(() => {}),
  );
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
});
