import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DefinitionImage } from "./DefinitionImage.js";

const imageMap = { UNIT_A: "/assets/broken.png", UNIT_B: "/assets/unit-b.png" };

describe("DefinitionImage", () => {
  // UI-UT-CAT-005 / 01_UI要求・画面設計.md §9
  it("renders a fallback with the full display name when no image is mapped", () => {
    render(<DefinitionImage definitionId="UNIT_A" displayName="Alpha Unit" kind="unit" />);

    expect(screen.getByText("Alpha Unit")).toBeInTheDocument();
  });

  it("renders a fallback when the image map value is an empty string", () => {
    render(
      <DefinitionImage
        definitionId="UNIT_A"
        displayName="Alpha Unit"
        kind="unit"
        imageMap={{ UNIT_A: "" }}
      />,
    );

    expect(screen.getByText("Alpha Unit")).toBeInTheDocument();
  });

  it("renders an img element with the mapped src when available", () => {
    render(
      <DefinitionImage
        definitionId="UNIT_A"
        displayName="Alpha Unit"
        kind="unit"
        imageMap={{ UNIT_A: "/assets/unit-a.png" }}
      />,
    );

    const el = screen.getByRole("img", { name: "Alpha Unit" });
    expect(el.tagName).toBe("IMG");
    expect(el.getAttribute("src")).toBe("/assets/unit-a.png");
  });

  // UI-CMP-007
  it("falls back to the full-name view when the image fails to load, without throwing", () => {
    render(
      <DefinitionImage
        definitionId="UNIT_A"
        displayName="Alpha Unit"
        kind="unit"
        imageMap={{ UNIT_A: "/assets/broken.png" }}
      />,
    );

    const img = screen.getByRole("img", { name: "Alpha Unit" });
    expect(() => fireEvent.error(img)).not.toThrow();

    expect(screen.getByText("Alpha Unit")).toBeInTheDocument();
    const fallbackEl = screen.getByRole("img", { name: "Alpha Unit" });
    expect(fallbackEl.tagName).not.toBe("IMG");
  });

  it("shows a new image after a prior load failure once the src changes", () => {
    const { rerender } = render(
      <DefinitionImage
        definitionId="UNIT_A"
        displayName="Alpha Unit"
        kind="unit"
        imageMap={imageMap}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Alpha Unit" }));
    expect(screen.getByText("Alpha Unit")).toBeInTheDocument();

    rerender(
      <DefinitionImage
        definitionId="UNIT_B"
        displayName="Beta Unit"
        kind="unit"
        imageMap={imageMap}
      />,
    );

    const el = screen.getByRole("img", { name: "Beta Unit" });
    expect(el.tagName).toBe("IMG");
    expect(el.getAttribute("src")).toBe("/assets/unit-b.png");
  });

  it("exposes displayName as the accessible name regardless of image state", () => {
    render(<DefinitionImage definitionId="UNIT_A" displayName="Alpha Unit" kind="unit" />);

    expect(screen.getByRole("img", { name: "Alpha Unit" })).toBeInTheDocument();
  });

  it("shows the optional type label alongside the fallback name", () => {
    render(
      <DefinitionImage
        definitionId="UNIT_A"
        displayName="Alpha Unit"
        kind="unit"
        typeLabel="ATTACKER"
      />,
    );

    expect(screen.getByText("ATTACKER")).toBeInTheDocument();
  });

  it("shows a single-character display name as is", () => {
    render(<DefinitionImage definitionId="UNIT_X" displayName="X" kind="memory" />);

    expect(screen.getByText("X")).toBeInTheDocument();
  });

  it("shows the epithet and the name separately and keeps the full name in the title", () => {
    render(
      <DefinitionImage
        definitionId="UNIT_LYDIA"
        displayName="【おたすけさんぽ・イン・サマー】リディア・エルドリッジ"
        kind="unit"
      />,
    );

    expect(screen.getByText("【おたすけさんぽ・イン・サマー】")).toBeInTheDocument();
    expect(screen.getByText("リディア・エルドリッジ")).toBeInTheDocument();
    const fallbackEl = screen.getByRole("img", {
      name: "【おたすけさんぽ・イン・サマー】リディア・エルドリッジ",
    });
    expect(fallbackEl).toHaveAttribute(
      "title",
      "【おたすけさんぽ・イン・サマー】リディア・エルドリッジ",
    );
  });

  it("marks only the fallback view with data-fallback", () => {
    const { rerender } = render(
      <DefinitionImage
        definitionId="UNIT_A"
        displayName="Alpha Unit"
        kind="unit"
        imageMap={{ UNIT_A: "/assets/unit-a.png" }}
      />,
    );

    expect(screen.getByRole("img", { name: "Alpha Unit" })).not.toHaveAttribute("data-fallback");

    rerender(<DefinitionImage definitionId="UNIT_A" displayName="Alpha Unit" kind="unit" />);

    expect(screen.getByRole("img", { name: "Alpha Unit" })).toHaveAttribute("data-fallback");
  });
});
