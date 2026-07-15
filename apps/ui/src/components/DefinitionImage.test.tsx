import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DefinitionImage } from "./DefinitionImage.js";

const imageMap = { UNIT_A: "/assets/broken.png", UNIT_B: "/assets/unit-b.png" };

describe("DefinitionImage", () => {
  // UI-UT-CAT-005 / 01_UI要求・画面設計.md §9
  it("renders a fallback with initials when no image is mapped", () => {
    render(<DefinitionImage definitionId="UNIT_A" displayName="Alpha Unit" kind="unit" />);

    expect(screen.getByText("AL")).toBeInTheDocument();
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

    expect(screen.getByText("AL")).toBeInTheDocument();
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
  it("falls back to the initials view when the image fails to load, without throwing", () => {
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

    expect(screen.getByText("AL")).toBeInTheDocument();
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
    expect(screen.getByText("AL")).toBeInTheDocument();

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

  it("shows the optional type label alongside the fallback initials", () => {
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

  it("derives initials from a single-character display name", () => {
    render(<DefinitionImage definitionId="UNIT_X" displayName="X" kind="memory" />);

    expect(screen.getByText("X")).toBeInTheDocument();
  });
});
