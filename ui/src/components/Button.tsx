import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  readonly variant?: ButtonVariant;
  readonly type?: "button" | "submit";
  readonly children: ReactNode;
}

// Defaults to type="button" because unlabeled submit buttons can trigger an
// unintended form submission on Enter (05_非機能・アクセシビリティ設計.md §5 Submit).
export function Button({
  variant = "primary",
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [styles["button"], styles[variant], className].filter(Boolean).join(" ");

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
