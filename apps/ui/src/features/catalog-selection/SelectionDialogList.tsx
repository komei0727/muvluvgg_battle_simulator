import { DefinitionImage } from "../../components/DefinitionImage.js";
import type { DefinitionImageKind } from "../../components/DefinitionImage.js";
import styles from "./SelectionDialog.module.css";

export interface SelectionDialogItem {
  readonly definitionId: string;
  readonly displayName: string;
  /** 定義そのものが選択可能か。falseのとき未対応capabilityを表示する。 */
  readonly selectable: boolean;
  /**
   * 選択ボタンを無効化するか。`!selectable`に加えて枠側の事情（unit側の
   * 5体上限など）も含むため、呼び出し側が組み立てる。
   */
  readonly disabled: boolean;
  readonly unavailableCapabilities: readonly string[];
  readonly tags?: readonly string[];
}

export interface SelectionDialogListProps {
  readonly items: readonly SelectionDialogItem[];
  readonly kind: DefinitionImageKind;
  readonly currentDefinitionId?: string;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly onSelect: (definitionId: string) => void;
  readonly onRemove: () => void;
}

// docs/ui-design/04_コンポーネント・状態管理設計.md §3 MemorySelectionDialog:
// 「Unit版と同じ基本挙動」。リスト描画・枠を空にする操作・選択ボタンの
// aria-label生成をここへ集約し、両ダイアログで挙動が分岐しないようにする。
export function SelectionDialogList({
  items,
  kind,
  currentDefinitionId,
  imageMap,
  onSelect,
  onRemove,
}: SelectionDialogListProps) {
  return (
    <>
      {currentDefinitionId !== undefined ? (
        <button type="button" className={styles["removeButton"]} onClick={onRemove}>
          この枠を空にする
        </button>
      ) : null}

      <ul className={styles["list"]}>
        {items.map((item) => {
          const isCurrent = item.definitionId === currentDefinitionId;
          return (
            <li key={item.definitionId} className={styles["item"]}>
              <DefinitionImage
                definitionId={item.definitionId}
                displayName={item.displayName}
                kind={kind}
                {...(imageMap !== undefined ? { imageMap } : {})}
              />
              <div className={styles["itemBody"]}>
                <p className={styles["itemName"]}>{item.displayName}</p>
                <p className={styles["itemId"]}>{item.definitionId}</p>
                {item.tags !== undefined ? (
                  <div className={styles["itemTags"]}>
                    {/* 属性・役割・適性は同じ文字列になり得るため、値ではなく
                        並び順をkeyにする（並べ替えも絞り込みもしない固定列）。 */}
                    {item.tags.map((tag, tagIndex) => (
                      <span key={tagIndex} className={styles["tag"]}>
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {/* 理由が空なら「未対応:」だけの読めないラベルになるため出さない。
                    APIが選択不可を理由なしで返し得る（整合検証は行わない）。 */}
                {!item.selectable && item.unavailableCapabilities.length > 0 ? (
                  <p className={styles["unavailable"]}>
                    未対応: {item.unavailableCapabilities.join(", ")}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  onSelect(item.definitionId);
                }}
                disabled={item.disabled}
                aria-label={isCurrent ? `${item.displayName}選択中` : `${item.displayName}を選択`}
              >
                {isCurrent ? "選択中" : "選択"}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
