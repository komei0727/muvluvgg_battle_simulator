import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Panel } from "./Panel.js";

describe("Panel", () => {
  it("renders as a labelled section with the panel title as its accessible name", () => {
    render(
      <Panel step="01" title="戦闘パラメータ">
        <p>body</p>
      </Panel>,
    );

    expect(screen.getByRole("region", { name: "戦闘パラメータ" })).toBeInTheDocument();
  });

  it("renders the step number and heading text", () => {
    render(
      <Panel step="01" title="戦闘パラメータ">
        <p>body</p>
      </Panel>,
    );

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("01戦闘パラメータ");
  });

  it("renders optional meta content", () => {
    render(
      <Panel step="02" title="戦闘サマリ" meta="COMPLETED">
        <p>body</p>
      </Panel>,
    );

    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
  });

  it("renders children inside the panel body", () => {
    render(
      <Panel step="01" title="戦闘パラメータ">
        <p>panel body content</p>
      </Panel>,
    );

    expect(screen.getByText("panel body content")).toBeInTheDocument();
  });
});
