import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell.js";

describe("AppShell", () => {
  it("renders the brand name in the banner landmark", () => {
    render(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );

    const banner = screen.getByRole("banner");
    expect(banner).toHaveTextContent("BATTLE ANALYTICS CONSOLE");
  });

  it("renders children inside the main landmark", () => {
    render(
      <AppShell>
        <p>page content</p>
      </AppShell>,
    );

    expect(screen.getByRole("main")).toHaveTextContent("page content");
  });

  it("renders optional system status content in the banner", () => {
    render(
      <AppShell systemStatus="API READY">
        <p>content</p>
      </AppShell>,
    );

    expect(screen.getByRole("banner")).toHaveTextContent("API READY");
  });

  it("omits the system status region when none is provided", () => {
    render(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );

    expect(screen.queryByLabelText("API接続状態")).not.toBeInTheDocument();
  });

  it("renders the UI build revision in the footer landmark", () => {
    render(
      <AppShell buildRevision="abc1234">
        <p>content</p>
      </AppShell>,
    );

    expect(screen.getByRole("contentinfo")).toHaveTextContent("abc1234");
  });
});
