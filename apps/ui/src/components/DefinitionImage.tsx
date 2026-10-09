import { useState } from "react";
import styles from "./DefinitionImage.module.css";
import { splitDisplayName } from "./display-name.js";

export type DefinitionImageKind = "unit" | "memory";

export interface DefinitionImageProps {
  readonly definitionId: string;
  readonly displayName: string;
  readonly kind: DefinitionImageKind;
  readonly typeLabel?: string;
  readonly imageMap?: Readonly<Record<string, string>>;
}

// docs/ui-design/01_UI要求・画面設計.md §9: URLなし・ロード失敗・空文字列は
// フォールバック(表示名の全文・種別ラベル)を表示し、画像だけを操作名の
// 唯一の情報にしない。ロード失敗は親componentのerrorにしない(UI-CMP-007)。
export function DefinitionImage({
  definitionId,
  displayName,
  kind,
  typeLabel,
  imageMap,
}: DefinitionImageProps) {
  // Tracks the specific src that failed, rather than a plain boolean, so a
  // later src change (e.g. selecting a different definition) is not treated
  // as still-failed.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const src = imageMap?.[definitionId];
  const showImage = src !== undefined && src.length > 0 && src !== failedSrc;

  if (showImage) {
    return (
      <img
        src={src}
        alt={displayName}
        className={`${styles["image"] ?? ""} ${styles[kind] ?? ""}`}
        onError={() => {
          setFailedSrc(src);
        }}
      />
    );
  }

  const { epithet, name } = splitDisplayName(displayName);

  // data-fallbackは親のCSS(メモリー枠の名前帯を隠す等)が画像の有無を判別するために使う。
  return (
    <div
      role="img"
      aria-label={displayName}
      title={displayName}
      data-fallback=""
      className={`${styles["fallback"] ?? ""} ${styles[kind] ?? ""}`}
    >
      <span className={styles["nameBlock"]} aria-hidden="true">
        {epithet !== undefined ? <span className={styles["epithet"]}>{epithet}</span> : null}
        <span className={styles["name"]}>{name}</span>
      </span>
      {typeLabel !== undefined ? (
        <span className={styles["typeLabel"]} aria-hidden="true">
          {typeLabel}
        </span>
      ) : null}
    </div>
  );
}
