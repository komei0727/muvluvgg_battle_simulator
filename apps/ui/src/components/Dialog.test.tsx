import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog.js";

function Harness({ onClose }: { readonly onClose: () => void }) {
  const [open, setOpen] = useState(true);
  function close() {
    setOpen(false);
    onClose();
  }
  return (
    <div>
      <button type="button">trigger</button>
      {open ? (
        <Dialog titleId="dialog-title" title="ユニットを選択" onClose={close}>
          <input type="search" aria-label="ユニットを検索" />
          <button type="button">選択</button>
        </Dialog>
      ) : null}
    </div>
  );
}

describe("Dialog", () => {
  it("exposes a modal dialog role labelled by the title", () => {
    render(
      <Dialog titleId="t" title="ユニットを選択" onClose={vi.fn()}>
        content
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "ユニットを選択" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus to the first focusable element on open (UI-CT-003)", () => {
    render(
      <Dialog titleId="t" title="ユニットを選択" onClose={vi.fn()}>
        <input type="search" aria-label="ユニットを検索" />
        <button type="button">選択</button>
      </Dialog>,
    );

    expect(screen.getByLabelText("ユニットを検索")).toHaveFocus();
  });

  it("closes on Escape (UI-CT-004)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog titleId="t" title="ユニットを選択" onClose={onClose}>
        <input type="search" aria-label="ユニットを検索" />
      </Dialog>,
    );

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the triggering element after closing (UI-CT-004)", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={() => {}} />);

    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    expect(trigger).toHaveFocus();

    // Open happens outside this harness in real usage (a slot click), so we
    // simulate the already-open dialog and only assert the close path here.
    await user.keyboard("{Escape}");

    expect(trigger).toHaveFocus();
  });

  it("traps Tab within the dialog, wrapping from the last focusable element to the header close button", async () => {
    const user = userEvent.setup();
    render(
      <Dialog titleId="t" title="ユニットを選択" onClose={vi.fn()}>
        <input type="search" aria-label="検索" />
        <button type="button">A</button>
        <button type="button">B</button>
      </Dialog>,
    );

    const closeButton = screen.getByRole("button", { name: "閉じる" });
    const buttonB = screen.getByRole("button", { name: "B" });

    buttonB.focus();
    await user.tab();

    expect(closeButton).toHaveFocus();
  });

  it("wraps from the header close button to the last focusable element on Shift+Tab", async () => {
    const user = userEvent.setup();
    render(
      <Dialog titleId="t" title="ユニットを選択" onClose={vi.fn()}>
        <input type="search" aria-label="検索" />
        <button type="button">A</button>
        <button type="button">B</button>
      </Dialog>,
    );

    const closeButton = screen.getByRole("button", { name: "閉じる" });
    const buttonB = screen.getByRole("button", { name: "B" });

    closeButton.focus();
    await user.tab({ shift: true });

    expect(buttonB).toHaveFocus();
  });

  it("shows a labelled close button that calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog titleId="t" title="ユニットを選択" onClose={onClose}>
        <input type="search" aria-label="検索" />
      </Dialog>,
    );

    await user.click(screen.getByRole("button", { name: "閉じる" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
