import type { EffectActionKind } from "../../domain/catalog/definitions/effect-action-definition.js";

/**
 * Effect kind → 戦闘ルール（R-*）→ 単体テストのトレーサビリティ台帳。
 *
 * すべてのEffect kindはいずれかの戦闘ルール（`07_戦闘ルール詳細.md`）に紐づき、
 * その効果は単体テストで保証される（`12_テスト戦略.md`）。この台帳が
 * 「kindの効果を規定するルール」と「その振る舞いを保証する代表単体テスト」を
 * 機械検証可能な形で結線する。検証は {@link ./effect-kind-coverage.test.ts} が行う:
 * キー集合は`EFFECT_ACTION_KINDS`と完全一致し、ruleIdsは`RULE_COVERAGE`に実在し、
 * testCaseIdsは実行対象テストちょうど1件へ解決され、かつ当該ruleIdsのいずれかの
 * `RULE_COVERAGE.testCaseIds`に登録されていなければならない。
 *
 * `Record<EffectActionKind, …>`を正本とすることで、kind追加時の台帳未記載と
 * kind削除時の余剰エントリをコンパイルエラーとして検出する。
 */

export interface EffectKindCoverage {
  /** kindの効果の振る舞いを規定する`07_戦闘ルール詳細.md`のルールID。 */
  readonly ruleIds: readonly string[];
  /** kindのEffectAction解決・効果適用を検証する代表単体テストのID。 */
  readonly testCaseIds: readonly string[];
}

export const EFFECT_KIND_COVERAGE: Readonly<Record<EffectActionKind, EffectKindCoverage>> = {
  // 基本式・最終化は damage-calculator、実pipelineは effect-action-group-resolver と
  // damage-application-service.event-order が検証する。
  DAMAGE: {
    ruleIds: ["R-ACTN-01", "R-ACTN-02", "R-DMG-01", "R-DMG-02", "R-DMG-05"],
    testCaseIds: [
      "UT-R-DMG-01-001",
      "UT-R-DMG-01-005",
      "UT-R-DMG-02-001",
      "UT-R-DMG-05-001",
      "UT-R-SKL-06-008",
      "UT-R-ACTN-01-010",
    ],
  },
  // 即時回復は heal-application-service、full stackとHEAL_DISTRIBUTEは
  // effect-action-group-resolver.heal が検証する。
  HEAL: {
    ruleIds: ["R-ACTN-02", "R-HEAL-01", "R-HEAL-02"],
    testCaseIds: [
      "UT-R-HEAL-01-001",
      "UT-R-HEAL-01-003",
      "UT-R-HEAL-01-006",
      "UT-R-HEAL-01-007",
      "UT-R-HEAL-01-008",
    ],
  },
  // 付与は effect-action-group-resolver.heal、発火は action-phase-resolver が検証する。
  APPLY_CONTINUOUS_HEAL: {
    ruleIds: ["R-ACTN-03", "R-HEAL-03"],
    testCaseIds: ["UT-R-HEAL-03-001", "UT-R-HEAL-03-002", "UT-R-HEAL-03-003", "UT-R-HEAL-03-004"],
  },
  // 付与・重複上限・毒統合は effect-action-group-resolver.continuous-damage、
  // 発火は continuous-damage-service(.poison) が検証する。
  APPLY_CONTINUOUS_DAMAGE: {
    ruleIds: ["R-DOT-01", "R-DOT-02", "R-DOT-03", "R-DOT-04"],
    testCaseIds: [
      "UT-R-DOT-01-005",
      "UT-R-DOT-01-006",
      "UT-R-DOT-02-001",
      "UT-R-DOT-03-003",
      "UT-R-DOT-04-004",
      "UT-R-DOT-04-008",
    ],
  },
  // 付与・NON_STACKABLE・stacking.max は effect-action-group-resolver.stat-mod、
  // 戦闘不能対象のskipは effect-action-group-resolver が検証する。
  APPLY_STAT_MOD: {
    ruleIds: ["R-ACTN-01", "R-ACTN-03", "R-STA-04", "R-EFF-05"],
    testCaseIds: [
      "UT-R-EFF-01-021",
      "UT-R-EFF-01-022",
      "UT-R-ACTN-01-001",
      "UT-R-ACTN-01-006",
      "UT-R-EFF-05-017",
      "UT-R-EFF-05-019",
    ],
  },
  // 付与時のdirection/damageType焼き込みとヒットごとのcondition評価を
  // effect-action-group-resolver.modifier が検証する。
  APPLY_DAMAGE_MOD: {
    ruleIds: ["R-ACTN-03", "R-DMG-04"],
    testCaseIds: ["UT-R-DMG-04-010", "UT-R-DMG-04-011", "UT-R-DMG-04-012", "UT-R-DMG-04-013"],
  },
  // 3率の独立合成は piercing-policy、シールド適用は
  // damage-application-service.shield が検証する。
  APPLY_PIERCING_MOD: {
    ruleIds: ["R-DMG-03"],
    testCaseIds: [
      "UT-R-DMG-03-004",
      "UT-R-DMG-03-020",
      "UT-R-DMG-03-021",
      "UT-R-DMG-03-022",
      "UT-R-DMG-03-024",
    ],
  },
  // 付与時magnitude（符号付き率）・INCOMING合成・-100%クランプを
  // effect-action-group-resolver.heal が検証する。
  APPLY_HEALING_MOD: {
    ruleIds: ["R-ACTN-03", "R-HEAL-02"],
    testCaseIds: ["UT-R-HEAL-02-001", "UT-R-HEAL-02-002", "UT-R-HEAL-02-003"],
  },
  // 付与時transferTo解決は effect-action-group-resolver.heal、転送・自己リンク・
  // 転送先戦闘不能は heal-application-service が検証する。
  APPLY_HEALING_LINK: {
    ruleIds: ["R-HEAL-04"],
    testCaseIds: [
      "UT-R-HEAL-04-004",
      "UT-R-HEAL-04-005",
      "UT-R-HEAL-04-006",
      "UT-R-HEAL-04-008",
      "UT-R-HEAL-04-010",
    ],
  },
  // HP直接増減・丸め・DISTRIBUTEは resource-modification-service、full stackは
  // effect-action-group-resolver.resource が検証する。
  MODIFY_RESOURCE: {
    ruleIds: ["R-ACTN-02", "R-ACT-04"],
    testCaseIds: [
      "UT-R-ACTN-02-001",
      "UT-R-ACTN-02-003",
      "UT-R-ACTN-02-008",
      "UT-R-ACTN-02-015",
      "UT-R-ACTN-02-019",
    ],
  },
  // ADD/SET合成は resource-capacity-recalculation-service、HP上限は
  // combat-stat-recalculation-service、付与・免疫拒否は
  // effect-action-group-resolver.resource が検証する。
  MODIFY_RESOURCE_CAPACITY: {
    ruleIds: ["R-ACTN-03"],
    testCaseIds: [
      "UT-R-ACTN-03-001",
      "UT-R-ACTN-03-004",
      "UT-R-ACTN-03-008",
      "UT-R-ACTN-03-015",
      "UT-R-ACTN-03-016",
    ],
  },
  // STUN/FREEZE/BLIND付与・チャージキャンセル・解除対象カテゴリを
  // effect-action-group-resolver.status が検証する。
  APPLY_STATUS: {
    ruleIds: ["R-ACTN-03", "R-STS-01", "R-STS-02", "R-STS-03", "R-STS-04"],
    testCaseIds: [
      "UT-R-STS-01-001",
      "UT-R-STS-02-004",
      "UT-R-STS-02-005",
      "UT-R-STS-03-004",
      "UT-R-HIT-03-010",
      "UT-R-EFF-01-051",
    ],
  },
  // 付与と0量失効は action-phase-resolver、sweepは
  // effect-action-group-resolver.absorber、プール合算・消費は shield-policy が検証する。
  APPLY_SHIELD: {
    ruleIds: ["R-ACTN-03", "R-SHD-01", "R-SHD-02"],
    testCaseIds: [
      "UT-R-SHD-01-001",
      "UT-R-SHD-01-003",
      "UT-R-SHD-01-010",
      "UT-R-SHD-01-014",
      "UT-R-SHD-01-018",
      "UT-R-SHD-02-001",
    ],
  },
  // 実ACTION stepからの除去とSHIELD/SUBUNITカテゴリは effect-action-group-resolver、
  // カテゴリ・maxRemovalsは effect-removal-service が検証する。
  REMOVE_EFFECTS: {
    ruleIds: ["R-ACTN-02", "R-EFF-02"],
    testCaseIds: [
      "UT-R-EFF-02-011",
      "UT-R-EFF-02-012",
      "UT-R-EFF-02-020",
      "UT-R-EFF-02-021",
      "UT-R-EFF-02-022",
      "UT-R-EFF-02-023",
    ],
  },
  // 免疫自体の付与・拒否経路・免疫への免疫を effect-action-group-resolver が検証する。
  EFFECT_IMMUNITY: {
    ruleIds: ["R-ACTN-03", "R-EFF-03"],
    testCaseIds: [
      "UT-R-EFF-03-011",
      "UT-R-EFF-03-012",
      "UT-R-EFF-03-013",
      "UT-R-EFF-03-015",
      "UT-R-EFF-03-016",
      "UT-R-EFF-03-018",
    ],
  },
  // ADD/KEEP_EXISTING/REFRESH/REPLACE/stack.maxは marker-apply-service、
  // 生存対象への実付与は effect-action-group-resolver が検証する。
  APPLY_MARKER: {
    ruleIds: ["R-ACTN-01", "R-ACTN-03", "R-EFF-10"],
    testCaseIds: [
      "UT-R-EFF-10-001",
      "UT-R-EFF-10-002",
      "UT-R-EFF-10-004",
      "UT-R-EFF-10-006",
      "UT-R-EFF-10-007",
      "UT-R-ACTN-01-005",
    ],
  },
  // 戦闘不能skip・実除去は effect-action-group-resolver、MarkerRemoved・
  // 親子カスケードは marker-removal-service が検証する。
  REMOVE_MARKER: {
    ruleIds: ["R-ACTN-01", "R-EFF-02", "R-EFF-10"],
    testCaseIds: [
      "UT-R-ACTN-01-003",
      "UT-R-ACTN-01-007",
      "UT-R-EFF-10-009",
      "UT-R-EFF-10-010",
      "UT-R-EFF-10-011",
    ],
  },
  // インスタンス選択・LETHAL_DAMAGE消費は defensive-intervention-policy、
  // survivalHp適用は damage-application-service.defensive-intervention が検証する。
  APPLY_DEATH_SURVIVAL: {
    ruleIds: ["R-ACTN-03", "R-INT-01"],
    testCaseIds: [
      "UT-R-INT-01-006",
      "UT-R-INT-01-007",
      "UT-R-INT-01-008",
      "UT-R-INT-01-011",
      "UT-R-INT-01-012",
      "UT-R-INT-01-013",
    ],
  },
  // appliesTo・戦闘不能先・付与順優先は defensive-intervention-policy、
  // DamageRedirectedは damage-application-service.defensive-intervention が検証する。
  APPLY_TARGET_REDIRECT: {
    ruleIds: ["R-ACTN-03", "R-INT-01"],
    testCaseIds: [
      "UT-R-INT-01-001",
      "UT-R-INT-01-002",
      "UT-R-INT-01-003",
      "UT-R-INT-01-004",
      "UT-R-INT-01-005",
      "UT-R-INT-01-010",
    ],
  },
  // 付与時coverer解決は action-phase-resolver、肩代わり・guardRateは
  // defensive-intervention-policy と damage-application-service が検証する。
  APPLY_COVER: {
    ruleIds: ["R-ACTN-03", "R-INT-01", "R-INT-02"],
    testCaseIds: [
      "UT-R-INT-02-001",
      "UT-R-INT-02-002",
      "UT-R-INT-02-003",
      "UT-R-INT-02-005",
      "UT-R-INT-02-010",
      "UT-R-INT-02-011",
    ],
  },
  // 付与順列挙・allowRecursiveReflect除外は defensive-intervention-policy、
  // ReflectedDamageGeneratedは damage-application-service が検証する。
  APPLY_REFLECT: {
    ruleIds: ["R-ACTN-03", "R-INT-01", "R-INT-03"],
    testCaseIds: [
      "UT-R-INT-03-001",
      "UT-R-INT-03-002",
      "UT-R-INT-03-010",
      "UT-R-INT-03-011",
      "UT-R-INT-03-012",
    ],
  },
  // 付与時linkTo解決は effect-action-group-resolver.heal、リンク発生・
  // 再リンク禁止は damage-application-service.defensive-intervention が検証する。
  APPLY_DAMAGE_LINK: {
    ruleIds: ["R-ACTN-03", "R-INT-01", "R-LNK-01", "R-LNK-02", "R-LNK-03"],
    testCaseIds: [
      "UT-R-LNK-01-001",
      "UT-R-LNK-01-002",
      "UT-R-LNK-01-003",
      "UT-R-LNK-02-010",
      "UT-R-LNK-02-011",
      "UT-R-LNK-03-010",
    ],
  },
  // 付与・耐久0即失効は action-phase-resolver、吸収・追加ダメージは
  // sub-unit-policy と damage-application-service.sub-unit が検証する。
  APPLY_SUBUNIT: {
    ruleIds: ["R-SUB-01", "R-SUB-02"],
    testCaseIds: [
      "UT-R-SUB-01-001",
      "UT-R-SUB-01-006",
      "UT-R-SUB-01-007",
      "UT-R-SUB-01-008",
      "UT-R-SUB-02-003",
      "UT-R-SUB-02-005",
    ],
  },
  // RESET/REDUCE/no-op/設定scope越えは cooldown-state と
  // cooldown-manipulation-application-service、実解決は
  // effect-action-group-resolver が検証する。
  COOLDOWN_MANIPULATION: {
    ruleIds: ["R-ACTN-01", "R-SKL-09"],
    testCaseIds: [
      "UT-R-SKL-09-005",
      "UT-R-SKL-09-006",
      "UT-COOLDOWN-014",
      "UT-COOLDOWN-017",
      "UT-COOLDOWN-021",
      "UT-R-ACTN-01-009",
    ],
  },
  // 付与時snapshotは effect-action-group-resolver.modifier、加算・無効上限・
  // 回避時非加算は damage-application-service が検証する（R-DMG-06）。
  APPLY_ATTACK_DAMAGE_BONUS: {
    ruleIds: ["R-DMG-06"],
    testCaseIds: [
      "UT-R-BON-ATTACK-DMG-001",
      "UT-R-BON-ATTACK-DMG-002",
      "UT-R-BON-ATTACK-DMG-003",
      "UT-R-BON-ATTACK-DMG-004",
    ],
  },
  // 付与は effect-action-group-resolver.modifier、ライダー捕捉は
  // damage-application-service.follow-up、追撃解決は follow-up-attack-service が検証する。
  APPLY_FOLLOW_UP_ATTACK: {
    ruleIds: ["R-FUP-01"],
    testCaseIds: [
      "UT-R-FUP-01-001",
      "UT-R-FUP-01-004",
      "UT-R-FUP-01-005",
      "UT-R-FUP-01-006",
      "UT-R-FUP-01-007",
      "UT-R-FUP-01-008",
    ],
  },
  // 付与は effect-action-group-resolver.resource、合成・負率・-100%下限は
  // action-resolution-shared、full stackは action-phase-resolver が検証する。
  APPLY_RESOURCE_GAIN_MOD: {
    ruleIds: ["R-ACT-04"],
    testCaseIds: [
      "UT-R-ACT-04-006",
      "UT-R-ACT-04-007",
      "UT-R-ACT-04-011",
      "UT-R-ACT-04-012",
      "UT-R-ACT-04-013",
      "UT-R-ACT-04-014",
    ],
  },
};
