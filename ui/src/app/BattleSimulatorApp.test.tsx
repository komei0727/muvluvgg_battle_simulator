import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BattleSimulatorApp } from "./BattleSimulatorApp.js";

describe("BattleSimulatorApp", () => {
  it("renders the app shell and setup panel when the API base URL is configured", () => {
    render(<BattleSimulatorApp apiBaseUrlResult={{ ok: true, url: "https://api.example.com" }} />);

    expect(screen.getByRole("banner")).toHaveTextContent("BATTLE ANALYTICS CONSOLE");
    expect(screen.getByRole("region", { name: "戦闘パラメータ" })).toBeInTheDocument();
  });

  it("shows a fatal configuration error instead of the app shell when the API base URL is invalid", () => {
    render(<BattleSimulatorApp apiBaseUrlResult={{ ok: false, reason: "MISSING" }} />);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/設定/);
  });
});
