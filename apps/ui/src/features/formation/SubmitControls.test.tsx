import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubmitControls } from "./SubmitControls.js";

describe("SubmitControls", () => {
  it("enables the start button and invokes onSubmit when clicked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SubmitControls canSubmit isSubmitting={false} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: "戦闘を開始" });
    expect(button).toBeEnabled();
    await user.click(button);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the start button when canSubmit is false", () => {
    render(
      <SubmitControls
        canSubmit={false}
        isSubmitting={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "戦闘を開始" })).toBeDisabled();
  });

  it("shows a disabled in-progress button and a cancel button while submitting (UI-UC-002)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<SubmitControls canSubmit isSubmitting={true} onSubmit={vi.fn()} onCancel={onCancel} />);

    expect(screen.getByRole("button", { name: "実行中…" })).toBeDisabled();
    const cancelButton = screen.getByRole("button", { name: "キャンセル" });
    await user.click(cancelButton);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not render a cancel button when not submitting", () => {
    render(<SubmitControls canSubmit isSubmitting={false} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "キャンセル" })).not.toBeInTheDocument();
  });
});
