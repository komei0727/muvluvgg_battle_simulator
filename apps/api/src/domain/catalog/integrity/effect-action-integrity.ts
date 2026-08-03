import type { CapabilityDefinition } from "../capability/capability-definition.js";
import type {
  CapabilityId,
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../definitions/catalog-ids.js";
import type { ActionKind } from "../definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import {
  checkRequiredCapabilities,
  requireRuntimeCapability,
} from "./capability-declaration-integrity.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import { collectConditionEffectActionReferences } from "./condition-inspection.js";
import {
  durationOf,
  formulasOf,
  referencesMarkerCountScale,
  referencesSumDamageResult,
} from "./effect-action-inspection.js";
import { validateConditionEffectActionReferences } from "./effect-sequence-integrity.js";

/**
 * 1つの`EffectActionDefinition`だけを見て判定できる検証。大別して2種類ある。
 *
 * - 参照の実在（`effectActionDefinitionIds`／`targetSkillDefinitionId`等）。
 * - 「schemaは受理するが実装が対応していない形」の拒否。どれも`EffectApplied`と
 *   しては成功するのに効果が一度も作用しないsilent partial implementationになり、
 *   Capability（`IMPLEMENTED`）だけでは隔離できないため、Catalogロード時点で拒否する。
 *   併せて対応Capabilityの宣言も必須にする（`checkRequiredCapabilities`は列挙済み
 *   Capabilityの存在有無しか見ず、宣言漏れは素通りしてしまうため）。
 *
 * `validateEffectAction`はkind別の独立した節が並ぶ長い関数のままである。次の分割は
 * 「kind別ハンドラ表（`Record<kind, validator[]>`）へ展開する」形が候補だが、
 * `EffectActionDefinition`のkind別payload分解（`effect-action-group-resolver`側の
 * REF-015と同じ判断）と揃えるべきであり、そちらの結論が出るまで保留する。
 */
export function validateEffectAction(
  effectAction: EffectActionDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  // `ConditionDefinition`はSkill/Memory側だけでなく`DurationDefinition`にも2か所ある
  // （R-EFF-08の`expiration.conditions`と、EFF-005の`counterUpdates[].trigger.condition`）。
  // どちらも同じ評価器（`trigger-condition-evaluator.ts`）で解決されるため、参照検証も
  // 同じ規則で行わないと、存在しないIDを指す条件が常に偽のままロードを通ってしまう。
  const duration = durationOf(effectAction);
  if (duration !== undefined) {
    validateConditionEffectActionReferences(
      [
        ...(duration.expiration?.conditions ?? []).flatMap(collectConditionEffectActionReferences),
        ...(duration.counterUpdates ?? []).flatMap((counterUpdate) =>
          collectConditionEffectActionReferences(counterUpdate.trigger.condition),
        ),
      ],
      effectActions,
      effectAction.effectActionDefinitionId,
      violations,
    );
  }
  if (effectAction.kind === "EFFECT_IMMUNITY" || effectAction.kind === "REMOVE_EFFECTS") {
    for (const referencedId of effectAction.payload.effectActionDefinitionIds ?? []) {
      if (!effectActions.has(referencedId)) {
        violations.push({
          targetId: effectAction.effectActionDefinitionId,
          rule: "DANGLING_REFERENCE",
          message: `${effectAction.kind} payload.effectActionDefinitionIds references undefined EffectActionDefinition "${referencedId}"`,
        });
      }
    }
  }
  // R-SUB-02第3項（DMG-005、Issue #190、`SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`）:
  // 追加デバフは別のEffectActionDefinitionへの参照として書く。参照先が存在しない
  // 定義はロード時点で拒否し（`EFFECT_IMMUNITY`/`REMOVE_EFFECTS`の
  // `effectActionDefinitionIds`と同じ`DANGLING_REFERENCE`）、`APPLY_STAT_MOD`以外を
  // 指す定義も拒否する — 追加デバフの付与を実装しているのは
  // `effect-action-group-resolver.ts`の`grantSubUnitAdditionalDamageDebuffSteps`
  // だけで、その経路が扱えるのは`APPLY_STAT_MOD`（付与＋CombatStat再計算）である。
  // 対応kindが増えたときはこの検証と同時に広げ、Catalogが受理する形と実行できる形を
  // ずらさない（`MARKER`カテゴリのREMOVE_EFFECTSと同じ「黙ってno-opにしない」方針）。
  if (effectAction.kind === "APPLY_SUBUNIT") {
    const debuff = effectAction.payload.additionalDamage.debuff;
    if (debuff !== undefined) {
      const referenced = effectActions.get(debuff.effectActionDefinitionId);
      if (referenced === undefined) {
        violations.push({
          targetId: effectAction.effectActionDefinitionId,
          rule: "DANGLING_REFERENCE",
          message: `APPLY_SUBUNIT payload.additionalDamage.debuff references undefined EffectActionDefinition "${debuff.effectActionDefinitionId}"`,
        });
      } else if (referenced.kind !== "APPLY_STAT_MOD") {
        violations.push({
          targetId: effectAction.effectActionDefinitionId,
          rule: "TYPE_MISMATCH",
          message: `APPLY_SUBUNIT payload.additionalDamage.debuff must reference an APPLY_STAT_MOD EffectActionDefinition, but "${debuff.effectActionDefinitionId}" is a ${referenced.kind}`,
        });
      }
    }
  }
  // M7-001（Issue #181）: REMOVE_EFFECTSのSHIELD/SUBUNITカテゴリは解除対象の実行時
  // 状態を持つCapability（`CAP_SHIELD`=DMG-004、`CAP_SUBUNIT`=DMG-005）へ依存する。
  // Catalog自体は正しく宣言されていればロードでき（依存先Capabilityが`PLANNED`へ
  // 差し戻された場合でも）、実際の拒否は選択時の`SimulationPreflightValidator`
  // （`findUnimplementedCapabilities`）が`UNSUPPORTED_RULE`として行う — Catalog全体の
  // ロード失敗にはしない。
  if (effectAction.kind === "REMOVE_EFFECTS") {
    // `14_Catalog定義スキーマ.md`「REMOVE_EFFECTSを使うEffectActionDefinitionは
    // requiredCapabilitiesにCAP_REMOVE_EFFECTSを含めること」: categoriesの内容に
    // よらず、REMOVE_EFFECTS自体の宣言を無条件で必須にする。SHIELD/SUBUNIT固有の
    // CAP_SHIELD/CAP_SUBUNIT宣言はこれとは独立な追加要件（両方とも要求されうる）。
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_REMOVE_EFFECTS")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: 'REMOVE_EFFECTS must declare "CAP_REMOVE_EFFECTS" in requiredCapabilities',
      });
    }
    if (
      effectAction.payload.categories.includes("SHIELD") &&
      !effectAction.requiredCapabilities.some((id) => id === "CAP_SHIELD")
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'REMOVE_EFFECTS with the "SHIELD" category must declare "CAP_SHIELD" in requiredCapabilities',
      });
    }
    if (
      effectAction.payload.categories.includes("SUBUNIT") &&
      !effectAction.requiredCapabilities.some((id) => id === "CAP_SUBUNIT")
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'REMOVE_EFFECTS with the "SUBUNIT" category must declare "CAP_SUBUNIT" in requiredCapabilities',
      });
    }
  }
  // M7-001B（Issue #243、EFFECT_IMMUNITY_STATUS_GRANULARITY）: `statusKinds`は
  // `CAP_SPECIFIC_IMMUNITY`（個別状態異常無効）そのものの機能なので、使用時は
  // `CAP_REMOVE_EFFECTS`と同じ「宣言漏れ自体を拒否する」パターンで宣言を必須に
  // する。`statusKinds`を使わない（STATUSカテゴリ全体を対象にする）既存の
  // `EFFECT_IMMUNITY`はこの新しいCapabilityを要求しない。
  if (effectAction.kind === "EFFECT_IMMUNITY") {
    if (
      effectAction.payload.statusKinds !== undefined &&
      !effectAction.requiredCapabilities.some((id) => id === "CAP_SPECIFIC_IMMUNITY")
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'EFFECT_IMMUNITY with "statusKinds" must declare "CAP_SPECIFIC_IMMUNITY" in requiredCapabilities',
      });
    }
  }
  // Issue #129: COOLDOWN_MANIPULATIONの対象スキル存在チェック。所有者一致は
  // `checkCooldownManipulationOwnership`（Unit視点でのみ判定可能）が担う。
  if (effectAction.kind === "COOLDOWN_MANIPULATION") {
    if (!skills.has(effectAction.payload.targetSkillDefinitionId)) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "DANGLING_REFERENCE",
        message: `COOLDOWN_MANIPULATION payload.targetSkillDefinitionId references undefined SkillDefinition "${effectAction.payload.targetSkillDefinitionId}"`,
      });
    }
    // `14_Catalog定義スキーマ.md`は`CAP_COOLDOWN_MANIPULATION`をrequiredCapabilitiesへ
    // 含めることを必須としているが、`checkRequiredCapabilities`は列挙済みCapabilityの
    // 存在有無しか検証しないため、指定漏れ自体は別途検証する。
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_COOLDOWN_MANIPULATION")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: `COOLDOWN_MANIPULATION must declare "CAP_COOLDOWN_MANIPULATION" in requiredCapabilities`,
      });
    }
  }
  // EFF-001はAppliedEffectレジストリ・EffectApplied・StateDeltaだけを実装し、
  // CombatStat再計算（R-EFF-05/R-STA-02〜04、EFF-002のスコープ）は行わない。
  // `APPLY_STAT_MOD`をこの状態でresolverへ到達させると、効いていない補正を
  // `EffectActionCompleted.resultKind: "APPLIED"`として成功扱いにしてしまう。
  // production Catalogの全行へ`CAP_STAT_MOD`を後付けしただけでは、宣言漏れの
  // 新規/カスタムCatalogがこの検証をすり抜けてしまうため、
  // `COOLDOWN_MANIPULATION`/`CAP_COOLDOWN_MANIPULATION`と同じ「宣言漏れ自体を
  // 拒否する」検証をkindレベルで強制する。
  if (effectAction.kind === "APPLY_STAT_MOD") {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_STAT_MOD")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: `APPLY_STAT_MOD must declare "CAP_STAT_MOD" in requiredCapabilities`,
      });
    }
  }
  // `CAP_RESOURCE_MUTATION`（ADD/SET/SET_TO_MAX）のIMPLEMENTED状態が、当時未実装
  // だった`operation: DISTRIBUTE`まで安全であるかのように誤読されないよう、
  // DISTRIBUTE使用箇所には専用の`CAP_RESOURCE_DISTRIBUTE`を必須宣言させる。
  // M7-017（Issue #271）で`CAP_RESOURCE_DISTRIBUTE`はIMPLEMENTEDになったが、宣言
  // そのものは`COOLDOWN_MANIPULATION`/`APPLY_STAT_MOD`（同じくIMPLEMENTED）と同じ
  // 「宣言漏れ自体を拒否する」パターンで引き続き強制する — 分配セマンティクスを
  // 使う定義がCatalog上で常に自己申告され、Capability台帳から追跡できる状態を保つ。
  if (effectAction.kind === "MODIFY_RESOURCE" && effectAction.payload.operation === "DISTRIBUTE") {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_RESOURCE_DISTRIBUTE")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'MODIFY_RESOURCE with operation "DISTRIBUTE" must declare "CAP_RESOURCE_DISTRIBUTE" in requiredCapabilities',
      });
    }
  }
  // G-09（M7-002A／Issue #255）: `MODIFY_RESOURCE_CAPACITY`は`MODIFY_RESOURCE`
  // （現在値の一回限りの加減算、`CAP_RESOURCE_MUTATION`）とは別に上限そのものを
  // 期間付きで変える。`APPLY_STAT_MOD`/`CAP_STAT_MOD`と同じ「宣言漏れ自体を
  // 拒否する」パターンで、この意味を使う定義がCatalog上で常に自己申告され
  // Capability台帳から追跡できる状態を保つ。
  if (effectAction.kind === "MODIFY_RESOURCE_CAPACITY") {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_RESOURCE_CAPACITY_MOD")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: `MODIFY_RESOURCE_CAPACITY must declare "CAP_RESOURCE_CAPACITY_MOD" in requiredCapabilities`,
      });
    }
  }
  // R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003／Issue #196）: 防御貫通を宣言する
  // 定義は`CAP_PARTIAL_PIERCING`を自己申告する。`DAMAGE`の静的な
  // `payload.piercing`（いずれかの率が非0）と、一時付与の`APPLY_PIERCING_MOD`
  // （factoryが全率0を拒否済み）の両方が対象で、`MODIFY_RESOURCE_CAPACITY`/
  // `CAP_RESOURCE_CAPACITY_MOD`と同じ「宣言漏れ自体を拒否する」パターンである。
  const declaresPiercing =
    effectAction.kind === "APPLY_PIERCING_MOD" ||
    (effectAction.kind === "DAMAGE" &&
      Object.values(effectAction.payload.piercing).some((rate) => rate !== 0));
  if (
    declaresPiercing &&
    !effectAction.requiredCapabilities.some((id) => id === "CAP_PARTIAL_PIERCING")
  ) {
    violations.push({
      targetId: effectAction.effectActionDefinitionId,
      rule: "MISSING_REQUIRED_CAPABILITY",
      message: `${effectAction.kind} that ignores defense/shield/damage-reduction must declare "CAP_PARTIAL_PIERCING" in requiredCapabilities`,
    });
  }
  // RES-003A（Issue #257、G-10）: `SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`
  // （EffectSequence実行中の累計）は`formula-evaluator.ts`の`DamageResultRegistry`へ
  // `SkillUseId`（=1回のEffectSequence解決）単位で配線済みで、
  // `CAP_SUM_DAMAGE_RESULT`は`IMPLEMENTED`である。宣言そのものは
  // `COOLDOWN_MANIPULATION`/`CAP_COOLDOWN_MANIPULATION`と同じ「宣言漏れ自体を
  // 拒否する」パターンで必須にする — 宣言はCapability→定義の追跡可能性そのもので
  // あり、将来`SUM_*`の対応範囲が狭まった場合に`SimulationPreflightValidator`が
  // 該当定義を隔離する足場にもなる。なお`verification.productionDefinitionIds`は
  // 他のCapabilityと同じく代表証跡であり（例: `CAP_CONTINUOUS_HEAL`はproduction
  // 13件中1件のみ）、この検証が証跡一覧との一致を保証するわけではない。
  if (formulasOf(effectAction).some(referencesSumDamageResult)) {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_SUM_DAMAGE_RESULT")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'a FormulaDefinition referencing "SUM_DAMAGE_DEALT"/"SUM_DAMAGE_RECEIVED" must declare "CAP_SUM_DAMAGE_RESULT" in requiredCapabilities',
      });
    }
  }
  // M7-015（Issue #269、R-NUM-04「`MARKER_COUNT_SCALE`は評価時点の
  // `MarkerState.stackCount`を参照する」）: `MARKER_COUNT_SCALE`はMarker本体
  // （`CAP_MARKER`）とは別のCapability `CAP_MARKER_STACK_FORMULA`が担当する
  // — Markerを付与する定義とMarker所持数を読む定義は別物で、後者だけを持つ
  // 定義（`ACT_FEE_BATH_AS2_DAMAGE`のように付与は別EffectActionが行う）も
  // 実在する。`CAP_SUM_DAMAGE_RESULT`と同じ「宣言漏れ自体を拒否する」
  // パターンで宣言を必須にし、Capability→定義の追跡可能性を保つ。宣言があれば
  // 実際の可否判定は選択時の`SimulationPreflightValidator`が行い、Catalogロード
  // 自体は失敗させない。
  if (formulasOf(effectAction).some(referencesMarkerCountScale)) {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_MARKER_STACK_FORMULA")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'a FormulaDefinition referencing "MARKER_COUNT_SCALE" must declare "CAP_MARKER_STACK_FORMULA" in requiredCapabilities',
      });
    }
  }
  // R-HEAL-03（M7-005、Issue #184）: `continuous-heal-service.ts`は
  // `timing: {eventType: "ActionStarted", targetSelector: "EFFECT_OWNER"}`
  // （production Catalogの継続回復13件がすべて使う唯一の組み合わせ）だけを
  // 発火させる。`timing`はスキーマ上任意の文字列を取れるため、他の組み合わせを
  // 指定した定義は`CAP_CONTINUOUS_HEAL`（IMPLEMENTED）を宣言していても
  // 「`EffectApplied`として成功するが一度も回復しない」silent partial
  // implementationになる。`APPLY_MARKER`の未対応Duration
  // （`UNSUPPORTED_MARKER_DURATION`）と同じく、Catalogロード時点で拒否する。
  if (effectAction.kind === "APPLY_CONTINUOUS_HEAL") {
    const timing = effectAction.payload.timing;
    if (timing.eventType !== "ActionStarted" || timing.targetSelector !== "EFFECT_OWNER") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_CONTINUOUS_HEAL_TIMING",
        message: `APPLY_CONTINUOUS_HEAL only implements timing {eventType: "ActionStarted", targetSelector: "EFFECT_OWNER"} (R-HEAL-03, M7-005), received {eventType: "${timing.eventType}", targetSelector: "${timing.targetSelector}"}`,
      });
    }
  }
  // R-DOT-01（DMG-008、Issue #189）「付与対象の行動開始時に発生する」: 継続ダメージが
  // 発生するのは保持者自身の`ActionStarted`だけである。`timing`はスキーマ上任意の
  // 文字列を取れるため、他の組み合わせを指定した定義は`CAP_CONTINUOUS_DAMAGE`
  // （IMPLEMENTED）を宣言していても「`EffectApplied`として成功するが一度も
  // ダメージを与えない」silent partial implementationになる。
  if (effectAction.kind === "APPLY_CONTINUOUS_DAMAGE") {
    const timing = effectAction.payload.timing;
    if (timing.eventType !== "ActionStarted" || timing.targetSelector !== "EFFECT_OWNER") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_CONTINUOUS_DAMAGE_TIMING",
        message: `APPLY_CONTINUOUS_DAMAGE only implements timing {eventType: "ActionStarted", targetSelector: "EFFECT_OWNER"} (R-DOT-01, DMG-008), received {eventType: "${timing.eventType}", targetSelector: "${timing.targetSelector}"}`,
      });
    }
  }
  // R-HEAL-04（`M7-005-HEAL-LINK`、Issue #229）: 回復リンクの転送先は付与時点に
  // 解決して`AppliedEffect.healingLink`へ焼き込む。`heal-application-service.ts`は
  // 回復適用時にそのユニットIDしか参照しないため、付与時点で確定しない
  // `TargetReference`（`TRIGGER_*`/`BINDING`/`LAST_*`）は「`EffectApplied`として
  // 成功するが転送先が決まらない」silent partial implementationになる。
  if (effectAction.kind === "APPLY_HEALING_LINK") {
    if (effectAction.payload.transferTo.kind !== "SELF") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET",
        message: `APPLY_HEALING_LINK only implements transferTo {kind: "SELF"} (R-HEAL-04, M7-005-HEAL-LINK), received {kind: "${effectAction.payload.transferTo.kind}"}`,
      });
    }
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_HEALING_LINK")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: 'APPLY_HEALING_LINK must declare "CAP_HEALING_LINK" in requiredCapabilities',
      });
    }
  }
  collectDefensiveInterventionViolations(effectAction, violations);
  // `marker-duration.ts`はACTION/TURN単位のDuration減算だけを実装する（`BATTLE`は
  // 本来減算不要のため対象外扱いで問題ない）。`consumption`（消費条件）・
  // `expiration`（特殊失効条件）・`HIT`/`SKILL_USE`単位の`timeLimit`はschema上
  // `APPLY_MARKER`へ設定できてしまうが、実装が存在しないため、指定してもMarkerが
  // 消費・失効しないまま`CAP_MARKER`（`IMPLEMENTED`）がpreflightを素通りさせて
  // しまう。対応するまでCatalogロード時点で明示的に拒否する。
  if (effectAction.kind === "APPLY_MARKER") {
    const markerDuration = effectAction.payload.duration;
    if (markerDuration.consumption !== undefined) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message:
          "APPLY_MARKER.duration.consumption is not yet supported: Marker consumption (R-EFF-07 equivalent) is not implemented (marker-duration.ts)",
      });
    }
    if (markerDuration.expiration !== undefined) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message:
          "APPLY_MARKER.duration.expiration is not yet supported: Marker special expiration conditions (R-EFF-08 equivalent) are not implemented",
      });
    }
    if (
      markerDuration.timeLimit !== undefined &&
      markerDuration.timeLimit.unit !== "ACTION" &&
      markerDuration.timeLimit.unit !== "TURN" &&
      markerDuration.timeLimit.unit !== "BATTLE"
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message: `APPLY_MARKER.duration.timeLimit.unit "${markerDuration.timeLimit.unit}" is not yet supported: only ACTION/TURN decrement and BATTLE (no decrement) are implemented (marker-duration.ts)`,
      });
    }
    // EFF-005/Issue #162: `AppliedEffect`スコープのRuntimeCounter更新
    // （`counterUpdates`）はschema上`APPLY_MARKER`へも設定できてしまうが、
    // `MarkerState`の期間機構自体（consumption/expiration/HIT・SKILL_USE単位
    // timeLimit）が上と同じ理由で未実装のため、counterUpdatesだけを宣言しても
    // 更新もexpiration評価も行われない。
    if (markerDuration.counterUpdates !== undefined && markerDuration.counterUpdates.length > 0) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message:
          "APPLY_MARKER.duration.counterUpdates is not yet supported: Marker RuntimeCounter (R-EFF-11 AppliedEffect scope) requires Marker expiration, which is not implemented",
      });
    }
  } else if (duration !== undefined && (duration.counterUpdates ?? []).length > 0) {
    requireRuntimeCapability(
      effectAction.effectActionDefinitionId,
      effectAction.requiredCapabilities,
      "CAP_EFFECT_RUNTIME_COUNTER",
      "EffectActionDefinition duration.counterUpdates",
      violations,
    );
  }
  // R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020、Issue #279）: 付与者の
  // 戦闘不能による解除は`marker-source-defeat-service.ts`が`MarkerState.sourceId`
  // （直近の付与者）を見て判定する。`AppliedEffect`側には同じ判定を行う失効機構が
  // 無いため（`expiration.conditions`にもユニットの戦闘不能を判定するkindが
  // 存在しない）、`APPLY_MARKER`以外へ宣言すると「付与自体は成功するのに付与者が
  // 倒れても何も起きない」silent partial implementationになる。
  if (duration?.removeOnSourceDefeated === true && effectAction.kind !== "APPLY_MARKER") {
    violations.push({
      targetId: effectAction.effectActionDefinitionId,
      rule: "UNSUPPORTED_SOURCE_DEFEATED_REMOVAL",
      message: `duration.removeOnSourceDefeated is only supported on APPLY_MARKER (R-EFF-10, M7-020): AppliedEffect has no source-defeat expiration mechanism, received kind "${effectAction.kind}"`,
    });
  }
  // R-EFF-12（`DYNAMIC_DURATION_ON_REAPPLY`、M7-014、Issue #268）: 再付与時の動的
  // 期間を解決するのは`resolveDurationOnReapply`（`effect-grant-service.ts`）を
  // 通る付与経路だけである。`APPLY_MARKER`は`marker-apply-service.ts`が
  // `stack.policy`（R-EFF-10）で再付与を解決してこの経路を通らず、FREEZEは
  // R-STS-03「再付与時に期間延長や増幅率加算を行わない」により
  // `grantFreezeStatus`が既存インスタンスをそのまま返す。どちらも`reapply`を
  // 宣言できてしまうと「付与自体は成功するのに期間だけ差し替わらない」silent
  // partial implementationになる。
  if (duration?.reapply !== undefined) {
    if (effectAction.kind === "APPLY_MARKER") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_DYNAMIC_DURATION_REAPPLY",
        message:
          "APPLY_MARKER.duration.reapply is not supported: Marker re-application is resolved by stack.policy (R-EFF-10, marker-apply-service.ts), not by resolveDurationOnReapply",
      });
    }
    if (effectAction.kind === "APPLY_STATUS" && effectAction.payload.status === "FREEZE") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_DYNAMIC_DURATION_REAPPLY",
        message:
          'APPLY_STATUS status "FREEZE" duration.reapply is not supported: freeze re-application is a no-op (R-STS-03, freeze-grant-service.ts), so the dynamic duration would never be evaluated',
      });
    }
  }
  checkRequiredCapabilities(
    effectAction.requiredCapabilities,
    effectAction.effectActionDefinitionId,
    capabilities,
    violations,
  );
}

/**
 * R-INT-01〜03（DMG-006、Issue #188）: 防御介入系4kindが実装済みの形だけを宣言している
 * ことを検証する。実装は次に限られ、いずれもproduction Catalogの全行がこの形である。
 *
 * - `APPLY_TARGET_REDIRECT.redirectTo` / `APPLY_COVER.coverer`: `SELF`（付与時点で
 *   解決してインスタンスへ焼き込む、`APPLY_HEALING_LINK.transferTo`と同じ制限）
 * - `APPLY_TARGET_REDIRECT.appliesTo.actionKinds` / `APPLY_COVER.appliesTo.actionKinds`:
 *   `["DAMAGE"]`。R-INT-01が介入の評価点として定めるのは`DamageWillBeApplied`の後だけで
 *   あり、`damage-application-service.ts`も`"DAMAGE"`でしか介入解決を呼ばない。
 *   `DEBUFF`を含む宣言は「`EffectApplied`として成功するがデバフ付与には一度も作用
 *   しない」silent no-opになり、`ANY`も同じ理由でDAMAGE以外には作用しない
 * - `APPLY_COVER.damageShareRate`: `1`（R-INT-02第1項「防御側を肩代わり者へ変更する」。
 *   1未満は1ヒットを2体へ分割適用することになり、R-INT-02が規定しない）
 * - `APPLY_REFLECT.reflectTo`: `TRIGGER_SOURCE`（R-INT-03の反射先＝元ダメージの攻撃者）
 * - `APPLY_REFLECT.allowRecursiveReflect`: `false`（R-INT-03第2項「反射からさらに
 *   反射を発生させない」）
 * - `APPLY_DEATH_SURVIVAL.trigger.lethalDamageOnly`: `true`（R-INT-01 #5の致死耐えは
 *   HPが0へ落ちる量が確定した時点でだけ成立する）
 */
function collectDefensiveInterventionViolations(
  effectAction: EffectActionDefinition,
  violations: CatalogIntegrityViolation[],
): void {
  const targetId = effectAction.effectActionDefinitionId;
  const requireCapability = (capabilityId: string): void => {
    if (!effectAction.requiredCapabilities.some((id) => id === capabilityId)) {
      violations.push({
        targetId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: `${effectAction.kind} must declare "${capabilityId}" in requiredCapabilities`,
      });
    }
  };
  const unsupported = (message: string): void => {
    violations.push({ targetId, rule: "UNSUPPORTED_DEFENSIVE_INTERVENTION", message });
  };
  const requireDamageOnlyAppliesTo = (actionKinds: readonly ActionKind[]): void => {
    if (actionKinds.some((kind) => kind !== "DAMAGE")) {
      unsupported(
        `${effectAction.kind} only implements appliesTo.actionKinds ["DAMAGE"] (R-INT-01 evaluates defensive interventions after DamageWillBeApplied only, DMG-006), received [${actionKinds.join(", ")}]`,
      );
    }
  };

  switch (effectAction.kind) {
    case "APPLY_TARGET_REDIRECT": {
      requireCapability("CAP_TARGET_REDIRECT");
      if (effectAction.payload.redirectTo.kind !== "SELF") {
        unsupported(
          `APPLY_TARGET_REDIRECT only implements redirectTo {kind: "SELF"} (R-INT-01, DMG-006), received {kind: "${effectAction.payload.redirectTo.kind}"}`,
        );
      }
      requireDamageOnlyAppliesTo(effectAction.payload.appliesTo.actionKinds);
      return;
    }
    case "APPLY_COVER": {
      requireCapability("CAP_COVER_DAMAGE");
      requireDamageOnlyAppliesTo(effectAction.payload.appliesTo.actionKinds);
      if (effectAction.payload.coverer.kind !== "SELF") {
        unsupported(
          `APPLY_COVER only implements coverer {kind: "SELF"} (R-INT-02, DMG-006), received {kind: "${effectAction.payload.coverer.kind}"}`,
        );
      }
      if (effectAction.payload.damageShareRate !== 1) {
        unsupported(
          `APPLY_COVER only implements damageShareRate 1 (R-INT-02 replaces the defender itself; a partial share would split one hit across two defenders, which R-INT-02 does not define), received ${effectAction.payload.damageShareRate}`,
        );
      }
      return;
    }
    case "APPLY_REFLECT": {
      requireCapability("CAP_REFLECT_DAMAGE");
      if (effectAction.payload.reflectTo.kind !== "TRIGGER_SOURCE") {
        unsupported(
          `APPLY_REFLECT only implements reflectTo {kind: "TRIGGER_SOURCE"} (R-INT-03, DMG-006), received {kind: "${effectAction.payload.reflectTo.kind}"}`,
        );
      }
      if (effectAction.payload.allowRecursiveReflect) {
        unsupported(
          'APPLY_REFLECT only implements allowRecursiveReflect false (R-INT-03 "反射からさらに反射を発生させない")',
        );
      }
      return;
    }
    case "APPLY_DAMAGE_LINK": {
      // R-INT-01 #3／R-LNK-01〜03（DMG-007、Issue #187）。`linkTo`は付与時点で
      // `AppliedEffect.damageLink.linkToUnitId`（単一ユニット）へ焼き込むため、
      // その時点で高々1体へ解決できる参照だけを実装する。`SELF`は付与者、
      // `BINDING`は同じEffectSequenceが解決済みのTargetBindingであり、どちらも
      // 付与時点に確定している。`TRIGGER_SOURCE`/`TRIGGER_TARGET`/`LAST_*`は
      // 付与時点のcontextに残っていないか複数体になりうるため受け付けない
      // （`APPLY_HEALING_LINK.transferTo`が`SELF`だけなのと同じ理由）。
      requireCapability("CAP_DAMAGE_LINK_STATE");
      if (
        effectAction.payload.linkTo.kind !== "SELF" &&
        effectAction.payload.linkTo.kind !== "BINDING"
      ) {
        unsupported(
          `APPLY_DAMAGE_LINK only implements linkTo {kind: "SELF"} and {kind: "BINDING"} (R-LNK-01/02 resolve the destination at grant time, DMG-007), received {kind: "${effectAction.payload.linkTo.kind}"}`,
        );
      }
      return;
    }
    case "APPLY_DEATH_SURVIVAL": {
      requireCapability("CAP_DEATH_SURVIVAL");
      if (!effectAction.payload.trigger.lethalDamageOnly) {
        unsupported(
          "APPLY_DEATH_SURVIVAL only implements trigger.lethalDamageOnly true (R-INT-01 #5 resolves the survival at the moment HP would reach 0)",
        );
      }
      return;
    }
    default:
      return;
  }
}
