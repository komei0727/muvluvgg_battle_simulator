import { useId, useState } from "react";
import { Button } from "../../components/Button.js";
import styles from "./AccessKeyForm.module.css";
import type { AccessKeyStatus } from "./use-access-key-gate.js";

export interface AccessKeyFormProps {
  readonly status: Exclude<AccessKeyStatus, "unknown">;
  readonly onSubmit: (key: string) => void;
}

const DESCRIPTION =
  "このアプリを使うにはアクセスキーが必要です。配布されたキーを入力してください。キーはこのブラウザにだけ保存されます。";
const REJECTED_MESSAGE =
  "アクセスキーが正しくないか、無効になっています。配布されたキーを確認して入力し直してください。";

/**
 * docs/ui-design/01_UI要求・画面設計.md: APIが401を返したときだけ表示するキー入力欄。
 * キーは画面に表示しない（`type="password"`）——画面共有や肩越しに読まれないため。
 */
export function AccessKeyForm({ status, onSubmit }: AccessKeyFormProps) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <div>
      {status === "rejected" ? (
        <p role="alert" className={styles["error"]}>
          {REJECTED_MESSAGE}
        </p>
      ) : (
        <p className={styles["description"]}>{DESCRIPTION}</p>
      )}
      <form
        className={styles["form"]}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== "") {
            onSubmit(trimmed);
          }
        }}
      >
        <div className={styles["field"]}>
          <label htmlFor={inputId}>アクセスキー</label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={trimmed === ""}>
          保存して接続
        </Button>
      </form>
    </div>
  );
}
