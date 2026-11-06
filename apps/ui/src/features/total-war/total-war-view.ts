// docs/ui-design/04_コンポーネント・状態管理設計.md §4「総力戦の編成draft」と
// 01_UI要求・画面設計.md §5.10「編成タブ」。
//
// 編成エディタ・選択ダイアログ・ステータスプレビューは総力戦を知らない。ここで
// 3組のdraftと`/allyFormations/{i}/...`形の違反を、1編成ぶんの形へ写して渡す。
import type { FormationIndex, TotalWarFormations } from "./total-war-draft.js";
import type { BattleDraft, Side } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";

export interface ActiveFormations {
  readonly ally: FormationIndex;
  readonly enemy: FormationIndex;
}

/**
 * 味方側は味方の表示中の組、敵側は敵の表示中の組から取った1編成ぶんのdraft。
 * 操作は`totalWarReducer`が陣営ごとの表示中の組へ振り分けるため、ダイアログと
 * プレビューはこの合成を通常戦闘のdraftと同じように読める。
 */
export function composeDisplayedDraft(
  formations: TotalWarFormations,
  active: ActiveFormations,
): BattleDraft {
  const enemySource = formations[active.enemy];
  return {
    ...formations[active.ally],
    enemySlots: enemySource.enemySlots,
    enemyMemoryDefinitionIds: enemySource.enemyMemoryDefinitionIds,
    enemyEnhancement: enemySource.enemyEnhancement,
  };
}

function formationPathPrefix(side: Side, index: FormationIndex): string {
  return `/${side}Formations/${String(index)}`;
}

function belongsTo(violation: UiViolation, side: Side, index: FormationIndex): boolean {
  const prefix = formationPathPrefix(side, index);
  return (
    violation.formationIndex === index &&
    (violation.path === prefix || violation.path.startsWith(`${prefix}/`))
  );
}

/**
 * その陣営・その編成の違反（と、編成を持たない違反）だけを、`path`を1編成ぶんの
 * `/allyFormation/...`の形へ戻して返す。陣営強化パネルとユニット強化ダイアログは
 * この形の`path`で入力欄を引くため。`slotKey`は組の間で同じ文字列になるので、
 * 他の編成の違反を混ぜると表示中でない編成の枠のエラーが同じ位置に出てしまう。
 */
export function violationsForFormation(
  violations: readonly UiViolation[],
  side: Side,
  index: FormationIndex,
): readonly UiViolation[] {
  const prefix = formationPathPrefix(side, index);
  return violations.flatMap((violation) => {
    if (violation.formationIndex === undefined) {
      return [violation];
    }
    if (!belongsTo(violation, side, index)) {
      return [];
    }
    return [{ ...violation, path: `/${side}Formation${violation.path.slice(prefix.length)}` }];
  });
}

/** 編成タブの「要修正」。警告（適性外）は送信を止めないため数えない。 */
export function formationHasErrors(
  violations: readonly UiViolation[],
  side: Side,
  index: FormationIndex,
): boolean {
  return violations.some(
    (violation) => violation.severity === "error" && belongsTo(violation, side, index),
  );
}

const FORMATION_PATH_PATTERN = /^\/(ally|enemy)Formations\/(\d+)(\/.*)?$/;

const SIDE_LABELS: Readonly<Record<Side, string>> = { ally: "味方", enemy: "敵" };

/**
 * 設定領域上部の一覧用に、違反の文言へ陣営と編成番号を前置する。陣営の強化入力
 * （`/{side}Formations/{i}/enhancement/...`）は3編成で共通の1組なので、編成番号を
 * 付けずに陣営だけを前置する——同じ文言になり、一覧の重複除去で1件に畳まれる。
 */
export function labelTotalWarViolations(
  violations: readonly UiViolation[],
): readonly UiViolation[] {
  return violations.map((violation) => {
    const match = FORMATION_PATH_PATTERN.exec(violation.path);
    if (violation.formationIndex === undefined || match === null) {
      return violation;
    }
    const side = match[1] === "ally" ? "ally" : "enemy";
    const rest = match[3] ?? "";
    const label =
      rest === "/enhancement" || rest.startsWith("/enhancement/")
        ? SIDE_LABELS[side]
        : `${SIDE_LABELS[side]}の編成${String(violation.formationIndex + 1)}`;
    return { ...violation, message: `${label}: ${violation.message}` };
  });
}
