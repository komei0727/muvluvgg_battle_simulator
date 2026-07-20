import { useState } from "react";
import { Button } from "../../components/Button.js";
import { buildCausalityTree } from "./event-causality-tree.js";
import type { CausalityTreeNode } from "./event-causality-tree.js";
import { formatEvent } from "./event-formatters.js";
import type { RosterIndex } from "./event-formatters.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";
import styles from "./EventCausalityTree.module.css";

export interface EventCausalityTreeProps {
  readonly events: readonly BattleLogEventResponse[];
  readonly roster: RosterIndex;
}

interface CausalityNodeRowProps {
  readonly node: CausalityTreeNode;
  readonly roster: RosterIndex;
}

// docs/ui-design/07_UI実装・拡張計画.md §10: 「DIAGNOSTIC固有情報は折りたたみ、
// 既定表示を圧迫しない」。DIAGNOSTIC事象自体の行は表示するが、その配下
// (children)は既定で折りたたみ、展開してもUI-CMP-006同様に取りこぼさない。
function CausalityNodeRow({ node, roster }: CausalityNodeRowProps) {
  const isDiagnostic = node.event["category"] === "DIAGNOSTIC";
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [childrenExpanded, setChildrenExpanded] = useState(!isDiagnostic);
  const presentation = formatEvent(node.event, roster);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <button
        type="button"
        className={[styles["row"], isDiagnostic ? styles["diagnosticRow"] : ""]
          .filter(Boolean)
          .join(" ")}
        aria-expanded={detailsExpanded}
        onClick={() => {
          setDetailsExpanded((current) => !current);
        }}
      >
        <span className={styles["sequence"]}>#{String(node.sequence).padStart(3, "0")}</span>
        <span className={styles["type"]}>{presentation.title}</span>
        <span>{presentation.summary}</span>
      </button>
      {detailsExpanded ? (
        <div className={styles["expanded"]}>
          <pre>{JSON.stringify(presentation.details, null, 2)}</pre>
        </div>
      ) : null}
      {hasChildren && !childrenExpanded ? (
        <Button
          variant="ghost"
          className={styles["expandChildren"]}
          onClick={() => {
            setChildrenExpanded(true);
          }}
        >
          DIAGNOSTIC配下 {node.children.length}件を表示
        </Button>
      ) : null}
      {hasChildren && childrenExpanded ? (
        <ul className={styles["children"]}>
          {node.children.map((child) => (
            <CausalityNodeRow key={child.sequence} node={child} roster={roster} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// docs/ui-design/07_UI実装・拡張計画.md §10「PSイベントは通常の時系列と因果
// treeを切り替えられるようにする候補とする」。parentSequence/rootSequenceは
// event typeを問わず全eventが持つ(08_ドメインイベント.md)ため、PS/Memoryの
// 区別なく汎用的にtreeを構築する — 将来Memory発動eventが追加されても、この
// componentの変更なしに追跡できる。
export function EventCausalityTree({ events, roster }: EventCausalityTreeProps) {
  const roots = buildCausalityTree(events);

  return (
    <div className={styles["scrollArea"]}>
      <ul className={styles["tree"]}>
        {roots.map((node) => (
          <CausalityNodeRow key={node.sequence} node={node} roster={roster} />
        ))}
      </ul>
    </div>
  );
}
