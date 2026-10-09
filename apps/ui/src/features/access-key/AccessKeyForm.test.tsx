import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccessKeyForm } from "./AccessKeyForm.js";

describe("AccessKeyForm", () => {
  it("UI-CT-152: submits the entered key, masks it, and stays disabled while empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AccessKeyForm status="required" onSubmit={onSubmit} />);

    const input = screen.getByLabelText("アクセスキー");
    const submit = screen.getByRole("button", { name: "保存して接続" });
    expect(input).toHaveAttribute("type", "password");
    expect(submit).toBeDisabled();

    await user.type(input, "k".repeat(40));
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith("k".repeat(40));
  });

  it("UI-CT-153: explains a rejected key as an alert so screen readers announce it", () => {
    render(<AccessKeyForm status="rejected" onSubmit={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "アクセスキーが正しくないか、無効になっています。",
    );
  });

  it("UI-CT-154: asks for a key without an alert when none has been entered yet", () => {
    render(<AccessKeyForm status="required" onSubmit={vi.fn()} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText("このアプリを使うにはアクセスキーが必要です。", { exact: false }),
    ).toBeInTheDocument();
  });
});
