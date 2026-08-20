// docs/ui-design/01_UI要求・画面設計.md §8.7（`UI-AC-046`）: 順位セレクタが対象を決めた時点の
// 候補一覧を、解決時点の実効値で並べ直す純関数。
//
// **これは`EffectApplied`の付与先からの逆算であり、サーバーが実際にどう比較したかの直接の
// 証拠ではない。** 対象決定そのものを表すイベントは存在しない（`SkillUseStarted`はスキル・
// コスト・クールタイムしか持たない）。したがって:
//
// - 候補の母集団は「実際に選ばれたユニットと同じ陣営の全ユニット」と仮定している。セレクタが
//   `filter`で母集団を絞っていた場合はここに現れない（表に載せる効果はfilterなしのものだけに
//   限っているが、Catalogが変われば前提が崩れうる）。
// - 同点の解決順・戦闘不能ユニットの除外といった細部は再現していない。復元した最上位と実際の
//   付与先が食い違った場合は`matchesReconstruction: false`として画面へ出し、黙って
//   「これが選ばれた理由です」と言い切らない。
//
// 必要になった時点で、対象決定イベントをAPIへ追加することを別途検討する。

import { rankSelectorSpecOf } from "./rank-selector-presets.js";
import type { RankOrderKey, RankSelectorSpec } from "./rank-selector-presets.js";
import type { CombatStatContribution, CombatStatTimeline } from "./combat-stat-timeline.js";
import type { EffectTraceInstance } from "./effect-trace-projector.js";

export interface RankCandidate {
  readonly battleUnitId: string;
  /** 解決時点の実効値。読めない場合は`undefined`（順位には混ぜない）。 */
  readonly value?: number;
  /** 開始時（`initialState`）の値。素の順位とバフ込みの順位を見比べるために出す。 */
  readonly initialValue?: number;
  /** 開始時からの内訳。打ち消しあった効果は含まない。 */
  readonly contributions: readonly CombatStatContribution[];
  readonly isChosen: boolean;
}

export interface RankCandidateGap {
  readonly runnerUpUnitId: string;
  /** 選ばれた候補と次点の差（絶対値）。 */
  readonly amount: number;
  /** 同じ差を次点に対する割合で表したもの。次点が0のときは持たない。 */
  readonly ratio?: number;
}

export interface RankCandidateComparison {
  readonly orderKey: RankOrderKey;
  readonly spec: RankSelectorSpec;
  /** 対象決定が行われたスキル解決の起点`sequence`。候補の値はこれ**より前**で評価する。 */
  readonly resolvedBeforeSequence: number;
  /** 順位順。値が読めない候補は末尾へ置く。 */
  readonly candidates: readonly RankCandidate[];
  readonly gapToRunnerUp?: RankCandidateGap;
  /** 復元した最上位が実際の付与先と一致したか。不一致は逆算の限界を示す。 */
  readonly matchesReconstruction: boolean;
  /** 値を読めなかった候補があるか。あれば順位は部分的にしか確かめられていない。 */
  readonly hasUnreadableCandidate: boolean;
}

export interface CompareRankCandidatesInput {
  readonly instance: EffectTraceInstance;
  readonly timeline: CombatStatTimeline;
  /** `battleUnitId` → `ALLY`／`ENEMY`。候補の母集団を付与先と同じ陣営に限るために使う。 */
  readonly sideByUnitId: ReadonlyMap<string, string>;
}

export function compareRankCandidates({
  instance,
  timeline,
  sideByUnitId,
}: CompareRankCandidatesInput): RankCandidateComparison | undefined {
  const spec = rankSelectorSpecOf(instance.effectActionDefinitionId);
  if (spec === undefined) {
    return undefined;
  }
  const side = sideByUnitId.get(instance.holderUnitId);
  if (side === undefined) {
    return undefined;
  }

  // 対象決定はスキル解決の起点で1度だけ行われるので、候補はそこで比べる（付与時点ではない）。
  const resolvedBeforeSequence = instance.resolutionStartSequence;
  const candidates: RankCandidate[] = [];
  for (const [battleUnitId, unitSide] of sideByUnitId) {
    if (unitSide !== side) {
      continue;
    }
    const value = timeline.valueBefore(battleUnitId, spec.field, resolvedBeforeSequence);
    const initialValue = timeline.initialValue(battleUnitId, spec.field);
    candidates.push({
      battleUnitId,
      ...(value !== undefined ? { value } : {}),
      ...(initialValue !== undefined ? { initialValue } : {}),
      contributions: timeline.contributionsBefore(battleUnitId, spec.field, resolvedBeforeSequence),
      isChosen: battleUnitId === instance.holderUnitId,
    });
  }

  // 値が読めない候補を順位へ混ぜると、読めた候補だけの順位が全体の順位に見える。末尾へ寄せる。
  const ranked = [...candidates].sort((a, b) => {
    if (a.value === undefined || b.value === undefined) {
      return a.value === b.value ? 0 : a.value === undefined ? 1 : -1;
    }
    return spec.direction === "DESC" ? b.value - a.value : a.value - b.value;
  });

  const readable = ranked.filter((candidate) => candidate.value !== undefined);
  const chosen = ranked.find((candidate) => candidate.isChosen);
  const chosenRankIndex = readable.findIndex((candidate) => candidate.isChosen);
  const runnerUp = chosenRankIndex >= 0 ? readable[chosenRankIndex + 1] : undefined;

  let gapToRunnerUp: RankCandidateGap | undefined;
  if (chosen?.value !== undefined && runnerUp?.value !== undefined) {
    const amount = Math.abs(chosen.value - runnerUp.value);
    gapToRunnerUp = {
      runnerUpUnitId: runnerUp.battleUnitId,
      amount,
      ...(runnerUp.value !== 0 ? { ratio: amount / runnerUp.value } : {}),
    };
  }

  return {
    orderKey: spec.orderKey,
    spec,
    resolvedBeforeSequence,
    candidates: ranked,
    ...(gapToRunnerUp !== undefined ? { gapToRunnerUp } : {}),
    matchesReconstruction: readable[0]?.battleUnitId === instance.holderUnitId,
    hasUnreadableCandidate: readable.length !== candidates.length,
  };
}
