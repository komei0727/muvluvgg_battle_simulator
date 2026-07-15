import type { ReactNode } from "react";
import { useId } from "react";
import styles from "./Panel.module.css";

export interface PanelProps {
  readonly step: string;
  readonly title: string;
  readonly meta?: ReactNode;
  readonly children: ReactNode;
}

// Mirrors the adopted mock's `.panel` structure (step number + title + meta)
// so the information hierarchy stays intact without copying its markup as a
// runtime dependency (02_フロントエンドアーキテクチャ設計.md §10).
export function Panel({ step, title, meta, children }: PanelProps) {
  const titleId = useId();

  return (
    <section className={styles["panel"]} aria-labelledby={titleId}>
      <div className={styles["header"]}>
        <h2 className={styles["title"]} id={titleId}>
          <span className={styles["stepNumber"]} aria-hidden="true">
            {step}
          </span>
          {title}
        </h2>
        {meta ? <span className={styles["meta"]}>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
