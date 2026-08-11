import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FormationResetControls } from "./FormationResetControls.js";

describe("FormationResetControls (UI-CMP-020)", () => {
  it("notifies each reset intent separately", async () => {
    const user = userEvent.setup();
    const onResetDraft = vi.fn();
    const onClearPlayerData = vi.fn();
    render(
      <FormationResetControls
        disabled={false}
        onResetDraft={onResetDraft}
        onClearPlayerData={onClearPlayerData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "編成をクリア" }));
    expect(onResetDraft).toHaveBeenCalledTimes(1);
    expect(onClearPlayerData).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "保存した育成データをクリア" }));
    expect(onClearPlayerData).toHaveBeenCalledTimes(1);
    expect(onResetDraft).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while the formation is disabled", () => {
    render(<FormationResetControls disabled onResetDraft={vi.fn()} onClearPlayerData={vi.fn()} />);

    expect(screen.getByRole("button", { name: "編成をクリア" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存した育成データをクリア" })).toBeDisabled();
  });
});
