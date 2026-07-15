import { useState } from "react";
import { Button } from "../../components/Button.js";
import styles from "./RawJsonView.module.css";

export interface RawJsonViewProps {
  readonly value: unknown;
}

type CopyStatus = "idle" | "succeeded" | "failed";

// docs/ui-design/01_UI要求・画面設計.md §8.3: APIレスポンスを改変せず整形表
// 示する。JSON内のIDや数値を翻訳しない。DOMノードをフィールドごとに大量生成
// しない(単一の`pre`)。コピー失敗を戦闘失敗として扱わない。
export function RawJsonView({ value }: RawJsonViewProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const text = JSON.stringify(value, null, 2);
  const clipboard = navigator.clipboard as Clipboard | undefined;

  async function handleCopy() {
    if (clipboard === undefined) {
      return;
    }
    try {
      await clipboard.writeText(text);
      setStatus("succeeded");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className={styles["container"]}>
      <div className={styles["toolbar"]}>
        {clipboard !== undefined ? (
          <Button
            variant="secondary"
            onClick={() => {
              void handleCopy();
            }}
          >
            コピー
          </Button>
        ) : null}
        {status === "succeeded" ? <span className={styles["status"]}>コピーしました</span> : null}
        {status === "failed" ? (
          <span className={styles["status"]}>コピーに失敗しました</span>
        ) : null}
      </div>
      <pre className={styles["pre"]}>{text}</pre>
    </div>
  );
}
