import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BattleSetupLayout } from "./BattleSetupLayout.js";

describe("BattleSetupLayout", () => {
  it("renders the ally and enemy formation content", () => {
    render(<BattleSetupLayout ally={<p>ally content</p>} enemy={<p>enemy content</p>} />);

    expect(screen.getByText("ally content")).toBeInTheDocument();
    expect(screen.getByText("enemy content")).toBeInTheDocument();
  });

  // docs/ui-design/battle-simulator-mock.html の vs-divider を移植する。装飾
  // 要素のためscreen readerには公開しない(05_非機能・アクセシビリティ設計.md
  // §2)。
  it("renders a decorative VS divider between the two sides", () => {
    render(<BattleSetupLayout ally={<p>ally content</p>} enemy={<p>enemy content</p>} />);

    const vs = screen.getByText("VS");
    expect(vs).toBeInTheDocument();
    expect(vs.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("keeps ally before enemy in DOM order for a sane keyboard/reading order", () => {
    render(<BattleSetupLayout ally={<p>ally content</p>} enemy={<p>enemy content</p>} />);

    const ally = screen.getByText("ally content");
    const enemy = screen.getByText("enemy content");
    expect(ally.compareDocumentPosition(enemy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
