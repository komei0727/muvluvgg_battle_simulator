import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CatalogMemorySummary } from "../simulation/api-contract.js";
import { MemorySlot } from "./MemorySlot.js";

const memory: CatalogMemorySummary = {
  memoryDefinitionId: "MEM_A",
  displayName: "記憶アルファ",
  selectable: false,
  unavailableCapabilities: ["CAP_UNSUPPORTED"],
};

describe("MemorySlot — empty", () => {
  it("has an accessible name describing the slot index", () => {
    render(<MemorySlot index={2} hasError={false} disabled={false} onOpen={vi.fn()} />);

    expect(screen.getByRole("button", { name: /メモリー3/ })).toBeInTheDocument();
  });

  // docs/ui-design/05_非機能・アクセシビリティ設計.md §4 「<= 760px」: 3列×2段
  // へ折り返した場合もslot indexを表示する。折り返しの有無に関わらず常設する。
  it("shows a visible slot-index badge, not only in the accessible name", () => {
    render(<MemorySlot index={2} hasError={false} disabled={false} onOpen={vi.fn()} />);

    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("calls onOpen when activated", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<MemorySlot index={0} hasError={false} disabled={false} onOpen={onOpen} />);

    await user.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("MemorySlot — filled", () => {
  it("includes the memory's display name in the accessible name", () => {
    render(
      <MemorySlot index={0} memory={memory} hasError={false} disabled={false} onOpen={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /記憶アルファ/ })).toBeInTheDocument();
  });

  it("shows a visible slot-index badge alongside the display name", () => {
    render(
      <MemorySlot index={4} memory={memory} hasError={false} disabled={false} onOpen={vi.fn()} />,
    );

    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("includes an error indication in the accessible name when hasError is true", () => {
    render(
      <MemorySlot index={0} memory={memory} hasError={true} disabled={false} onOpen={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /エラー/ })).toBeInTheDocument();
  });
});
