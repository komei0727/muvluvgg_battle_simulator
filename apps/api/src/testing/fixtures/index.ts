/**
 * production-catalogテスト（`__tests__/production-catalog/`）の共通ビルダー。
 *
 * ## `runProductionUnitBattle`（`testing/scenario/run-production-battle.ts`）の適用基準
 *
 * 適用する: 実Catalogユニットの固定1対1戦闘を Formation → Battle → Observation の
 * 実経路で完走させ、最終結果・イベント列だけを検証するテスト（golden回帰層と同型）。
 *
 * 適用しない（このfixture群で状態を手組みする）:
 * - 戦闘途中の前提状態（付与済み効果・マーカー・ゲージ・HP）を直接用意する必要がある
 * - 乱数列を抽選単位で制御して命中・会心・分岐を強制する必要がある
 *   （`runProductionUnitBattle` は定数乱数のみ）
 * - resolver内部の中間産物（`EffectSequencePlan`・per-targetフィルタ等）や
 *   特定イベントの因果関係そのものを検証する
 * - Memory編成・複数スロット・陣営非対称など、固定1対1コマンドで表現できない編成を使う
 * - まだturn action resolverが実行できないCapabilityの定義形状を検査する
 */
export {
  testBattleUnit,
  testPartyMember,
  type TestBattleUnitOptions,
  type TestPartyMemberOptions,
} from "./battle-actors.js";
export {
  definitionsForSkill,
  definitionsWith,
  type DefinitionsWithOptions,
} from "./battle-definitions.js";
export { initialSnapshotFor, reconstruct, type InitialSnapshotOptions } from "./battle-state.js";
export { DefaultUnitDefinitionMap } from "./default-unit-definition-map.js";
export {
  completedTargetIdsOf,
  effectActionGroupContext,
  type EffectActionGroupContextOptions,
} from "./effect-action-context.js";
export { seedRecorder, type SeededRecorder } from "./event-seed.js";
export { testMarker, type TestMarkerOverrides } from "./markers.js";
export {
  effectActionFrom,
  loadProductionSnapshot,
  memoryFrom,
  skillFrom,
  unitFrom,
} from "./production-catalog.js";
export { noMissNoCrit } from "./random.js";
export { testUnitDefinition, type TestUnitDefinitionOverrides } from "./unit-definitions.js";
