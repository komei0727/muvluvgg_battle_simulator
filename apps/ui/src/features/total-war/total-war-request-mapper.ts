// docs/ui-design/03_API・データ連携設計.md §5.2（総力戦のリクエスト生成、UI-API-046）。
import { usedFormationIndices } from "./total-war-draft.js";
import type { TotalWarDraft } from "./total-war-draft.js";
import { buildFormation } from "../formation/request-mapper.js";
import type { BuiltFormation } from "../formation/request-mapper.js";
import { enhancementForSide, memorySlotsForSide, slotsForSide } from "../formation/types.js";
import type { Side } from "../../entities/battle-draft.js";
import type { FormationRequest, TotalWarRequest } from "../../shared/api/api-contract.js";

/**
 * 送信配列の`units[n]`・`memoryDefinitionIds[n]`・`gears[m]`から元の枠への対応表を
 * 1編成ぶん持つ。送信DTOは空枠を圧縮するため、サーバー422のindexを枠番号として
 * そのまま使えない（§13）。
 */
export interface FormationSlotMap {
  readonly unitSlotKeys: readonly string[];
  readonly memorySlotKeys: readonly string[];
  readonly gearSlotIndices: readonly (readonly number[])[];
}

/** 陣営ごとに出撃順。i番目が`{side}Formations[i]`の対応表。 */
export interface TotalWarFormationSlotMaps {
  readonly ally: readonly FormationSlotMap[];
  readonly enemy: readonly FormationSlotMap[];
}

export type TotalWarRequestBuildResult =
  | {
      readonly ok: true;
      readonly request: TotalWarRequest;
      readonly formationSlotMaps: TotalWarFormationSlotMaps;
    }
  | { readonly ok: false };

/** 使う編成を出撃順に1編成ぶんの既存変換へ通す。1つでも組み立てられなければ`undefined`。 */
function buildSide(draft: TotalWarDraft, side: Side): readonly BuiltFormation[] | undefined {
  const built: BuiltFormation[] = [];
  for (const index of usedFormationIndices(draft, side)) {
    const formation = draft.formations[index];
    // 陣営の強化入力は3組で等しい（reducerの不変条件）ため、各組の値をそのまま読む。
    const result = buildFormation(
      side,
      slotsForSide(formation, side),
      memorySlotsForSide(formation, side),
      enhancementForSide(formation, side),
    );
    if (result === undefined) {
      return undefined;
    }
    built.push(result);
  }
  return built;
}

function formationsOf(built: readonly BuiltFormation[]): readonly FormationRequest[] {
  return built.map((entry) => entry.formation);
}

function slotMapsOf(built: readonly BuiltFormation[]): readonly FormationSlotMap[] {
  return built.map(({ unitSlotKeys, memorySlotKeys, gearSlotIndices }) => ({
    unitSlotKeys,
    memorySlotKeys,
    gearSlotIndices,
  }));
}

/**
 * 呼び出し側は味方の各組へ`withPlayerEnhancement`で手持ちデータを重ねてから渡す。
 * `turnLimit`はAPIが未定義プロパティとして拒否するため出力しない。再登場の補正は
 * サーバーが自動で適用する（R-TWR-02）ため、リクエストには何も足さない。
 */
export function buildTotalWarRequest(draft: TotalWarDraft): TotalWarRequestBuildResult {
  const ally = buildSide(draft, "ally");
  const enemy = buildSide(draft, "enemy");
  if (ally === undefined || enemy === undefined) {
    return { ok: false };
  }
  return {
    ok: true,
    request: {
      allyFormations: formationsOf(ally),
      enemyFormations: formationsOf(enemy),
      options: { logLevel: draft.logLevel },
    },
    formationSlotMaps: { ally: slotMapsOf(ally), enemy: slotMapsOf(enemy) },
  };
}
