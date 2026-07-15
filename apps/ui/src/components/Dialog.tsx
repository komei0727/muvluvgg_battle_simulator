import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import styles from "./Dialog.module.css";

export interface DialogProps {
  readonly titleId: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElementsIn(container: HTMLElement): readonly HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

// Native <dialog>.showModal() is unreliable across the evergreen browser set
// this project targets and unimplemented in the jsdom test environment, so
// this implements the accessible-dialog fallback allowed by
// docs/ui-design/05_非機能・アクセシビリティ設計.md §6: role="dialog",
// aria-modal="true", a manual focus trap, and focus return on close.
export function Dialog({ titleId, title, onClose, children }: DialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Initial focus targets the content region (e.g. a dialog's search
    // input) per 05_非機能・アクセシビリティ設計.md §5, not the header close
    // button that always sits first in DOM order.
    const content = contentRef.current;
    const container = containerRef.current;
    const first =
      (content ? focusableElementsIn(content)[0] : undefined) ??
      (container ? focusableElementsIn(container)[0] : undefined);
    first?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const container = containerRef.current;
      if (container === null) {
        return;
      }
      const focusable = focusableElementsIn(container);
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className={styles["overlay"]}>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles["panel"]}
      >
        <div className={styles["header"]}>
          <h2 id={titleId} className={styles["title"]}>
            {title}
          </h2>
          <button
            type="button"
            className={styles["closeButton"]}
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}
