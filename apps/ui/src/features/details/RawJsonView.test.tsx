import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RawJsonView } from "./RawJsonView.js";

const originalClipboard = navigator.clipboard as Clipboard | undefined;

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

function defineClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("RawJsonView", () => {
  it("renders the value as pretty-printed JSON without translating IDs or numbers (§8.3)", () => {
    const { container } = render(<RawJsonView value={{ battleId: "battle-01J", turnLimit: 10 }} />);

    expect(container.querySelector("pre")?.textContent).toBe(
      JSON.stringify({ battleId: "battle-01J", turnLimit: 10 }, null, 2),
    );
  });

  it("shows a copy button and copies the exact JSON text when the Clipboard API is available", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    defineClipboard(writeText);

    render(<RawJsonView value={{ a: 1 }} />);
    await user.click(screen.getByRole("button", { name: "コピー" }));

    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
    expect(await screen.findByText("コピーしました")).toBeInTheDocument();
  });

  it("shows failure feedback rather than crashing when copy rejects", async () => {
    const user = userEvent.setup();
    defineClipboard(vi.fn().mockRejectedValue(new Error("denied")));

    render(<RawJsonView value={{ a: 1 }} />);
    await user.click(screen.getByRole("button", { name: "コピー" }));

    expect(await screen.findByText("コピーに失敗しました")).toBeInTheDocument();
  });

  it("hides the copy button when the Clipboard API is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

    render(<RawJsonView value={{ a: 1 }} />);

    expect(screen.queryByRole("button", { name: "コピー" })).not.toBeInTheDocument();
  });
});
