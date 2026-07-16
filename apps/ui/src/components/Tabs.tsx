import { useRef } from "react";
import styles from "./Tabs.module.css";

export interface TabItem {
  readonly id: string;
  readonly label: string;
}

export interface TabsProps {
  readonly label: string;
  readonly items: readonly TabItem[];
  readonly activeId: string;
  readonly onChange: (id: string) => void;
}

// WAI-ARIA APG「Tabs with Automatic Activation」: roving tabindex (選択中だけ
// tabindex=0)、ArrowLeft/Right/Home/Endでfocusと選択を同時に移動する
// (UI-CT-013: event/transition/JSON tabをkeyboardで切り替えられる)。
export function Tabs({ label, items, activeId, onChange }: TabsProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  function focusAndSelect(id: string) {
    onChange(id);
    tabRefs.current.get(id)?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = items[(index + 1) % items.length]!;
      focusAndSelect(next.id);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const previous = items[(index - 1 + items.length) % items.length]!;
      focusAndSelect(previous.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAndSelect(items[0]!.id);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAndSelect(items[items.length - 1]!.id);
    }
  }

  return (
    <div role="tablist" aria-label={label} className={styles["tablist"]}>
      {items.map((item, index) => {
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            ref={(element) => {
              if (element) {
                tabRefs.current.set(item.id, element);
              } else {
                tabRefs.current.delete(item.id);
              }
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={isActive}
            aria-controls={`tabpanel-${item.id}`}
            tabIndex={isActive ? 0 : -1}
            className={styles["tab"]}
            onClick={() => {
              onChange(item.id);
            }}
            onKeyDown={(event) => {
              handleKeyDown(event, index);
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
