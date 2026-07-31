import type { BattleUnit } from "../model/battle-unit.js";
import type { MarkerRemovalSeed } from "../effects/marker-removal-service.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `UnitDefeated`を判定するために必要な最小の形。`BattleDomainEvent`（トップレベルの
 * `onFactEvent`）と`TriggerCandidateEvent`（PS連鎖内部）の双方がそのまま渡せるよう
 * 構造的に宣言する（`effect-expiration-condition-service.ts`の
 * `TriggerConditionPayloadSource`と同じ方針）。
 */
export interface DefeatEventSource {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020、Issue #279）: `UnitDefeated`
 * に対して、`duration.removeOnSourceDefeated`を宣言し、かつ付与者
 * （`MarkerState.sourceId`＝直近の付与者）が戦闘不能になったユニットである
 * `MarkerState`を除去対象として列挙する。`SKL_AOI_ELEGANT_AS1`（百花繚乱）の
 * raw原文「「高揚」は付与者が倒れると同時に解除される」を表す。
 *
 * 返した`seeds`はそのまま`removeMarkers`へ渡す — 同じ`linkedEffectGroupId`を持つ
 * 子効果（`ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN`／`..._DOT`）はR-EFF-09の
 * cross-typeカスケードが自動で巻き込むため、本モジュールはMarker自身の抽出だけを
 * 担う。評価タイミングはR-EFF-08（`expiration.conditions`）と同じ「関連する
 * ドメインイベント発行後、PS/Memory候補の抽出前」で、配線は
 * `passive-activation-service.ts`が持つ。
 *
 * R-MEM-04: Memoryの`triggeredEffects`由来の付与は具体的な付与者ユニットを持たず
 * `sourceId`が`undefined`（代わりに`sourceSide`を持つ）ため、この解除契機は
 * 成立しない — 「陣営の誰かが倒れた」ではなく「付与した本人が倒れた」が原文の
 * 意味であり、代替の付与者を推測しない。
 */
export function findMarkersRemovedOnSourceDefeat(
  units: readonly BattleUnit[],
  event: DefeatEventSource,
): readonly MarkerRemovalSeed[] {
  if (event.eventType !== "UnitDefeated") {
    return [];
  }
  const defeatedUnitId = event.payload.unitId as BattleUnitId | undefined;
  if (defeatedUnitId === undefined) {
    return [];
  }
  const seeds: MarkerRemovalSeed[] = [];
  for (const unit of units) {
    for (const marker of unit.markerStates) {
      if (
        marker.duration.definition.removeOnSourceDefeated === true &&
        marker.sourceId === defeatedUnitId
      ) {
        seeds.push({
          battleUnitId: unit.battleUnitId,
          markerInstanceId: marker.markerInstanceId,
          reason: "SOURCE_DEFEATED",
        });
      }
    }
  }
  return seeds;
}
