import type { EffectActionDefinitionId, SkillDefinitionId } from "../definitions/catalog-ids.js";
import { isPointAdditiveStat, type ActionKind } from "../definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import {
  collectConditionEffectActionReferences,
  conditionContainsDamageMaxHpRatio,
} from "./condition-inspection.js";
import { durationOf } from "./effect-action-inspection.js";
import { validateConditionEffectActionReferences } from "./effect-sequence-integrity.js";

/**
 * 1つの`EffectActionDefinition`だけを見て判定できる検証。大別して2種類ある。
 *
 * - 参照の実在（`effectActionDefinitionIds`／`targetSkillDefinitionId`等）。
 * - 「schemaは受理するが実装が対応していない形」の拒否。どれも`EffectApplied`と
 *   しては成功するのに効果が一度も作用しないsilent partial implementationになるため、
 *   Catalogロード時点で拒否する。
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
    // R-PS-01: `DAMAGE_MAX_HP_RATIO`はtrigger条件（`TriggerDefinition.condition`）専用。
    // `expiration.conditions`は保持者スコープの特殊失効条件であり、この専用契約の
    // 対象外の配置としてロード時に拒否する（`counterUpdates[].trigger.condition`は
    // TriggerDefinitionそのものなので許可）。
    if (
      (duration.expiration?.conditions ?? []).some((condition) =>
        conditionContainsDamageMaxHpRatio(condition),
      )
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "DAMAGE_MAX_HP_RATIO_REQUIRES_TRIGGER",
        message: `a DAMAGE_MAX_HP_RATIO condition is trigger-scoped (TriggerDefinition.condition only) — expiration.conditions of "${effectAction.effectActionDefinitionId}" cannot declare it`,
      });
    }
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
  // R-STA-01「パーセントポイント加算ステータス」／Q-STA-04（Issue #460）: 会心率・
  // 会心ダメージボーナス・属性相性ボーナスはそれ自体がパーセンテージで表される値であり、
  // 補正もパーセンテージの加減算としてだけ与えられる。`RATIO`（基本値への割合乗算）を
  // 宣言すると「会心率20%へ会心率5%上昇が乗って21%」という別の式で黙って解決され、
  // 重複可のデバフほど乖離が拡大する。分類の正本（`isPointAdditiveStat`）は
  // `calculateCombatStat`の式分岐と共有しており、ドメイン側で正しく分岐しても
  // Catalog側で再発できる余地を残さないため投入時点でも拒否する。
  //
  // `RATIO`をこの3ステータスでは加算と解釈する設計は採らない — 同じ語が対象ステータスに
  // よって別の式を意味すると、Catalog投入時に定義を読んだだけでは結果を推測できなくなる。
  if (
    effectAction.kind === "APPLY_STAT_MOD" &&
    effectAction.payload.valueType === "RATIO" &&
    isPointAdditiveStat(effectAction.payload.stat)
  ) {
    violations.push({
      targetId: effectAction.effectActionDefinitionId,
      rule: "UNSUPPORTED_POINT_ADDITIVE_STAT_RATIO",
      message: `APPLY_STAT_MOD stat "${effectAction.payload.stat}" is a percentage-point additive stat (R-STA-01, Q-STA-04): corrections are added as percentage points, so valueType must be "FIXED", not "RATIO"`,
    });
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
  }
  // R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020、Issue #279）: 付与者の
  // 戦闘不能による解除は`marker-source-defeat-service.ts`が`MarkerState.sourceUnitId`
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
      if (effectAction.payload.redirectTo.kind !== "SELF") {
        unsupported(
          `APPLY_TARGET_REDIRECT only implements redirectTo {kind: "SELF"} (R-INT-01, DMG-006), received {kind: "${effectAction.payload.redirectTo.kind}"}`,
        );
      }
      requireDamageOnlyAppliesTo(effectAction.payload.appliesTo.actionKinds);
      return;
    }
    case "APPLY_COVER": {
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
