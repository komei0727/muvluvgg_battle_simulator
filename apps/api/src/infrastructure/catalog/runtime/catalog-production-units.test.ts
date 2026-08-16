import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCatalogFromDirectory } from "./catalog-file-loader.js";
import { allProductionUnitIds } from "../../../testing/scenario/run-production-battle.js";

/**
 * Issue #46: promotes the retired Issue #41/#44 pilot fixture to the
 * production Catalog candidate at `catalog/`
 * (apps/api package root, per `docs/ddd/14_Catalog定義スキーマ.md`). These tests lock in
 * the conversion-mistake fixes found while re-checking raw/units/ against
 * the pilot fixture, so a future edit to `catalog/` cannot silently
 * reintroduce them.
 */

function catalogPath(): string {
  return fileURLToPath(new URL("../../../../catalog", import.meta.url));
}

describe("Catalog v2 production candidate: 10-unit promotion (Issue #46)", () => {
  it("IT-CAT-PROD-001: loads all 10 units from catalog/ without an integrity violation", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    // Issue #159 (EFF-003): `CAP_STAT_MOD`/`CAP_COMPLEX_EXPIRATION` flipped to
    // IMPLEMENTED once ACTION/TURN duration decrement, consumption, special
    // expiration, and linkedEffectGroup cascade (R-EFF-04/06/07/08/09) wired
    // the real lifecycle (`capabilities.json`; 実データ経路は
    // `IT-UNIT-DOROTHEA-PIONEER-005`／`IT-UNIT-CLARA-TSUNDERE-004`／
    // `IT-UNIT-KARINA-DOWNER-006`／`IT-UNIT-SIENA-DIVA-006`／`IT-UNIT-FEE-ACTOR-005`／
    // `IT-UNIT-HARRIET-SAGE-004`〜`005`。当時の証跡だった
    // `IT-CAP-COMPLEX-EXPIRATION-PROD-001〜003` は REF-041／Issue #388 で retire した).
    // Issue #160 (EFF-004):
    // `CAP_MARKER` flipped to IMPLEMENTED once MarkerState stack policies and
    // ACTION/TURN duration expiration (R-EFF-10) wired the real lifecycle
    // (`UT-R-EFF-10-*`; 実データ経路は `IT-UNIT-AOI-ELEGANT-004`。当時の証跡だった
    // `IT-MARKER-PROD-001〜002` は REF-025／Issue #354 で retire した).
    // RES-001 (Issue #175):
    // `CAP_FORMULA` flipped to IMPLEMENTED once the general FormulaEvaluator
    // wired the real lifecycle (当時の証跡だった `IT-CAP-FORMULA-PROD-001〜004` は
    // REF-039／Issue #386 でユニット効果軸へ移送して retire した。実データ経路は
    // `IT-UNIT-FLUTE-VAMPIRE-001`・`IT-UNIT-AOI-ELEGANT-001`・
    // `IT-UNIT-LAURA-MOUNTAIN-001`・`IT-UNIT-AOI-GUARDIAN-001`・
    // `IT-UNIT-STELLA-STATUE-001`). Issue #217:
    // `SKL_JULIE_SNOW_PS2`/`SKL_MAO_COMMITTEE_PS1` corrected from a misused
    // `LAST_ACTION_TARGETS` (no preceding EffectAction result in their own
    // EffectSequence, R-SKL-08) to `TRIGGER_TARGET` (the actually-intended
    // "the AS/EX that triggered me" target, per raw/units/ design source).
    // RES-005 (Issue #172): `CAP_TRIGGER_CONTEXT` flipped to IMPLEMENTED once
    // `TRIGGER_SOURCE`/`TRIGGER_TARGET` effect-target resolution
    // (`skill-resolution-service.ts`/`target-selection-policy.ts`) and the
    // `HitPointReduced` basic pipeline event wired the real lifecycle
    // (`IT-UNIT-SUIRAN-CHAOS-004`, `SKL_SUIRAN_CHAOS_PS3`). Both of
    // `SKL_JULIE_SNOW_PS2`/`SKL_MAO_COMMITTEE_PS1` still require other
    // not-yet-implemented capabilities of their own before they fully
    // activate. Issue #170 (TGT-001):
    // `CAP_TARGET_DERIVED_AREA` flipped to IMPLEMENTED once `TargetSelectorDefinition`
    // `kind: BINDING_DERIVED` (`base`: SELF/BINDING) and `area` (ADJACENT_ORTHOGONAL,
    // DIRECTLY_AHEAD_OF_BASE, BEHIND_BASE, SAME_ROW_AS_BASE, SAME_COLUMN_AS_BASE,
    // R-TGT-04/05) plus `order` FARTHEST (R-TGT-03) and FRONT_ROW/BACK_ROW (R-TGT-06)
    // wired the real lifecycle (`IT-UNIT-LUCIE-MAID-004`).
    // RES-004 (Issue #171後半): `CAP_EFFECT_STEP_CONDITION` flipped to IMPLEMENTED
    // once ACTION step conditions referencing their own `target` (TARGET_STATE/
    // TARGET_HAS_MARKER) are evaluated per-target, always deferred to JIT
    // resolution time (`isEagerActionStep`) so a self-referencing condition sees
    // the state left by earlier steps and by this step's own `EffectStepStarting`
    // chain, not a stale pre-sequence/pre-timing-event snapshot
    // (`effect-step-condition-evaluator.ts`'s `EffectStepTargetContext`,
    // `skill-resolution-service.ts`'s `buildEffectStepPerTargetFilter`), wiring
    // the real lifecycle for `SKL_AOI_ELEGANT_EX`/`SKL_LUCIE_MAID_AS1`/
    // `SKL_LUCIE_MAID_PS2`/`SKL_ROSIE_ARTIST_PS2` (originally `IT-CAP-EFFSTEP-001〜004`,
    // migrated to the unit-effect axis by REF-036/Issue #383 —
    // `IT-UNIT-AOI-ELEGANT-005`/`IT-UNIT-LUCIE-MAID-006`/`007`, and the
    // `SKL_ROSIE_ARTIST_PS2` split is carried by `IT-UNIT-ROSIE-ARTIST-001`).
    // This capability's completion boundary is
    // narrowed to exclude "集合条件" (set-threshold) — no ConditionKind exists
    // for it yet, so it isn't part of what `IMPLEMENTED` claims here. It becomes
    // its own Capability entry once a concrete schema-supported design exists.
    // RES-004集合条件 (Issue #227): added that Capability, `CAP_EFFECT_STEP_SET_CONDITION`,
    // backed by the new `ConditionDefinition.kind: TARGET_SET_COUNT` and its
    // wiring into the EffectStep condition evaluator (ACTION/BRANCH). No
    // production Skill uses it yet (`SKL_LYDIA_GENIUS_AS1`/`SKL_ELENA_MOODMAKER_AS1`
    // need it in their AS `activationCondition`, `CAP_ACTION_ACTIVATION_CONDITION`
    // scope, handed off to #180/M7-003), so it stays `runtimeStatus: PLANNED`.
    // Mixing TARGET_SET_COUNT with a TARGET_STATE/TARGET_HAS_MARKER
    // that references an ACTION step's own target is now rejected outright
    // (`MIXED_STEP_TARGET_SET_CONDITION`) rather than runtime-quantified, since no
    // single-boolean reduction satisfied both the per-target and set-wide contracts.
    // Broadened to reject regardless of which TargetReference the TARGET_STATE/
    // TARGET_HAS_MARKER names (the TARGET_SET_COUNT-only runtime path has no
    // per-target context either way) and to cover BRANCH's own condition too.
    // Bumped again by Issue #225's unrelated catalog-src change (SKL_TATIANA_SAGE_EX).
    // Bumped again by TGT-002 (Issue #169): filter/order runtime evaluation lands,
    // resolving the 18 approximated catalog-src rows across 14 units that needed it.
    // Bumped again by M7-001B (Issue #243, EFFECT_IMMUNITY_STATUS_GRANULARITY):
    // `EFFECT_IMMUNITY.statusKinds` lands, resolving the UNIT_AOI_GUARDIAN/
    // UNIT_HIIRO_LONEWOLF approximated STUN-immunity rows to their precise form
    // and flipping `CAP_SPECIFIC_IMMUNITY` to IMPLEMENTED. The new
    // `CAP_STATUS_EFFECT_KIND` capability (still PLANNED) now gates
    // UNIT_LAYLA_ENTREPRENEUR's APPLY_STATUS(DAMAGE_IMMUNITY/GUARANTEED_HIT)
    // rows — previously mistagged with `CAP_SPECIFIC_IMMUNITY`, which kept the
    // unit unselectable only by accident; completing that capability would
    // otherwise have made it newly `selectable` while its APPLY_STATUS kinds
    // beyond STEALTH are still unimplemented (E2E-GOLDEN regression).
    // Bumped again by M7-001C (Issue #244): the remaining REMOVE_BUFF_CATEGORY
    // rows (UNIT_NOEL_RUMBLE PS2, UNIT_SHOUKA_SCHEMER EX/AS3, UNIT_SENKA_CHRISTMAS
    // PS2) convert to REMOVE_EFFECTS(categories:["BUFF"]); none of these units are
    // among the 10 promoted here, so `unitCount`/violation expectations are unaffected.
    // Bumped again by the same PR's re-review fix: CAP_REMOVE_EFFECTS's
    // verification.testCaseIds gained IT-REMOVE-EFFECTS-PROD-006/007.
    // Bumped again by M7-001D (Issue #247): new CAP_TRIGGER_PAYLOAD_IN_RESOLUTION
    // capability and UNIT_TARISA_TROUBLEMAKER's SKL_TARISA_TROUBLEMAKER_PS1
    // conversion; Tarisa is not among the 10 units promoted here either.
    // Bumped again by the same PR's re-review fix: CAP_TRIGGER_PAYLOAD_IN_RESOLUTION's
    // description/verification.testCaseIds gained targetCondition support and
    // UT-R-SKL-06-055/UT-CAT-IDX-080.
    // Bumped again by the same PR's second re-review fix: verification.testCaseIds
    // gained IT-CAP-TRIGGER-PAYLOAD-TARGETCOND-001/002 (real
    // PassiveActivationRuntime/buildEffectStepPerTargetFilter wiring proof).
    // Bumped again by Issue #180 (M7-003, CAP_ACTION_ACTIVATION_CONDITION):
    // AS/EX activationCondition evaluation lands in `action-selection-policy.ts`
    // (isUsable/isExUsable no longer throw on a non-TRUE kind). SKL_ELENA_MOODMAKER_AS1's
    // activationCondition is corrected from an unevaluable ALIVE_UNIT_COUNT
    // approximation to real TARGET_SET_COUNT/TARGET_STATE clauses (two new
    // targetBindings, TGT_LOW_HP_ALLIES/TGT_OTHER_ALLIES); SKL_LYDIA_GENIUS_AS1
    // gains a TARGET_SET_COUNT activationCondition against its existing TGT_COLUMNS
    // binding. Neither of the two promoted units here (Elena/Lydia aren't among
    // the 10) is affected, so `unitCount`/violation expectations are unchanged.
    // Bumped again by M7-004 (Issue #183): `capabilities.json`'s `CAP_HIT_COUNT_
    // EVASION`/`CAP_STATUS_EFFECT_KIND` descriptions were updated to record that
    // EVASION(R-HIT-02)/BLIND(R-HIT-03/R-STS-04)/FREEZE(R-STS-03)/DAMAGE_IMMUNITY
    // (R-DMG-02) now have real resolver support; both Capabilities stay PLANNED
    // (HIT_EVASION/CRITICAL_GUARANTEE/CRITICAL_PREVENTION/GUARANTEED_HIT remain
    // unimplemented and undocumented by any R-* rule). Neither of the 10 promoted
    // units here references these two Capabilities, so `unitCount`/violation
    // expectations are unchanged.
    // Bumped again by the same PR: new `CAP_ATTACK_DAMAGE_BONUS` (IMPLEMENTED,
    // ON_ATTACK_BONUS_DAMAGE_BUFF) and a new `LOWEST_ATTACK` `TargetOrderKey`
    // value on `CAP_TARGET_FILTER_ORDER` (already IMPLEMENTED). Both back
    // `SKL_ELENA_MOODMAKER_EX`'s de-approximated "lowest attack ally"
    // selection and its new attack-triggered bonus-damage buff
    // (`ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE`) — Elena is not among the 10
    // promoted units (still blocked separately by `CAP_DAMAGE_MOD`/DMG-002),
    // so `unitCount`/violation expectations here are unchanged.
    // Bumped again by M7-002 (Issue #185): `CAP_RESOURCE_MUTATION` (MODIFY_RESOURCE,
    // now including `resource: HP` for HP_DIRECT_COST) flipped to IMPLEMENTED, and
    // the new `CAP_RESOURCE_GAIN_MOD` (APPLY_RESOURCE_GAIN_MOD) was added as
    // IMPLEMENTED. `MODIFY_RESOURCE_CAPACITY`'s `CAP_RESOURCE_CAPACITY_MOD` stays
    // PLANNED (no production Catalog definition references it; see its updated
    // description). None of the 10 promoted units here references any of these
    // three Capabilities, so `unitCount`/violation expectations are unchanged.
    // Bumped again by RES-003A (Issue #257): `CAP_SUM_DAMAGE_RESULT` flipped to
    // IMPLEMENTED now that `SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED` accumulate per
    // EffectSequence resolution (`SkillUseId`). Only the 10 definitions that
    // reference `SUM_*` declare it, and none belongs to the 10 promoted units here
    // (Flute/Chizuru/Suiran etc. stay blocked by `CAP_DAMAGE_MOD`/`CAP_SHIELD`/
    // `CAP_CONTINUOUS_DAMAGE`), so `unitCount`/violation expectations are unchanged.
    // Bumped again by M7-007 (Issue #178): 6 static-stat-mod Memories were added
    // to `catalog-src/memories/`. Memories are not part of the 10 promoted units
    // here, so `unitCount`/violation expectations are unchanged.
    // Bumped again by M7-008 (Issue #176): the last 20 Memories (affiliation /
    // damage-mod / TurnStarted / Marker / enemy-side) were added, completing
    // `raw/memories/`. Same reasoning — units here are unchanged.
    // Bumped again by M7-010 (Issue #177, M7完了監査): `capabilities.json` only —
    // 9 orphaned `implementationTaskId`s were reassigned to the newly created
    // owner Issues (M7-002A / M7-015〜M7-019) and three descriptions corrected.
    // No `runtimeStatus` flipped and no Unit/Skill/EffectAction definition
    // changed, so `unitCount`/violation/`selectable` expectations are unchanged.
    // Bumped again for description wording: three of those descriptions
    // claimed the Capability was the *exclusive* blocker of some Units; measured
    // against the real Catalog none of the three is, so the wording was corrected.
    // Descriptions only — still no definition or `runtimeStatus` change.
    // Bumped again by M7-018 (Issue #272): `CAP_HIT_COUNT_EVASION` (R-HIT-04,
    // N-hit evasion) and `CAP_STATUS_EFFECT_KIND` (R-HIT-05, guaranteed hit)
    // flipped to IMPLEMENTED, and `UNIT_JUNKA_CHILDHOOD`'s shield rows dropped
    // their mis-classified `CAP_HIT_COUNT_EVASION` declaration (an
    // `APPLY_SHIELD` consumed by N incoming hits is `CAP_SHIELD`/DMG-004, not
    // evasion). Junka is not among the 10 promoted units here and stays blocked
    // by `CAP_DAMAGE_MOD`/`CAP_SHIELD`, so `unitCount`/violation/`selectable`
    // expectations here are unchanged.
    // Bumped again by M7-011 (Issue #265, EFFECT_APPLIED_CLASSIFICATION_PAYLOAD):
    // eight PS trigger conditions now filter `EffectApplied` by the effect
    // classification payload (`categories`/`effectKind`/`statusKind`) instead of
    // firing on any effect application (or, for the three that already declared
    // a condition, instead of never firing at all against a payload field that
    // did not exist). No `runtimeStatus` flipped — the Capability those skills
    // declare (`CAP_TRIGGER_CONTEXT`) was already IMPLEMENTED — so
    // `unitCount`/violation/`selectable` expectations here are unchanged.
    // Bumped again by M7-014 (Issue #268, DYNAMIC_DURATION_ON_REAPPLY):
    // `ACT_SIENA_DIVA_PS1_STUN` now declares `duration.reapply` (R-EFF-12), so
    // re-applying it onto a 1-action stun overwrites it with 2 actions instead
    // of being a no-op. Siena is not among the 10 promoted units here and no
    // `runtimeStatus` flipped, so `unitCount`/violation/`selectable`
    // expectations here are unchanged.
    // Bumped again by M7-012 (Issue #266, STACK_LIMIT_ON_STAT_MOD):
    // `ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP` now declares `stacking.max: 14`
    // (R-EFF-05), matching the 「負けん気」 Marker's `stack.max`, so that buff stops
    // stacking past 14 instances. Tarisa is not among the 10 promoted units here
    // and no `runtimeStatus` flipped, so `unitCount`/violation/`selectable`
    // expectations here are unchanged.
    // Bumped again by M7-013 (Issue #267, LINKED_EFFECT_GROUP_CROSS_TYPE):
    // `ACT_TARISA_TROUBLEMAKER_PS1_MARKER`/`ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU`
    // now declare `linkedEffectGroupId` + `linkedEffectGroupRole: PARENT`, and
    // the `AppliedEffect` children they gate (`..._PS1_ATK_UP`,
    // `..._AS1_KOUYOU_CRIT_DOWN`, `..._AS1_KOUYOU_DOT`) declare the same group
    // as `CHILD`, so removing the Marker now cascades to them (R-EFF-09 第1項).
    // Neither Tarisa nor Aoi is among the 10 promoted units here and no
    // `runtimeStatus` flipped, so `unitCount`/violation/`selectable`
    // expectations here are unchanged.
    // Bumped again by M7-020 (Issue #279, MARKER_REMOVAL_ON_SOURCE_DEATH):
    // `ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU` now declares
    // `duration.removeOnSourceDefeated: true` (R-EFF-10), so 「高揚」 is released
    // the moment its granter is defeated and R-EFF-09 cascades its CHILD
    // effects away. Aoi is not among the 10 promoted units here and no
    // `runtimeStatus` flipped, so `unitCount`/violation/`selectable`
    // expectations here are unchanged.
    // Bumped again by M7-017 (Issue #271, CAP_RESOURCE_DISTRIBUTE): the
    // Capability flipped to `IMPLEMENTED`, but its only production declarer
    // (`UNIT_SUIRAN_CHAOS`) is not among the 10 promoted units here and stays
    // non-selectable through `CAP_DAMAGE_MOD`, so `unitCount`/violation/
    // `selectable` expectations here are unchanged.
    // Bumped again by DMG-002 (Issue #192, R-DMG-03/R-DMG-04): `CAP_DAMAGE_MOD`
    // flipped to IMPLEMENTED and 14 Catalog rows dropped their approximations
    // (`HP_RATIO_SCALE` formulas, `APPLY_DAMAGE_MOD` dynamic conditions). The
    // same PR added `CAP_TARGET_STATE_EXTENDED_FIELD` (M7-001E) and the missing
    // `CAP_SUBUNIT` declarations so the Units that `CAP_DAMAGE_MOD` had been
    // gating only by accident stay blocked by their real blocker. None of the
    // 10 units promoted here changed definition, so `unitCount`/violation/
    // `selectable` expectations here are unchanged.
    // Bumped again by M7-001E (Issue #248, TARGET_STATE_QUERY_BUFF_DEBUFF):
    // `CAP_TARGET_STATE_EXTENDED_FIELD`が`IMPLEMENTED`になり、新設の
    // `CAP_TARGET_EFFECT_QUERY`と対象5行（CHIYURU/FLUTE/MAIA/NOEL/SHOUKA）の
    // 近似解消が入った。ここで昇格した10 Unitの定義は変わらないため
    // `unitCount`/violation/`selectable`の期待値は据え置き。
    // Bumped again by RES-004-STATUS-CONDITION (Issue #224, AOE_PER_TARGET_CONDITION):
    // 炎上・毒を`STATUS`へ分類し、`SKL_CHIYURU_MAZE_EX`のAOE対象別条件と
    // MERU/NANAEの総称「状態異常」照会を`TARGET_HAS_EFFECT`へ統一した。
    // ここで昇格した10 Unitの定義は変わらないため期待値は据え置き。
    // Bumped again by DMG-005 (Issue #190, SUBUNIT_DURATION/
    // SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF): `APPLY_SUBUNIT`へ`duration`と
    // `additionalDamage.damageType`/`debuff`を追加し、SHIRANA_SORA/OLGA_VETERAN/
    // NADYA_SUCCESSORの各サブユニット定義を近似なしへ更新した。ここで昇格した
    // 10 Unitの定義は変わらないため期待値は据え置き。
    // Bumped again by M7-001A (Issue #242, REMOVE_EFFECTS_CATEGORY_GAP):
    // `REMOVE_EFFECTS`のSHIELD/SUBUNITカテゴリを実行時に有効化し、YUI_HEIR EX
    // （敵単体のシールド全解除）とOLGA_VETERAN PS1（自身のシールド・サブユニット
    // 全解除）を近似なしへ更新した。ここで昇格した10 Unitの定義は変わらないため
    // 期待値は据え置き。
    // Bumped again by RES-004-TATIANA-EX (Issue #225): `CAP_DAMAGE_MOD`と
    // `CAP_EFFECT_STEP_CONDITION`の`verification.testCaseIds`へ
    // `IT-CAP-TATIANA-OMEN-PROD-001`〜`005`（`SKL_TATIANA_SAGE_EX`の「凶兆」
    // しきい値分岐の実ライフサイクル検証。REF-031／Issue #361 でユニット効果軸
    // `IT-UNIT-TATIANA-SAGE-004`〜`006` へ移送済み）を追加した。Unit・Skill・Effectの
    // 定義自体は変えていないため期待値は据え置き。
    // Bumped again by M7-015 (Issue #269): `CAP_MARKER_STACK_FORMULA`を
    // `IMPLEMENTED`へ更新し、`verification`へ`MARKER_COUNT_SCALE`の実ライフ
    // サイクル検証（`IT-CAP-MARKER-STACK-PROD-001`〜`006`。REF-043／Issue #390 で
    // ユニット効果軸 `IT-UNIT-CHIYURU-NEWYEAR-005`・`IT-UNIT-KARINA-DOWNER-007`・
    // `IT-UNIT-FEE-BATH-004` ほかへ移送済み）を登録した。
    // `.11`は同Capabilityの説明のselectable記述を
    // 監査時点の値から本PR後の実測（`UNIT_CHIYURU_NEWYEAR`・`UNIT_FEE_BATH`が
    // selectable）へ訂正した分。Unit・Skill・Effectの定義自体は変えていない
    // ため期待値は据え置き。
    // Bumped again by M7-016 (Issue #270): `CAP_CHARGE_RESTRICTION`を
    // `IMPLEMENTED`へ更新し、`verification`へチャージ中の回避・PS制限の実ライフ
    // サイクル検証（`IT-CAP-CHARGE-RESTRICTION-PROD-001`〜`005`）を登録した。
    // ここで昇格した10 Unitの定義は変わらないため期待値は据え置き
    // （新たにselectableになるのは`UNIT_MIRIAM_MAGE`・`UNIT_SIENA_OFFSTAGE`）。
    // Bumped again by M7-002A (Issue #255): `CAP_RESOURCE_CAPACITY_MOD`を
    // `IMPLEMENTED`へ更新し、`verification`へ`ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP`の
    // 実ライフサイクル検証（`IT-CAP-RESOURCE-CAPACITY-MOD-PROD-001`〜`003`）を
    // 登録した。`UNIT_FLUTE_VAMPIRE`は`CAP_DEATH_SURVIVAL`（#188）で非selectableの
    // ままであり、昇格10 Unitの定義・selectable集合はどちらも変わらない。
    // Bumped again by DMG-003A (Issue #295, R-CRT-03): `CAP_CRITICAL_CONTROL`
    // flipped to `IMPLEMENTED` once `APPLY_STATUS`'s CRITICAL_GUARANTEE/
    // CRITICAL_PREVENTION reached the real lifecycle (`resolveEffectiveCriticalMode`
    // + the resolver allow list), and `CAP_STATUS_EFFECT_KIND`'s description /
    // `verification.testCaseIds` dropped the retired UT-R-HIT-05-009 boundary.
    // Capability metadata only — no Unit/Skill/EffectAction definition changed,
    // so the 10 promoted units' `unitCount`/violation expectations are unchanged
    // (5 other production units do become newly `selectable`: 55 → 60,
    // recorded by the M7 audit, Issue #177).
    // `.5`: `CRITICAL_PREVENTION` is classified
    // as `DEBUFF` (not `BUFF`) by `effect-category-classifier.ts`, recorded in
    // `CAP_CRITICAL_CONTROL`'s description plus two more `verification.testCaseIds`.
    // Capability metadata only — no definition changed.
    // Bumped again by DMG-006 (Issue #188, R-INT-01〜03): `CAP_TARGET_REDIRECT` /
    // `CAP_COVER_DAMAGE` / `CAP_DEATH_SURVIVAL` flipped to `IMPLEMENTED` and the
    // missing `CAP_REFLECT_DAMAGE` was registered (47 → 48 capabilities), which
    // also let `SKL_LUNA_HUNGRY_PS1` convert its reflect without approximation
    // (`ACT_LUNA_HUNGRY_PS1_REDIRECT` / `ACT_LUNA_HUNGRY_PS1_REFLECT` added, its
    // cover moved onto the attacker like Karina's and Evie's). The 10 promoted
    // units' definitions are unchanged, but every remaining production unit
    // becomes `selectable` (60 → 69, recorded by the M7 audit, Issue #177).
    // `.7`: `appliesTo.actionKinds` beyond
    // `["DAMAGE"]` is rejected at Catalog load time
    // (`UNSUPPORTED_DEFENSIVE_INTERVENTION`) because `R-INT-01` only evaluates
    // defensive interventions after `DamageWillBeApplied`, recorded in
    // `CAP_TARGET_REDIRECT`'s and `CAP_COVER_DAMAGE`'s descriptions. Capability
    // metadata only — no definition changed (every production row already
    // declares `["DAMAGE"]`).
    // `.8` is DMG-007 (Issue #187, R-LNK-01〜03): `APPLY_DAMAGE_LINK` and
    // `CAP_DAMAGE_LINK_STATE` were added (48 → 49 capabilities), converting the
    // four `DAMAGE_LINK` ledger rows without approximation —
    // `ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`,
    // `ACT_DOROTHEA_PIONEER_PS1_LINK_TO_FARTHEST` /
    // `ACT_DOROTHEA_PIONEER_PS1_LINK_TO_NEAREST` (replacing the +35% incoming
    // damage approximation), `ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`, and
    // `SKL_DOROTHEA_PIONEER_PS2`'s trigger narrowed to the links it granted.
    // None of the 10 promoted units is involved, so their definitions are
    // unchanged and `selectable` stays at 69.
    // `.9`: `ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`
    // now declares `timeLimit.owner: EFFECT_SOURCE` so the ally-held link shares
    // 劉翠蘭's clock with its parent shield, and every `APPLY_DAMAGE_LINK`
    // declares `polarity` because the same kind is used in both directions.
    // Capability metadata and the four DMG-007 rows only.
    // `.10` is DMG-009 (Issue #193, R-CFS-01/R-CFS-02/R-DTH-01): `APPLY_STATUS`
    // gained the `CONFUSION` and `DAMAGE_TO_HEAL` statuses, plus `CAP_CONFUSION`
    // and `CAP_DAMAGE_TO_HEAL` (49 → 51 capabilities). `SKL_OLGA_VETERAN_EX`'s
    // identifying marker became `ACT_OLGA_VETERAN_EX_CONFUSION` and
    // `SKL_TATIANA_SAGE_AS1` regained the omitted 幻惑 as
    // `ACT_TATIANA_SAGE_AS1_DAZZLE`, converting the last two
    // `CONFUSION_OR_DAMAGE_TO_HEAL` ledger rows without approximation. Neither
    // unit is one of the 10 promoted units, so `selectable` stays at 69.
    // `.11`: R-CFS-01's inversion is `ALLY`↔`ENEMY`
    // only, so `CAP_CONFUSION`'s description now spells out that `side: ALL` is
    // left alone. Capability metadata only — no definition changed.
    // `.12` (REF-021, Issue #324): review-provenance prefixes were stripped from
    // `capabilities.json` descriptions to match CLAUDE.md's comment convention.
    // Wording only — no definition, `runtimeStatus`, or `verification` changed,
    // so every expectation in this file stays the same.
    // `2026-08-05.1` is REL-008 (Issue #263, R-MEM-04): `CAP_MEMORY_GRANTED_MARKER`
    // flipped to `IMPLEMENTED` now that `MarkerStateResponse` /
    // `MarkerApplied` / `MarkerUpdated` publish the same `sourceUnitId`-or-
    // `sourceSide` union the Effect side already published, which unblocks
    // `MEM_ALWAYS_PICO_BESIDE_YOU` (the last non-selectable Memory). Capability
    // metadata only — no Unit/Skill/EffectAction definition changed, so
    // `unitCount`/violation/`selectable` expectations here stay the same.
    // `2026-08-06.1` is REL-001 (Issue #202): `CAP_EFFECT_STEP_SET_CONDITION`'s
    // `implementationTaskId` was repointed from the still-open waiting task
    // `M7-019` to `DMG-003`, the task that actually flipped it to
    // `IMPLEMENTED`, and four Capabilities that had only Domain-unit or
    // Schema/Mapper evidence gained production-path `verification.testCaseIds`.
    // Capability metadata only — no Unit/Skill/EffectAction definition changed,
    // and no `runtimeStatus` moved, so every expectation here stays the same.
    // `2026-08-07.1` is REL-002 (Issue #199): the synthetic
    // `UNIT_CI_SMOKE_TEST` (1 unit, 3 skills, 1 effect action) was removed now
    // that every converted character unit is `selectable` on `IMPLEMENTED`
    // capabilities alone. It is not one of the 10 promoted units, so the
    // `unitCount`/violation/`selectable` expectations here stay the same.
    // `2026-08-08.1` は REF-024（Issue #353）のユニット効果軸テストが、原文と実挙動の
    // 不一致を3件検出したことによる定義修正。いずれも EffectAction 定義自体は変えず、
    // 条件・判定順・付与先だけを直しているため `unitCount`/violation/`selectable` の
    // 期待値はそのまま。
    // (1) `SKL_SAYA_BUNNY_PS1`（ジャックポット、原文「自身の攻撃が会心攻撃になるたびに
    // 発動」）は `CriticalCheckResolved` に条件を持たず、会心しなかった攻撃でも発動して
    // いた。同じイベントを使う `SKL_LAYLA_ENTREPRENEUR_PS2` と揃えて
    // `EVENT_PAYLOAD.result EQ true` を課した。
    // (2) `SKL_ELENA_MOODMAKER_EX`（原文は最も攻撃力が高い味方と低い味方の**双方**へ
    // 「攻撃時に攻撃力×15%のダメージを追加するバフ」を付与する）は
    // `ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE` を `TGT_LOW` step にしか持たず、高攻撃側が
    // 取りこぼされていた。`TGT_HIGH` step へも追加した。
    // (3) `SKL_KOTOHA_REBEL_AS2` の憤怒分岐を
    // 組み替えたもの。`TARGET_HAS_MARKER` はマーカーを1つも保持しない対象に対して
    // `countCondition` の演算子によらず false を返すため、原文「1個以下：威力187.2で
    // 1ヒット」を `LTE 1` で表すと憤怒0個が漏れて「3個以上」の腕へ落ちていた
    // （憤怒を配るのはAS1だけなので、0個は戦闘開始直後に必ず到達する）。上の閾値から
    // 順に判定し最後のelseで0個・1個を受ける形へ変更した。EffectActionの定義自体は
    // 変わらず、判定順だけが変わるため `unitCount`/violation/`selectable` の期待値は
    // そのまま。
    // `2026-08-08.2` は REF-026（Issue #356）の第2バッチが検出した原文との不一致。
    // いずれも EffectAction の種別・対象構造は変えず、trigger の selector・Formula
    // 種別・参照する DAMAGE 結果だけを直しているため、`unitCount`/violation/
    // `selectable` の期待値はそのまま。
    // (1) 「自身がアクティブスキルを使用／攻撃した後」を `targetSelector: SELF` で
    // 表していた3件（`SKL_AOI_GUARDIAN_PS1`／`SKL_URUU_TIMID_PS1`／
    // `SKL_ROSIE_ARTIST_PS2`）は、`SkillUseStarting`/`SkillUseCompleted` が
    // **スキルの対象**を `targetUnitIds` に載せるため、自分自身を対象に取る使用でしか
    // 候補化されなかった。原文に対象の限定がないものは `ANY`、「攻撃した」ものは
    // `ENEMY` へ直した。
    // (2) `SKL_FLUTE_INFLUENCER_PS1`（原文「味方が攻撃され」）と
    // `SKL_EVIE_ECO_PS2`（原文「自身のHPが40%以下になった際」）は
    // `HitPointReduced` の **発生源**（＝攻撃側）へ `ALLY`／`SELF` を課しており、
    // 敵からの攻撃では一度も発動しなかった。`ENEMY`／`ANY` へ直した。
    // (3) `UNIT_SAYA_LONGING` の3件は「HPが多いほど高い効果」を `CURRENT_HP_RATIO`
    // （＝現在HP×係数の絶対値を返すFormula）で表していたため、倍率のはずの値が
    // 現在HPそのもののオーダーになっていた。同じ表現の先例に合わせ
    // `HP_RATIO_SCALE`（`HIGHER_HP_IS_MAX`）へ直した。
    // (4) `ACT_CLARA_TSUNDERE_AS1_HEAL`（原文「与えたダメージの40%」）は
    // `LAST_DAMAGE_DEALT` を読んでおり、4ヒット攻撃の最終ヒット分だけを回復していた。
    // 同じ表現の `ACT_SAYA_LONGING_EX_HEAL` に合わせ `SUM_DAMAGE_DEALT` へ直した。
    // `2026-08-08.3` は REF-027（Issue #357）の第3バッチが検出した原文との不一致。
    // (1) `SKL_EVIE_KYONSHI_PS1`（原文「会心攻撃になるたびに」）は
    // `CriticalCheckResolved` に `result` 条件を持たず、会心しなかった判定でも毎回
    // 発動していた。先例の `SKL_SAYA_BUNNY_PS1` に合わせ `result: true` を課した。
    // (2) 「自身がアクティブスキルで攻撃した後／する前に発動」を表す6件
    // （`SKL_EVIE_KYONSHI_PS2`・`SKL_YURIA_YUKATA_PS1`・`SKL_LYDIA_GENIUS_PS1`・
    // `SKL_MIKOTO_SURVIVOR_PS2`・`SKL_MEIYA_FATED_PS2`・`SKL_MERU_FLATSPIN_PS1`）は
    // `targetSelector: SELF` を課していた。`SkillUseStarting`/`SkillUseCompleted` は
    // 攻撃対象を `targetUnitIds` に持つため、この条件では一度も候補化されない。
    // 陣営で絞ると今度は混乱（R-CFS-01）で対象が味方側へ反転した攻撃を取りこぼす
    // ため、`targetSelector: ANY` と「攻撃を含むAS」のIDリストで判定する。
    // (3) `SKL_MIKOTO_SURVIVOR_PS1` の `TGT_OTHER_ALLIES`（原文「他の味方の」）は
    // 自身を除外しておらず、名前と原文に反して自分自身も対象へ含めていた。
    // `2026-08-08.4` は REF-028（Issue #358）の第4バッチが検出した原文との不一致。
    // (1) 「**他の**味方が〜した際に発動」を `sourceSelector: ALLY` で表していた3件
    // （`SKL_CHIYURU_MAZE_PS1`／`PS2`・`SKL_HARRIET_SAGE_PS2`）は、`ALLY` が所有者
    // 自身を含むため自分の行動で自分のPSを呼んでいた。新設した `OTHER_ALLY` へ直した。
    // (2) 発生源・対象の帰属が実イベントと噛み合わない3件
    // （`SKL_DOROTHEA_PIONEER_PS2` の `sourceSelector: ENEMY`、
    // `SKL_FLUTE_VAMPIRE_PS1` の `HitPointReduced`＋`sourceSelector: SELF`、
    // `SKL_JULIE_SNOW_PS2` の `SkillUseCompleted`＋`targetSelector: SELF`）は
    // いずれも実戦闘で一度も候補化されなかった。
    // (3) `SKL_AOI_ELEGANT_AS2` の追加ダメージ分岐は、自分が付けた「浮足」で条件が
    // 必ず成立する位置に置かれており恒真だった。付与をBRANCHの後ろへ回した。
    // (4) `SKL_FEE_BATH_AS1`（原文「「ほてり」を2つ付与する」）は `APPLY_MARKER` を
    // 1件しか撃っておらず1つしか付いていなかった。
    // `2026-08-08.5` は REF-029（Issue #359）の第5バッチが検出した原文との不一致。
    // (1) 「**他の**味方が〜」を `ALLY` selector で表していた4件（`SKL_KARINA_DOWNER_PS1`・
    // `SKL_LAURA_MOUNTAIN_PS3`・`SKL_LILY_SINGER_PS1`・`SKL_MERU_SIRIUS_PS1`）。
    // (2) 「自身がアクティブスキルを使用した後／するたびに」を `targetSelector: SELF`
    // で表し一度も候補化されない2件（`SKL_LUCIE_COMPANION_PS1`・`SKL_MAIA_SALON_PS1`）は
    // `ANY` へ直した。
    // (3) `SKL_LAURA_MOUNTAIN_PS1`（原文「自身がアクティブスキルで攻撃する前」）は
    // `targetSelector: ENEMY` で、通常の攻撃では候補化されるが混乱（R-CFS-01）で
    // 対象が味方へ反転した攻撃を取りこぼしていた。`ANY` ＋ 攻撃ASのIDリストへ直した。
    // (4) `SKL_MAIA_SALON_PS2` の `HitPointReduced`＋`sourceSelector: ENEMY` は、
    // HPを削るのが通常こちら側であるため味方の攻撃では成立しなかった。
    // (5) `SKL_KARINA_DOWNER_PS1` は「アクティブスキルで攻撃される」の `skillType`
    // 条件が無く、EXの攻撃でも発動していた。
    // (6) `ACT_KARINA_DOWNER_PS2_DEBUFF`（原文「最高30%低下…HPが多いほど高い効果」）は
    // 絶対値Formula（`CURRENT_HP_RATIO`）で、実測値が割合ではなく -3000 だった。
    // (7) `ACT_KATE_PALADIN_AS1_SELF_HEAL_100`（原文「与えたダメージの100%分」）は
    // 4ヒット攻撃の最終ヒット分（`LAST_DAMAGE_DEALT`）だけを読んでいた。
    // `2026-08-09.1` は REF-030（Issue #360）の第6バッチが検出した原文との不一致。
    // (1) 「自身がアクティブスキルで攻撃する前／した直後に発動」を `targetSelector: SELF`
    // で表し一度も候補化されない3件（`SKL_NOEL_RUMBLE_PS1`・`SKL_RAMI_NEWYEAR_PS1`・
    // `SKL_RAMI_UNYIELDING_PS3`）は `ANY` へ直した（`2026-08-08.5` の(2)と同型）。
    // (2) `SKL_RAMI_UNYIELDING_PS1`（原文「自身のHPが30%以下になった際」）は
    // `HitPointReduced`＋`sourceSelector: SELF` で、HPを削るのは通常敵であるため
    // 被弾では成立しなかった。発生源を問わない `ANY` へ直した。
    // (3) `SKL_SENKA_CHRISTMAS_PS2`（原文「自身の攻撃が会心攻撃になるたびに発動」）は
    // `CriticalCheckResolved` の条件が `TRUE` で、会心しなかった攻撃でも発動していた。
    // 他の会心契機PSと同じ `EVENT_PAYLOAD result EQ true` へ直した。
    // `2026-08-09.2` は同じ `SKL_SENKA_CHRISTMAS_PS2` の `targetSelector: ENEMY`。
    // 原文は解除先を「自身が攻撃した対象」としか言わず陣営を限定しないため、混乱
    // （R-CFS-01）で対象が味方側へ反転した会心攻撃を取りこぼしていた。`ANY` へ直した。
    // `2026-08-09.3` は REF-031（Issue #361）の第7バッチが検出した原文との不一致3件。
    // (1) `SKL_SHIRANA_LUCKY_PS1`（原文「自身のHPが50%以下になった際」）の
    // `HitPointReduced`＋`sourceSelector: SELF`（`2026-08-09.1` の(2)と同型）は `ANY` へ。
    // (2) `SKL_SIENA_OFFSTAGE_PS2`（原文「自身がアクティブスキルで攻撃した後に発動」）の
    // `targetSelector: SELF` は `ANY` ＋ 攻撃ASのIDリストへ。
    // (3) `SKL_STELLA_STATUE_PS1`（原文「「惑光」を所持している敵のHPが50%以下に
    // なった際」）の `sourceSelector: ENEMY` は、HPを削るのがこちら側であるため味方の
    // 攻撃では成立しなかった。`ANY` へ直した。
    // `2026-08-11.1` は ENH-004（Issue #413）の仮 `levelGrowth` 全69Unit投入。
    // 挙動の是正ではなくフィールドの追加であり、強化指定のないリクエストの結果は
    // 変わらない（R-ENH-01。`levelGrowth` は現在レベル指定時にだけ読まれる）。
    // `2026-08-11.2` は仮 `levelGrowth` の実測値への差し替え（64Unit）。
    // 併せて `UNIT_ELENA_MOODMAKER` の `baseStats`（`maximumHp`・`attack`・`defense`）も
    // 実測値へ直した。仮値は `baseStats` から算出していたため、誤った `baseStats` が
    // そのまま `levelGrowth` の桁違いを生んでいた。
    // `2026-08-11.3` は同じ実測値差し替えの継続で、5Unit（`UNIT_ELENA_MOODMAKER`・
    // `UNIT_KEI_JACKKNIFE`・`UNIT_MIKOTO_SURVIVOR`・`UNIT_SAYA_BUNNY`・
    // `UNIT_SAYA_LONGING`）の `levelGrowth` を±1だけ寄せ直した。
    // `2026-08-12.1` は戦術演習専用ユニット `UNIT_AOI_GUARDIAN_TEX` の追加
    // （TEX-010／Issue #447、R-TEX-11）。既存69Unitの定義は変えていない。
    // `2026-08-12.2` は新規Memory 4件（`MEM_KOI`・`MEM_LIKE_FRIENDS`・
    // `MEM_GIDDY_CIRCUMSTANCES`・`MEM_FANTASY_SCULPTOR_ROSIE`）の追加。
    // Unit・Skillは1件も変えておらず、差分は `memories.json`・`effects.json` だけ。
    // `2026-08-12.3` は夏バリアント3ユニット（`UNIT_URUU_SUMMER`・`UNIT_MAO_SUMMER`・
    // `UNIT_SHOUKA_BEACH`、Issue #453）の追加。既存69Unitの定義は変えていない。
    // `2026-08-12.4` は夏バリアント4体目 `UNIT_ANIS_SWEETDEVIL` の追加
    // （Issue #454）。`DMG-012`（Issue #452）が追加した `DAMAGE_MAX_HP_RATIO` と
    // `APPLY_DAMAGE_MOD.damageThreshold` の production 初使用である。
    // `2026-08-14.1` は会心率・会心ダメージボーナスへの `APPLY_STAT_MOD` 46件を
    // `valueType: RATIO` から `FIXED` へ正規化した（Issue #460、R-STA-01の
    // パーセントポイント加算ステータス）。Unit・Skill・Memoryの構成は変えていない。
    // `2026-08-15.1` は戦術演習専用ユニット3体（`UNIT_ANIS_SWEETDEVIL_TEX`・
    // `UNIT_SHOUKA_BEACH_TEX`・`UNIT_MAO_SUMMER_TEX`、Issue #470〜#472）の追加。
    // 既存Unitの定義は変えていない。
    // `2026-08-15.2` は追撃（攻撃ライダー、R-FUP-01／Issue #474）への載せ替え。
    // `SKL_SUIRAN_CHAOS_PS3`・`SKL_CHIYURU_MAZE_PS2`・`SKL_FEE_ACTOR_PS1` の3スキル
    // （と`SKL_FEE_ACTOR_PS1`の`OTHER_ALLY`修正）だけを変え、他ユニットは変えていない。
    // `2026-08-15.3` は新規Memory 1件（`MEM_YOUR_SECRET_I_WANT_TO_KNOW`）の追加。
    // Unit・Skillは1件も変えておらず、差分は `memories.json`・`effects.json` だけ。
    // `2026-08-16.1` は隣接splashのtargetBindingへ `optional: true` を18件付けた
    // （Issue #495）。補助対象が0件でもAS/EXを発動不能にしないための印であり、
    // Unit・Memoryの構成と対象選択そのものは変えていない。差分は `skills.json` だけ。
    // `2026-08-16.2` は同じ印を行・列filter由来の補助binding 6件へ付けた（Issue #495）。
    // 後列・同列・敵前列といった範囲が空でもスキルを発動不能にしないためのもの。
    expect(catalog.catalogRevision).toBe("2026-08-16.2");
  });

  it("IT-CAT-PROD-002: Evie's デコイプロトコル (PS1) triggers on an ally being attacked by an enemy, not on self being attacked by an ally", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_EVIE_ECO"] as never[], []);
    const ps1 = snapshot.skills.get("SKL_EVIE_ECO_PS1" as never);
    expect(ps1?.triggers[0]?.sourceSelector).toBe("ENEMY");
    expect(ps1?.triggers[0]?.targetSelector).toBe("ALLY");
  });

  it("IT-CAT-PROD-003: Karina's とりしまり～ (AS1) reduces EX gauge on all enemies, not a single target", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_KARINA_DOWNER"] as never[], []);
    const as1 = snapshot.skills.get("SKL_KARINA_DOWNER_AS1" as never);
    const binding = as1?.resolution.targetBindings.find(
      (b) => b.targetBindingId === "TGT_ALL_ENEMIES",
    );
    expect(binding?.selector.side).toBe("ENEMY");
    expect(binding?.selector.count).toBe("ALL");
    const step = as1?.resolution.steps[0];
    expect(step?.kind).toBe("ACTION");
    if (step?.kind === "ACTION") {
      const actionIds = step.actions.map((a) => a.effectActionDefinitionId);
      expect(actionIds).toContain("ACT_KARINA_DOWNER_AS1_EX_DOWN");
      expect(step.target).toEqual({ kind: "BINDING", targetBindingId: "TGT_ALL_ENEMIES" });
    }
  });

  it("IT-CAT-PROD-004: Flute's ＃ぽよ・オア・トリート (EX) self-heal references the summed damage dealt, not only the last hit", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_FLUTE_VAMPIRE"] as never[], []);
    const heal = snapshot.effectActions.get("ACT_FLUTE_VAMPIRE_EX_SELF_HEAL" as never);
    expect(heal?.kind).toBe("HEAL");
    if (heal?.kind === "HEAL") {
      expect(heal.payload.formula.kind).toBe("DAMAGE_DEALT_RATIO");
      if (heal.payload.formula.kind === "DAMAGE_DEALT_RATIO") {
        expect(heal.payload.formula.sourceResult).toBe("SUM_DAMAGE_DEALT");
      }
    }
  });

  it("IT-CAT-PROD-005: Flute's HP cost (AS1 かぷっとファンサ) bypasses defense/shield/evasion/crit so it behaves as an unconditional resource cost", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_FLUTE_VAMPIRE"] as never[], []);
    const hpCost = snapshot.effectActions.get("ACT_FLUTE_VAMPIRE_AS1_HP_COST" as never);
    expect(hpCost?.kind).toBe("DAMAGE");
    if (hpCost?.kind === "DAMAGE") {
      expect(hpCost.payload.critical?.mode).toBe("PREVENTED");
      expect(hpCost.payload.accuracy?.mode).toBe("GUARANTEED");
      expect(hpCost.payload.piercing).toEqual({
        defenseIgnoreRate: 1,
        shieldIgnoreRate: 1,
        damageReductionIgnoreRate: 1,
      });
    }
  });

  it("IT-CAT-PROD-006: every declared targetBindingId is referenced by a resolution step or another binding's base (no orphaned bindings, e.g. Lydia's EX fallback)", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const unitIds = [
      "UNIT_EVIE_ECO",
      "UNIT_LYDIA_GENIUS",
      "UNIT_LAURA_MOUNTAIN",
      "UNIT_STELLA_STATUE",
      "UNIT_KARINA_DOWNER",
      "UNIT_HARRIET_SAGE",
      "UNIT_KOTOHA_REBEL",
      "UNIT_MIKOTO_SURVIVOR",
      "UNIT_KATE_PALADIN",
      "UNIT_FLUTE_VAMPIRE",
    ];
    const snapshot = catalog.loadSnapshot(unitIds as never[], []);

    // Any `{ kind: "BINDING", targetBindingId: "..." }` occurring anywhere inside
    // resolution.steps (step targets, BRANCH/RANDOM_BRANCH conditions and nested
    // branches) or inside another binding's selector (e.g. BINDING_DERIVED.base)
    // counts as a usage. Declaration sites (`{ targetBindingId, selector }`) never
    // match this shape, since `kind` lives one level deeper inside `selector`.
    function collectBindingReferences(node: unknown, into: Set<string>): void {
      if (Array.isArray(node)) {
        for (const item of node) collectBindingReferences(item, into);
        return;
      }
      if (node !== null && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (record.kind === "BINDING" && typeof record.targetBindingId === "string") {
          into.add(record.targetBindingId);
        }
        for (const value of Object.values(record)) collectBindingReferences(value, into);
      }
    }

    for (const skill of snapshot.skills.values()) {
      const referenced = new Set<string>();
      collectBindingReferences(skill.resolution.steps, referenced);
      for (const binding of skill.resolution.targetBindings) {
        collectBindingReferences(binding.selector, referenced);
      }
      const declared = skill.resolution.targetBindings.map((b) => b.targetBindingId);
      for (const bindingId of declared) {
        expect(referenced.has(bindingId), `${skill.skillDefinitionId}: ${bindingId} unused`).toBe(
          true,
        );
      }
    }
  });

  it.each([
    { unitId: "UNIT_DOROTHEA_GRACE", skillId: "SKL_DOROTHEA_GRACE_PS3", sourceSelector: "ANY" },
    { unitId: "UNIT_KOTOHA_REBEL", skillId: "SKL_KOTOHA_REBEL_PS1", sourceSelector: "ANY" },
    { unitId: "UNIT_ELENA_MOODMAKER", skillId: "SKL_ELENA_MOODMAKER_PS2", sourceSelector: "ENEMY" },
    { unitId: "UNIT_RAVEL_MODEL", skillId: "SKL_RAVEL_MODEL_PS1", sourceSelector: "ENEMY" },
  ])(
    "IT-CAT-PROD-007: $skillId's UnitDefeated trigger targets the defeated ally, not the skill owner ($unitId)",
    ({ unitId, skillId, sourceSelector }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      const trigger = skill?.triggers[0];
      expect(trigger?.eventType).toBe("UnitDefeated");
      expect(trigger?.targetSelector).toBe("ALLY");
      expect(trigger?.sourceSelector).toBe(sourceSelector);
    },
  );

  /**
   * Issue #143: `RUNTIME_COUNTER`のCondition木からRUNTIME_COUNTER kindだけを
   * 再帰的に探す（`AND`でラップされている場合があるため）。
   */
  function findRuntimeCounterCondition(
    condition: unknown,
  ): { readonly counter?: string; readonly modulo?: number | undefined } | undefined {
    if (condition === null || typeof condition !== "object") {
      return undefined;
    }
    const c = condition as Record<string, unknown>;
    if (c.kind === "RUNTIME_COUNTER") {
      return { counter: c.counter as string, modulo: c.modulo as number | undefined };
    }
    if ((c.kind === "AND" || c.kind === "OR") && Array.isArray(c.conditions)) {
      for (const sub of c.conditions) {
        const found = findRuntimeCounterCondition(sub);
        if (found !== undefined) {
          return found;
        }
      }
    }
    if (c.kind === "NOT") {
      return findRuntimeCounterCondition(c.condition);
    }
    return undefined;
  }

  it.each([
    { unitId: "UNIT_LAYLA_ENTREPRENEUR", skillId: "SKL_LAYLA_ENTREPRENEUR_PS2", modulo: 4 },
    { unitId: "UNIT_JUNKA_CHILDHOOD", skillId: "SKL_JUNKA_CHILDHOOD_PS2", modulo: 3 },
    { unitId: "UNIT_SHIRANA_SORA", skillId: "SKL_SHIRANA_SORA_PS1", modulo: 2 },
    { unitId: "UNIT_CLARA_SANTA", skillId: "SKL_CLARA_SANTA_PS1", modulo: 3 },
    { unitId: "UNIT_OLGA_VETERAN", skillId: "SKL_OLGA_VETERAN_PS1", modulo: 4 },
    { unitId: "UNIT_MAO_COMMITTEE", skillId: "SKL_MAO_COMMITTEE_PS1", modulo: 3 },
    { unitId: "UNIT_MIRIAM_MAGE", skillId: "SKL_MIRIAM_MAGE_PS1", modulo: 3 },
    { unitId: "UNIT_ELENA_MOODMAKER", skillId: "SKL_ELENA_MOODMAKER_PS1", modulo: 4 },
    { unitId: "UNIT_NADYA_SUCCESSOR", skillId: "SKL_NADYA_SUCCESSOR_PS3", modulo: 3 },
  ])(
    "IT-CAT-PROD-008 (Issue #143, RUNTIME_COUNTER_MODULO): $skillId declares a matching counterUpdates INCREMENT entry and a RUNTIME_COUNTER trigger condition with modulo=$modulo ($unitId)",
    ({ unitId, skillId, modulo }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      expect(skill?.counterUpdates).toHaveLength(1);
      const update = skill?.counterUpdates[0];
      expect(update?.kind).toBe("INCREMENT");
      expect(update?.scope).toBe("SKILL_RUNTIME");
      if (update?.kind === "INCREMENT") {
        expect(update.amount).toBe(1);
      }

      const found = findRuntimeCounterCondition(skill?.triggers[0]?.condition);
      expect(found).toBeDefined();
      expect(found?.counter).toBe(update?.counter);
      expect(found?.modulo).toBe(modulo);
    },
  );

  it.each([
    { unitId: "UNIT_CHIYURU_NEWYEAR", skillId: "SKL_CHIYURU_NEWYEAR_PS2", maxHpRatio: 0.4 },
    { unitId: "UNIT_CHIZURU_DOMESTIC", skillId: "SKL_CHIZURU_DOMESTIC_PS3", maxHpRatio: 0.85 },
    { unitId: "UNIT_TATIANA_SAGE", skillId: "SKL_TATIANA_SAGE_PS1", maxHpRatio: 0.2 },
  ])(
    "IT-CAT-PROD-009 (Issue #143, CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER): $skillId declares a matching counterUpdates CUMULATIVE_DAMAGE_THRESHOLD entry (maxHpRatio=$maxHpRatio) and triggers on its own RuntimeCounterChanged only when valueChanged is true ($unitId)",
    ({ unitId, skillId, maxHpRatio }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      expect(skill?.counterUpdates).toHaveLength(1);
      const update = skill?.counterUpdates[0];
      expect(update?.kind).toBe("CUMULATIVE_DAMAGE_THRESHOLD");
      expect(update?.scope).toBe("SKILL_RUNTIME");
      if (update?.kind === "CUMULATIVE_DAMAGE_THRESHOLD") {
        expect(update.maxHpRatio).toBe(maxHpRatio);
      }
      expect(update?.trigger.eventType).toBe("DamageApplied");

      const trigger = skill?.triggers[0];
      expect(trigger?.eventType).toBe("RuntimeCounterChanged");
      expect(trigger?.sourceSelector).toBe("SELF");
      // carryのみの変化でも`RuntimeCounterChanged`が
      // 発行されるようになったため、閾値到達時（`valueChanged: true`）だけに
      // 絞り込む条件をANDで持つ（さもないと閾値未到達の被弾ごとに誤発動する）。
      expect(trigger?.condition).toEqual({
        kind: "AND",
        conditions: [
          { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: update?.counter },
          { kind: "EVENT_PAYLOAD", field: "valueChanged", op: "EQ", value: true },
        ],
      });
    },
  );

  /**
   * Issue #144: `POSITION_RELATION`/`RESOLUTION_PHASE` ConditionのCondition木
   * からそのkindだけを再帰的に探す（`AND`でラップされている場合があるため、
   * `findRuntimeCounterCondition`と同じ形）。
   */
  function findConditionsOfKind<K extends string>(
    condition: unknown,
    kind: K,
  ): readonly Record<string, unknown>[] {
    if (condition === null || typeof condition !== "object") {
      return [];
    }
    const c = condition as Record<string, unknown>;
    if (c.kind === kind) {
      return [c];
    }
    if ((c.kind === "AND" || c.kind === "OR") && Array.isArray(c.conditions)) {
      return c.conditions.flatMap((sub) => findConditionsOfKind(sub, kind));
    }
    if (c.kind === "NOT") {
      return findConditionsOfKind(c.condition, kind);
    }
    return [];
  }

  it.each([
    {
      unitId: "UNIT_SUIRAN_CHAOS",
      skillId: "SKL_SUIRAN_CHAOS_PS1",
      target: { kind: "TRIGGER_TARGET" },
    },
    {
      unitId: "UNIT_SUIRAN_CHAOS",
      skillId: "SKL_SUIRAN_CHAOS_PS2",
      target: { kind: "TRIGGER_TARGET" },
    },
    {
      unitId: "UNIT_SUIRAN_CHAOS",
      skillId: "SKL_SUIRAN_CHAOS_PS3",
      target: { kind: "TRIGGER_SOURCE" },
    },
  ])(
    "IT-CAT-PROD-010 (Issue #144, TRIGGER_POSITION_RELATION): $skillId's trigger condition requires the target to be IN_FRONT_OF the PS owner, not an approximated 任意の味方 ($unitId)",
    ({ unitId, skillId, target }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      const trigger = skill?.triggers[0];
      const positionConditions = findConditionsOfKind(trigger?.condition, "POSITION_RELATION");
      expect(positionConditions).toHaveLength(1);
      expect(positionConditions[0]).toEqual({
        kind: "POSITION_RELATION",
        target,
        relation: "IN_FRONT_OF",
      });
    },
  );

  it.each([
    { unitId: "UNIT_KEI_JACKKNIFE", skillId: "SKL_KEI_JACKKNIFE_PS2" },
    { unitId: "UNIT_LILY_SINGER", skillId: "SKL_LILY_SINGER_PS1" },
    { unitId: "UNIT_SIENA_DIVA", skillId: "SKL_SIENA_DIVA_PS1" },
    // M7-011（Issue #265）: rawの「このスキルは戦闘開始時・ターン開始時・
    // ターン終了時には発動しない」は`SKL_NADYA_SUCCESSOR_PS1`/`PS2`にも併記
    // されているが、分類payload待ちで trigger condition 自体が未宣言だった。
    { unitId: "UNIT_NADYA_SUCCESSOR", skillId: "SKL_NADYA_SUCCESSOR_PS1" },
    { unitId: "UNIT_NADYA_SUCCESSOR", skillId: "SKL_NADYA_SUCCESSOR_PS2" },
  ])(
    "IT-CAT-PROD-011 (Issue #144, TRIGGER_EXCLUSION_TIMING): $skillId's trigger condition excludes BATTLE_START/TURN_START/TURN_END resolution phases ($unitId)",
    ({ unitId, skillId }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      const trigger = skill?.triggers[0];
      const phaseConditions = findConditionsOfKind(trigger?.condition, "RESOLUTION_PHASE");
      const phases = phaseConditions.map((c) => c.phase).sort();
      expect(phases).toEqual(["BATTLE_START", "TURN_END", "TURN_START"]);
      for (const c of phaseConditions) {
        expect(c.negate).toBe(true);
      }
    },
  );

  it.each([
    // `raw/units/`の凍結解除ダメージ増幅フレーバーテキスト（例:
    // 「その際の被ダメージが150%増加する」）は加算率であり、
    // `damage-application-service.ts`は`1 + damageAmplificationOnBreak`を実効
    // 倍率として計算する（Issue #183）。
    {
      unitId: "UNIT_KATE_PALADIN",
      effectActionId: "ACT_KATE_PALADIN_EX_FREEZE",
      expectedRate: 1.5,
      expectedMultiplier: 2.5,
    },
    {
      unitId: "UNIT_MIRIAM_MAGE",
      effectActionId: "ACT_MIRIAM_MAGE_EX_FREEZE",
      expectedRate: 1.0,
      expectedMultiplier: 2.0,
    },
    {
      unitId: "UNIT_MIRIAM_MAGE",
      effectActionId: "ACT_MIRIAM_MAGE_AS2_FREEZE",
      expectedRate: 1.0,
      expectedMultiplier: 2.0,
    },
    {
      unitId: "UNIT_NANAE_COMMANDER",
      effectActionId: "ACT_NANAE_COMMANDER_EX_FREEZE",
      expectedRate: 1.5,
      expectedMultiplier: 2.5,
    },
    {
      unitId: "UNIT_RAMI_NEWYEAR",
      effectActionId: "ACT_RAMI_NEWYEAR_EX_FREEZE",
      expectedRate: 1.0,
      expectedMultiplier: 2.0,
    },
  ])(
    "IT-CAT-PROD-012 (Issue #183): $effectActionId's damageAmplificationOnBreak ($expectedRate) is an additive rate producing an effective $expectedMultiplier x multiplier, matching the raw flavor text ($unitId)",
    ({ unitId, effectActionId, expectedRate, expectedMultiplier }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const freeze = snapshot.effectActions.get(effectActionId as never);
      expect(freeze?.kind).toBe("APPLY_STATUS");
      if (freeze?.kind === "APPLY_STATUS") {
        expect(freeze.payload.status).toBe("FREEZE");
        expect(freeze.payload.damageAmplificationOnBreak).toBe(expectedRate);
        expect(1 + (freeze.payload.damageAmplificationOnBreak ?? 0)).toBe(expectedMultiplier);
      }
    },
  );

  it.each([
    // 「敵にデバフが付与された際に発動」。R-STS-01「状態異常はデバフの一種」に
    // より、状態異常の付与も`categories`に`DEBUFF`を含むため同じ条件で拾える。
    {
      unitId: "UNIT_KEI_JACKKNIFE",
      skillId: "SKL_KEI_JACKKNIFE_PS2",
      raw: "敵にデバフが付与された際",
      expected: [{ kind: "EVENT_PAYLOAD", field: "categories", op: "CONTAINS", value: "DEBUFF" }],
    },
    // 「他の味方がデバフを付与された際に発動」。
    {
      unitId: "UNIT_LILY_SINGER",
      skillId: "SKL_LILY_SINGER_PS1",
      raw: "味方がデバフを付与された際",
      expected: [{ kind: "EVENT_PAYLOAD", field: "categories", op: "CONTAINS", value: "DEBUFF" }],
    },
    // 「敵に状態異常が付与された際に発動」。`effectKind: APPLY_STATUS`では
    // STEALTH/EVASION等の対象に有利な状態まで拾ってしまうため、
    // `effect-category-classifier.ts`が気絶・凍結・暗闇にだけ与える`STATUS`
    // カテゴリで判定する（R-STS-01）。
    {
      unitId: "UNIT_SIENA_DIVA",
      skillId: "SKL_SIENA_DIVA_PS1",
      raw: "敵に状態異常が付与された際",
      expected: [{ kind: "EVENT_PAYLOAD", field: "categories", op: "CONTAINS", value: "STATUS" }],
    },
    // 「自身にデバフが付与された際に発動」。
    {
      unitId: "UNIT_URUU_TIMID",
      skillId: "SKL_URUU_TIMID_PS3",
      raw: "自身にデバフが付与された際",
      expected: [{ kind: "EVENT_PAYLOAD", field: "categories", op: "CONTAINS", value: "DEBUFF" }],
    },
    // 「自身に状態異常が付与された際に発動」。
    {
      unitId: "UNIT_NADYA_SUCCESSOR",
      skillId: "SKL_NADYA_SUCCESSOR_PS1",
      raw: "自身に状態異常が付与された際",
      expected: [{ kind: "EVENT_PAYLOAD", field: "categories", op: "CONTAINS", value: "STATUS" }],
    },
    // 「敵に気絶が付与された際に発動」。種別まで指定するため`statusKind`
    // （TGT-004フェーズ3で既にpayloadにある）で絞り込む。
    {
      unitId: "UNIT_NADYA_SUCCESSOR",
      skillId: "SKL_NADYA_SUCCESSOR_PS2",
      raw: "敵に気絶が付与された際",
      expected: [{ kind: "EVENT_PAYLOAD", field: "statusKind", op: "EQ", value: "STUN" }],
    },
    // 「敵に凍結が付与された際に発動」。M7-011以前は`field: "status"`という
    // payloadに存在しないフィールドを参照しており、条件が恒常的に不成立だった。
    {
      unitId: "UNIT_KATE_PALADIN",
      skillId: "SKL_KATE_PALADIN_PS1",
      raw: "敵に凍結が付与された際",
      expected: [
        { kind: "EVENT_PAYLOAD", field: "effectKind", op: "EQ", value: "APPLY_STATUS" },
        { kind: "EVENT_PAYLOAD", field: "statusKind", op: "EQ", value: "FREEZE" },
      ],
    },
    // 「自身にデバフが付与された際に発動」。
    {
      unitId: "UNIT_MEIYA_FATED",
      skillId: "SKL_MEIYA_FATED_PS1",
      raw: "自身にデバフが付与された際",
      expected: [{ kind: "EVENT_PAYLOAD", field: "categories", op: "CONTAINS", value: "DEBUFF" }],
    },
  ])(
    "IT-CAT-PROD-013 (M7-011, Issue #265, EFFECT_APPLIED_CLASSIFICATION_PAYLOAD): $skillId filters its EffectApplied trigger by the effect classification the raw text names ($raw), instead of firing on any effect application ($unitId)",
    ({ unitId, skillId, expected }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      const trigger = skill?.triggers[0];
      expect(trigger?.eventType).toBe("EffectApplied");
      expect(findConditionsOfKind(trigger?.condition, "EVENT_PAYLOAD")).toEqual(expected);
    },
  );
  it("IT-CAT-PROD-014 (ENH-004, Issue #413, R-ENH-05 #2/Q-ENH-07): every playable production Unit declares a levelGrowth, so a current level other than 200 is usable for all of them", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const unitDefinitionIds = allProductionUnitIds(catalogPath());
    expect(unitDefinitionIds.length).toBeGreaterThan(0);

    const snapshot = catalog.loadSnapshot(unitDefinitionIds as never[], []);
    const violations: string[] = [];
    for (const unitDefinitionId of unitDefinitionIds) {
      const growth = snapshot.units.get(unitDefinitionId as never)?.levelGrowth;
      if (growth === undefined) {
        violations.push(`${unitDefinitionId}: no levelGrowth`);
        continue;
      }
      // 実測値へ差し替えていく前提のため、仮値の算式ではなく「4ステータスが
      // 非負整数で揃っている」ことだけを縛る（`14_Catalog定義スキーマ.md`
      // 「levelGrowth の仮値」の目視更新を将来この検査が妨げないように）。
      for (const [stat, value] of Object.entries(growth)) {
        if (!Number.isInteger(value) || value < 0) {
          violations.push(`${unitDefinitionId}.${stat}: ${String(value)}`);
        }
      }
    }

    expect(violations, `Units without a usable levelGrowth: ${violations.join(", ")}`).toEqual([]);
  });
});
