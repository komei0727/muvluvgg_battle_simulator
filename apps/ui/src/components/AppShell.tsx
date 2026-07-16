import type { ReactNode } from "react";
import { resolveBuildRevision } from "../lib/build-info.js";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  readonly systemStatus?: ReactNode;
  readonly buildRevision?: string;
  readonly children: ReactNode;
}

// Mirrors the adopted mock's topbar/app-shell structure without copying its
// markup as a runtime dependency (02_フロントエンドアーキテクチャ設計.md §10).
// The footer surfaces the UI build revision alongside the API Catalog
// revision/Request ID already shown elsewhere on the page
// (05_非機能・アクセシビリティ設計.md §13, Issue #99 完了条件).
export function AppShell({ systemStatus, buildRevision, children }: AppShellProps) {
  return (
    <div className={styles["shell"]}>
      <header className={styles["topbar"]}>
        <div className={styles["brand"]}>
          <div className={styles["brandMark"]} aria-hidden="true">
            BA
          </div>
          <div>
            <p className={styles["brandName"]}>BATTLE ANALYTICS CONSOLE</p>
            <p className={styles["brandSubtitle"]}>MUV-LUV GG SIMULATION WORKSPACE</p>
          </div>
        </div>
        {systemStatus ? (
          <div className={styles["systemStatus"]} aria-label="API接続状態">
            {systemStatus}
          </div>
        ) : null}
      </header>
      <main className={styles["main"]}>{children}</main>
      <footer className={styles["footer"]}>UI build: {resolveBuildRevision(buildRevision)}</footer>
    </div>
  );
}
