import type { ReactNode } from "react";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  readonly systemStatus?: ReactNode;
  readonly children: ReactNode;
}

// Mirrors the adopted mock's topbar/app-shell structure without copying its
// markup as a runtime dependency (02_フロントエンドアーキテクチャ設計.md §10).
export function AppShell({ systemStatus, children }: AppShellProps) {
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
    </div>
  );
}
