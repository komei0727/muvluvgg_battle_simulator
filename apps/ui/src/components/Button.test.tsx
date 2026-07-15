import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";

describe("Button", () => {
  it("renders its label", () => {
    render(<Button>戦闘を開始</Button>);

    expect(screen.getByRole("button", { name: "戦闘を開始" })).toBeInTheDocument();
  });

  it("defaults to type=button so it cannot submit a form by accident", () => {
    render(<Button>実行</Button>);

    expect(screen.getByRole("button", { name: "実行" })).toHaveAttribute("type", "button");
  });

  it("calls onClick when activated", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>実行</Button>);

    await user.click(screen.getByRole("button", { name: "実行" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled when the disabled prop is set", () => {
    render(<Button disabled>実行</Button>);

    expect(screen.getByRole("button", { name: "実行" })).toBeDisabled();
  });

  it.each(["primary", "secondary", "ghost"] as const)("applies the %s variant class", (variant) => {
    render(<Button variant={variant}>実行</Button>);

    expect(screen.getByRole("button", { name: "実行" }).className).toContain(variant);
  });
});
