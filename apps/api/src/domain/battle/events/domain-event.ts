import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  MarkerInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { StateDelta } from "./state-delta.js";
import type { BattleOutcome, CompletionReason } from "../outcome/victory-policy.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { CooldownUnit } from "../../catalog/definitions/skill-definition.js";
import type { Side } from "../../shared/side.js";
import type {
  ConsumptionKind,
  CriticalMode,
  DamageType,
  DurationOwner,
  DurationTimeUnit,
  EffectImmunityCategory,
  MarkerStackPolicy,
  ResourceKind,
  SkillType,
  StatKind,
} from "../../catalog/definitions/catalog-enums.js";
import type {
  EffectActionDefinitionId,
  MarkerId,
  MemoryDefinitionId,
  RuntimeCounterId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterScope } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { BattleId, BattleUnitId } from "../../shared/ids.js";
import type {
  ConditionDefinition,
  ConditionKind,
} from "../../catalog/definitions/condition-definition.js";
import type { EffectActionKind } from "../../catalog/definitions/effect-action-definition.js";
import type {
  EffectStepDefinition,
  RandomBranchMode,
} from "../../catalog/definitions/effect-sequence.js";
import type {
  ContinuousDamageKind,
  StatusKind,
} from "../../catalog/definitions/effect-action-payload.js";

/**
 * `08_ドメインイベント.md`「イベントの分類」。M3〜M5はFACT/TIMINGだけを使い、
 * M6で`ExtraGaugeOverflowDiscarded`等のDIAGNOSTICイベントが加わる。
 * `TriggerDefinition.category`（`catalog/definitions/catalog-enums.ts`の別の
 * `EventCategory`）はDIAGNOSTICを含まない — DIAGNOSTICイベントはPS/Memoryの
 * 発動契機になり得ないため、意図的に別の狭い型として保つ。
 */
export type EventCategory = "FACT" | "TIMING" | "DIAGNOSTIC";

/** `08_ドメインイベント.md`「イベントエンベロープ」の共通フィールド。M3実装では`effectSequenceId`は未使用（EffectSequenceイベント自体がM7範囲）。 */
export interface DomainEventEnvelope {
  readonly schemaVersion: number;
  readonly eventId: DomainEventId;
  readonly sequence: number;
  readonly category: EventCategory;
  readonly battleId: BattleId;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly parentEventId?: DomainEventId;
  readonly rootEventId: DomainEventId;
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
  readonly targetUnitIds?: readonly BattleUnitId[];
  /** Battle Observationの状態バージョン（`08_ドメインイベント.md`「状態バージョン」）。状態変更を伴わないイベントではBefore/Afterが一致する。 */
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  /** このイベントが所有する状態差分。子イベントとして内訳を表すだけの場合は`undefined`（「複合処理と状態差分の所有」）。 */
  readonly stateDelta?: StateDelta;
}

export interface ResourceRecoveryEntry {
  readonly battleUnitId: BattleUnitId;
  readonly apBefore: number;
  readonly apAfter: number;
  readonly ppBefore: number;
  readonly ppAfter: number;
}

export interface ActionReservationEntry {
  readonly battleUnitId: BattleUnitId;
  readonly reservedActionKind: ReservedActionKind;
  readonly actionSpeed: number;
}

export type EffectiveActionType = "AS" | "EX" | "WAIT" | "CHARGE_RELEASE";

/**
 * `06_戦闘状態遷移.md`「戦闘不能者の除去」/「R-ORD-01適格性の喪失」。`INELIGIBLE`
 * （Issue #180 PRレビュー[P1]再指摘）: キュー生成後、実行前に先行ユニットの行動
 * （気絶付与によるチャージキャンセル、凍結付与によるチャージ阻害など）で
 * R-ORD-01の全条件を失った予約を除去する。
 */
export type ActionReservationRemovalReason = "DEFEATED" | "INELIGIBLE";

export interface TargetBindingSelection {
  readonly targetBindingId: string;
  readonly selectedTargetUnitIds: readonly BattleUnitId[];
}

export interface ActionOrderEntry {
  readonly battleUnitId: BattleUnitId;
  readonly actionSpeed: number;
}

/** eventTypeごとのpayload定義。`08_ドメインイベント.md`の各イベント表「主なpayload」に対応する。 */
export interface BattleDomainEventPayloadMap {
  readonly BattleStarted: {
    readonly turnLimit: number;
    readonly allySlotCount: number;
    readonly enemySlotCount: number;
  };
  readonly TurnStarted: { readonly turnNumber: number };
  readonly ResourcesRecovered: { readonly units: readonly ResourceRecoveryEntry[] };
  readonly ActionQueueCreated: {
    readonly cycleNumber: number;
    readonly reservations: readonly ActionReservationEntry[];
  };
  readonly ActionReservationRemoved: {
    readonly battleUnitId: BattleUnitId;
    readonly reason: ActionReservationRemovalReason;
  };
  /** R-ORD-04: 未行動者だけを新しい行動速度順に並べ直す。予約種別(AS/EX)は変更しない。 */
  readonly ActionQueueReordered: {
    readonly before: readonly ActionOrderEntry[];
    readonly after: readonly ActionOrderEntry[];
  };
  readonly ActionStarted: {
    readonly actorUnitId: BattleUnitId;
    readonly reservedActionType: ReservedActionKind;
    readonly effectiveActionType: EffectiveActionType;
    readonly apBefore: number;
    readonly apAfter: number;
    readonly exBefore: number;
    readonly exAfter: number;
    readonly waitReason?: string;
  };
  readonly ActionWaited: {
    readonly actorUnitId: BattleUnitId;
    readonly waitReason: string;
    readonly consumedResource: ResourceKind;
    readonly consumedAmount: number;
  };
  readonly TargetsSelected: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly bindings: readonly TargetBindingSelection[];
  };
  readonly SkillUseStarting: {
    readonly skillDefinitionId: SkillDefinitionId;
    /**
     * Issue #144 follow-up: `EVENT_PAYLOAD field: "skillType"`を`SkillUseStarting`
     * eventType（`TRIGGER_POSITION_RELATION`対象のSKL_SUIRAN_CHAOS_PS3等）へ
     * 条件付けるproduction Catalog行が、`SkillUseCompleted`（Issue #143）と
     * 同じ理由でこのフィールドを必要とする。
     */
    readonly skillType: SkillType;
    readonly actorUnitId: BattleUnitId;
    readonly targetUnitIds: readonly BattleUnitId[];
    readonly costResource: ResourceKind;
    readonly costAmount: number;
  };
  readonly SkillUseStarted: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly costResource: ResourceKind;
    readonly costAmount: number;
  };
  readonly SkillUseCompleted: {
    readonly skillDefinitionId: SkillDefinitionId;
    /**
     * Issue #143: `RUNTIME_COUNTER_MODULO`対象skillが「AS/EX/PSをN回使用する
     * たびに発動」を`EVENT_PAYLOAD`で判定できるよう追加した。
     */
    readonly skillType: SkillType;
    readonly resolvedStepCount: number;
    readonly targetUnitIds: readonly BattleUnitId[];
  };
  /** R-SKL-01/06/07 #1〜#2: stepのcondition評価前（`08_ドメインイベント.md`「EffectStepStarting」）。`RANDOM_BRANCH`/`REPEAT`は自身のconditionを持たないため`conditionKind`は常に"TRUE"。 */
  readonly EffectStepStarting: {
    readonly stepIndex: number;
    readonly stepKind: EffectStepDefinition["kind"];
    readonly conditionKind: ConditionKind;
  };
  /** R-SKL-06 #2: conditionがfalseと評価され、step全体をスキップした時。 */
  readonly EffectStepSkipped: {
    readonly stepIndex: number;
    readonly conditionKind: ConditionKind;
    readonly result: false;
  };
  /** R-SKL-06: stepの解決完了後（`08_ドメインイベント.md`「EffectStepCompleted」）。使用者戦闘不能で中断したstepでは発行しない。 */
  readonly EffectStepCompleted: {
    readonly stepIndex: number;
    readonly resolvedActionCount: number;
  };
  /**
   * R-SKL-07（RES-003、Issue #173/#217）: `RANDOM_BRANCH`の分岐決定後
   * （`08_ドメインイベント.md`「RandomBranchSelected」）。`FACT`イベントとして
   * PS/Memory即時連鎖の契機になり得る。`WEIGHTED_ONE`は必ず1件、
   * `INDEPENDENT`は成立したbranchごとに1件ずつ発行する。
   */
  readonly RandomBranchSelected: {
    readonly stepIndex: number;
    readonly mode: RandomBranchMode;
    readonly branchIndex: number;
    readonly label?: string;
  };
  /** R-SKL-06 #4: 対象へEffectAction適用前（`08_ドメインイベント.md`「EffectActionStarting」）。PS/Memory連鎖による対象生存の再検証はこの直前に行う。 */
  readonly EffectActionStarting: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly kind: EffectActionKind;
    readonly targetUnitIds: readonly BattleUnitId[];
  };
  /** R-SKL-06 #5: EffectAction適用完了後（`08_ドメインイベント.md`「EffectActionCompleted」）。`lastResultReference`(R-SKL-08 直前結果)はM7スコープのため未対応。 */
  readonly EffectActionCompleted: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly effectActionKind: EffectActionKind;
    readonly targetUnitIds: readonly BattleUnitId[];
    readonly resultKind: EffectActionResultKind;
  };
  /**
   * `08_ドメインイベント.md`「UnitBeingAttacked」: 攻撃対象が確定した直後
   * （命中判定・ダメージ計算より前）に、ヒットごとに発行する（`TIMING`）。
   * R-EFF-07: `NEXT_INCOMING_ATTACK`消費条件はこのイベントの発行時点で
   * 消費する。EFF-003（Issue #159、レビュー修正 PR #209）が発行位置を
   * 最小追加した — `TRIGGER_SOURCE`/`TRIGGER_TARGET`のPS対象解決自体は
   * RES-005（Issue #172）のスコープのまま。
   */
  readonly UnitBeingAttacked: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
  };
  readonly HitConfirmed: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
  };
  /**
   * `08_ドメインイベント.md`「命中・会心イベント」「EvasionActivated」: R-HIT-02の
   * 特別な回避効果が成功した後（`UnitBeingAttacked`と`HitConfirmed`の間、hit
   * 判定に相当する位置）に発行する。MISSと同じくこのヒットには`HitConfirmed`
   * 以降のイベントを発行しない。
   */
  readonly EvasionActivated: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly effectInstanceId: EffectInstanceId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
  };
  /**
   * `08_ドメインイベント.md`「命中・会心イベント」「BlindnessCheckResolved」:
   * R-HIT-03「使用者に付与された暗闇を付与順に取得し、各暗闇の指定確率で
   * MISS判定を行う」の、暗闇1件ごとの判定結果。スキル使用ごとに1回、
   * `resolveEffectSequencePlan`の先頭で全ての暗闇を判定し切ってから
   * step解決へ進む（`SkillUseId`単位、ヒット単位ではない）。
   */
  readonly BlindnessCheckResolved: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly effectInstanceId: EffectInstanceId;
    readonly probability: number;
    readonly missed: boolean;
  };
  /**
   * `08_ドメインイベント.md`「スキルイベント」「SkillMissed」: R-HIT-03「いずれか
   * 一つの暗闇でMISSになった場合、そのスキル全体をMISSとして扱う」の結果、
   * このスキル使用の`EffectSequence`を一切解決しなかったことを表す。MISSを
   * 契機とするPS/Memoryは、対応するtrigger定義があればこのFACTイベントを
   * 契機に発動候補になれる。
   */
  readonly SkillMissed: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly missedByEffectInstanceIds: readonly EffectInstanceId[];
  };
  readonly CriticalCheckResolved: {
    readonly mode: CriticalMode;
    /** 元会心率（クランプ前）。 */
    readonly baseCriticalRate: number;
    /** 実効会心率（R-CRT-01: `min(100%, max(0%, 元会心率))`）。 */
    readonly effectiveCriticalRate: number;
    readonly result: boolean;
  };
  /**
   * `08_ドメインイベント.md`「ダメージイベント」「DamageWillBeApplied」（R-DMG-05 #4、
   * DMG-001／Issue #195）: 命中・会心が確定した後、ダメージ計算より前に、ヒットごとに
   * 発行する`TIMING`イベント。まだ何も適用していないため`stateDelta`を持たない。
   *
   * 同表の「主なpayload」は「発生源、対象、会心、貫通、補正」であり、発生源・対象は
   * イベント封筒の`sourceUnitId`/`targetUnitIds`が、会心（このヒットの確定した会心
   * 結果と倍率）と貫通（`piercing`の3割合）はこのpayloadが持つ。「補正」＝R-DMG-04の
   * 集計済みDamageModifier倍率は`DMG-002`（Issue #192）が
   * `outgoingDamageMultiplier`/`incomingDamageMultiplier`として追加した。ただし
   * これは**このイベントの発行時点のsnapshot**であり、下の「TIMINGイベント後の再検証」
   * のとおり連鎖が軽減効果を付け外しし得るため、確定値は`DamageCalculated`側が持つ。
   *
   * `08_ドメインイベント.md`「TIMINGイベント後の再検証」: このイベントに反応した
   * PS/Memoryは対象を戦闘不能にしたり、ダメージ無効・軽減効果を付与したりし得る。
   * `applyDamageActionSteps`は連鎖の解決後に発生源・対象の生存を再検証し、ダメージ
   * 計算の入力（`combatStats`・`AppliedEffect`）も連鎖後の最新状態から取り直す。
   */
  readonly DamageWillBeApplied: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
    readonly damageType: DamageType;
    /** R-CRT-*: このヒットで確定した会心結果（`CriticalCheckResolved.result`と同じ）。 */
    readonly isCritical: boolean;
    readonly criticalMultiplier: number;
    /** R-DMG-03の貫通3割合（EffectAction定義の`payload.piercing`）。 */
    readonly defenseIgnoreRate: number;
    readonly shieldIgnoreRate: number;
    readonly damageReductionIgnoreRate: number;
    /**
     * R-DMG-04（DMG-002、Issue #192）: このイベント発行時点で集計した与/被
     * ダメージ倍率のsnapshot。このイベントを契機とする連鎖が補正を付け外しし得る
     * ため、実際に計算へ使う確定値は`DamageCalculated`が持つ。
     */
    readonly outgoingDamageMultiplier: number;
    readonly incomingDamageMultiplier: number;
  };
  readonly DamageCalculated: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
    readonly attackerAttack: number;
    readonly defenderDefense: number;
    /** R-DMG-01の実効防御力（`defenderDefense * (1 - defenseIgnoreRate)`）。 */
    readonly effectiveDefense: number;
    /** R-DMG-03の貫通3割合（DMG-002／Issue #192が3つとも揃えた）。 */
    readonly defenseIgnoreRate: number;
    readonly shieldIgnoreRate: number;
    readonly damageReductionIgnoreRate: number;
    readonly skillPower: number;
    readonly attributeMultiplier: number;
    readonly criticalMultiplier: number;
    /**
     * R-DMG-01の与ダメージ倍率・被ダメージ倍率（R-DMG-04の集計結果、
     * DMG-002／Issue #192）。被ダメージ側は`damageReductionIgnoreRate`
     * （R-DMG-03）を負の補正へ適用した後の値である。
     */
    readonly outgoingDamageMultiplier: number;
    readonly incomingDamageMultiplier: number;
    /** R-DMG-01のAction内追加ダメージ倍率。 */
    readonly actionDamageMultiplier: number;
    /** 最終切り捨て・最低1ダメージ（R-DMG-02）を適用する前の値。 */
    readonly preTruncationDamage: number;
    readonly finalDamage: number;
    readonly damageType: DamageType;
  };
  /**
   * `08_ドメインイベント.md`「ダメージイベント」ShieldConsumed（DMG-004、
   * Issue #194、R-SHD-01〜03）: シールド値を減らした直後に、減らしたプール単位で
   * 発行する`FACT`。1ヒットが物理/ENのタイプありプールとタイプなしプールの
   * 両方を消費した場合は2件発行する（R-SHD-02の適用順のまま）。
   *
   * `reason`はこの減少の契機を区別する。
   * - `DAMAGE_ABSORPTION`: R-SHD-02のダメージ吸収。`hitIndex`を持つ
   * - `CONTINUOUS_DAMAGE_ABSORPTION`: R-DOT-02の固定継続ダメージ吸収（DMG-008、
   *   Issue #189）。特定のヒットに属さないため`hitIndex`を持たない。炎上・毒は
   *   そもそもシールドで受けないため（R-SUB-01）この理由では発行されない
   * - `DECAY`: `SHIELD_DECAY_OVER_TIME`（`APPLY_SHIELD.decay`）による行動ごとの
   *   漸減。特定のヒットに属さないため`hitIndex`を持たない
   *
   * `stateDelta`は減少した各`AppliedEffect.shield.remaining`の変化を持つ
   * （プール自体はインスタンス集合からの導出値であり、独立Reducerが復元するのは
   * インスタンス側である）。残量が0になったインスタンスの失効自体は、続く
   * `EffectExpired`（`reason: SHIELD_DEPLETED`）が別途表す。
   */
  readonly ShieldConsumed: {
    readonly effectActionDefinitionId?: EffectActionDefinitionId;
    readonly hitIndex?: number;
    readonly battleUnitId: BattleUnitId;
    readonly reason: ShieldConsumptionReason;
    /** `null`はタイプなしシールドプール。 */
    readonly shieldType: DamageType | null;
    readonly before: number;
    readonly after: number;
    readonly absorbed: number;
  };
  /**
   * `08_ドメインイベント.md`「HitPointReduced」: HPを減らした後に発行する
   * `FACT`（RES-005、Issue #172）。R-DMG-05の並び上は`DamageCalculated`と
   * `DamageApplied`の間 — シールド吸収（`ShieldConsumed`、DMG-004／Issue #194）を
   * 経てHPが確定した直後を表す（サブユニット吸収はDMG-005で加わる）。HP変化の
   * StateDeltaはこのイベントが持つ（`DamageApplied`はもう持たない — 同じdeltaを
   * 両方のイベントへ付けると独立Reducer復元が二重適用でエラーになるため）。
   */
  readonly HitPointReduced: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
    readonly hitPointDamage: number;
    readonly hpBefore: number;
    readonly hpAfter: number;
  };
  readonly DamageApplied: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
    readonly calculatedDamage: number;
    /**
     * DMG-004（Issue #194、R-SHD-02 #1）: `shieldIgnoreRate`分としてシールドを
     * 迂回しHPへ直接向かった量。`hitPointDamage`の内訳であり、独立した適用先では
     * ない（`shield-policy.ts`）。
     */
    readonly hpDirectDamage: number;
    /** DMG-004（R-SHD-02 #2）: ダメージタイプに対応するタイプありシールドの吸収量。 */
    readonly typedShieldAbsorbed: number;
    /** DMG-004（R-SHD-02 #3）: タイプなしシールドの吸収量。 */
    readonly untypedShieldAbsorbed: number;
    /**
     * DMG-004（R-SHD-03第2項）: HPを0未満にしないために破棄した超過分。
     * `08_ドメインイベント.md`の不変条件#6は
     * `typedShieldAbsorbed + untypedShieldAbsorbed + hitPointDamage + discardedDamage
     * === calculatedDamage`として成立する（HPクランプで消えた分をこの項が説明する）。
     */
    readonly discardedDamage: number;
    readonly hitPointDamage: number;
    readonly hpBefore: number;
    readonly hpAfter: number;
    readonly defeated: boolean;
  };
  /**
   * `08_ドメインイベント.md`「HealApplied payload」（M7-005、Issue #184、
   * R-HEAL-01〜03）: HP回復を適用した直後に発行する`FACT`。HP変化のStateDeltaは
   * このイベントが持つ（`HitPointReduced`と同じ規約 — 1つのHP変化を2つの
   * イベントへ付けると独立Reducer復元が二重適用でエラーになる）。
   * `sourceUnitId`はMemory由来の場合`sourceSide`へ置き換わる契約だが、Memory
   * 効果解決（M7-006、Issue #186）自体が未実装のため現時点では常に
   * `BattleUnitId`を持つ。
   */
  readonly HealApplied: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly sourceUnitId: BattleUnitId;
    readonly targetUnitId: BattleUnitId;
    /** R-HEAL-01 #1: Formula評価結果（`SKILL_POWER`は回復者の攻撃力×威力、整数化前・Modifier適用前）。 */
    readonly formulaResult: number;
    /**
     * HEAL_DISTRIBUTE（M7-005、Issue #184）: `payload.distribution: "EVEN"`の
     * 場合に総回復量を分配した対象数。分配しない場合は常に1。
     */
    readonly distributionShareCount: number;
    /** R-HEAL-02: `1 + APPLY_HEALING_MODの符号付き割合合計`（0未満は0）。 */
    readonly healingModifierMultiplier: number;
    /** R-HEAL-01 #2/#3: 適用直前に切り捨て整数化し、0未満を0にした回復量。 */
    readonly healAmount: number;
    /**
     * R-HEAL-04（M7-005-HEAL-LINK、Issue #229）: 回復リンクで転送先へ移し替えた
     * 合計量。転送しない場合は0。`StateDelta`は転送後に対象が保持した分だけを表し、
     * 転送分は各`HealingTransferred`の`StateDelta`が運ぶ。
     */
    readonly transferredAmount: number;
    /** R-HEAL-01 #4: 最大HPを超えない範囲で実際に増加したHP量（R-HEAL-04の転送分を除く）。 */
    readonly appliedAmount: number;
    /** R-HEAL-01「overheal: DISCARD」で破棄した最大HP超過分（`healAmount - transferredAmount - appliedAmount`）。 */
    readonly discardedAmount: number;
    readonly hpBefore: number;
    readonly hpAfter: number;
  };
  /**
   * `08_ドメインイベント.md`「HealingTransferred payload」（M7-005-HEAL-LINK、
   * Issue #229、R-HEAL-04）: 回復リンクによって転送先のHPを増加させた直後に発行
   * する`FACT`。転送先のHP変化の`StateDelta`はこのイベントが持つ（`HealApplied`と
   * 同じ規約）。`parentEventId`は転送の原因である`HealApplied`であり、転送によって
   * 生じた回復からさらに転送を発生させないため（R-HEAL-04の再リンク禁止）、この
   * イベントを親とする`HealingTransferred`は存在しない。
   */
  readonly HealingTransferred: {
    /** 転送を成立させた回復リンクの効果インスタンス。 */
    readonly effectInstanceId: EffectInstanceId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    /** 転送元（リンク保持者）。 */
    readonly fromUnitId: BattleUnitId;
    readonly toUnitId: BattleUnitId;
    readonly transferRate: number;
    /** `切り捨て(転送前回復量 × 転送率)`を未転送残量で上限をとった後の値。 */
    readonly transferredAmount: number;
    /** 転送先で最大HPを超えない範囲で実際に増加したHP量。 */
    readonly appliedAmount: number;
    readonly discardedAmount: number;
    readonly hpBefore: number;
    readonly hpAfter: number;
  };
  /**
   * `08_ドメインイベント.md`「継続ダメージイベント」（DMG-008、Issue #189、
   * R-DOT-01〜04）: 継続ダメージ1インスタンスの発生を適用し終えた直後に発行する
   * `FACT`。HP変化のStateDeltaはこのイベントが持つ（`HitPointReduced`／
   * `HealApplied`と同じ規約 — 1つのHP変化を2つのイベントへ付けると独立Reducer
   * 復元が二重適用でエラーになる）。
   *
   * 攻撃ダメージ（`DamageApplied`）と別のイベント種別にするのは、継続ダメージが
   * 攻撃ダメージと区別される必要がある規則が複数あるためである。
   * - R-DOT-01「ダメージ軽減・増加、属性相性の影響を受けない」（`DamageCalculated`
   *   payloadの会心倍率・実効防御力・与/被ダメージ倍率がそもそも存在しない）
   * - R-STS-03「解除対象となるダメージは新たに攻撃スキルによってダメージを受けた
   *   ときに限り、炎上や毒などによるダメージ…では解除されません」（凍結解除の契機に
   *   ならない）
   * - `hitIndex`（1つのDAMAGE EffectAction内のヒット番号）を持たない
   *
   * 継続回復が`HealApplied`を即時回復と共有する（M7-005）のと非対称だが、
   * これは即時回復とR-HEAL-01の手順を共有する継続回復と違い、継続ダメージが
   * R-DMG-01〜05のダメージpipelineをまったく通らないためである。
   */
  readonly ContinuousDamageApplied: {
    readonly effectInstanceId: EffectInstanceId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    /** R-DOT-02/03/04: 固定継続ダメージ／炎上／毒の別。 */
    readonly continuousDamageKind: ContinuousDamageKind;
    readonly damageType: DamageType;
    /** 保持者（＝ダメージを受ける対象）。 */
    readonly targetUnitId: BattleUnitId;
    /** R-DOT-01: 付与時に記録した付与者攻撃力。付与者の以後の状態・生死に影響されない。 */
    readonly snapshotAttack: number;
    /**
     * 種別ごとの素の算出値（切り捨て・最低1ダメージ・炎上2倍の適用前）。
     * `FIXED`/`BURN`は付与時に評価済みの固定量、`POISON`は発火時点の
     * `現在HP × 毒効果率`である。
     */
    readonly formulaResult: number;
    /** R-DOT-03: 対象が炎上を3つ保持している場合`2`、それ以外は`1`。 */
    readonly burnStackMultiplier: number;
    /** R-DOT-04: `上限ダメージ = 付与時攻撃力 × 100%`で頭打ちになった場合`true`。 */
    readonly cappedBySnapshotAttack: boolean;
    /** R-DOT-01: 小数部分を切り捨て、1未満を1へ引き上げた最終ダメージ。 */
    readonly calculatedDamage: number;
    /** R-DOT-02: タイプありシールド吸収量。`BURN`/`POISON`は常に0（R-SUB-01）。 */
    readonly typedShieldAbsorbed: number;
    /** R-DOT-02: タイプなしシールド吸収量。`BURN`/`POISON`は常に0。 */
    readonly untypedShieldAbsorbed: number;
    /** R-SHD-03第2項と同じ、HPを0未満にしないために破棄した超過分。 */
    readonly discardedDamage: number;
    readonly hitPointDamage: number;
    readonly hpBefore: number;
    readonly hpAfter: number;
    readonly defeated: boolean;
  };
  /**
   * `08_ドメインイベント.md`「EffectMerged」（DMG-008、Issue #189、R-DOT-04）:
   * 毒など固有規則で既存効果へ統合した直後に発行する`FACT`。R-DOT-04
   * 「効果期間は長い方、効果量は大きい方を引き継いだ一つの毒を残す。期間と効果量は
   * 別々の付与元から採用できる」の採用結果を、統合前後の効果量・残り期間として運ぶ。
   * `EffectApplied`は発行しない — 新規インスタンスを追加しないためである。
   */
  readonly EffectMerged: {
    /** 統合先（残る）インスタンス。既存インスタンスのIDをそのまま維持する。 */
    readonly effectInstanceId: EffectInstanceId;
    readonly battleUnitId: BattleUnitId;
    /** 統合後に採用した効果量側の`EffectActionDefinitionId`。 */
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly reason: "POISON_REAPPLY";
    readonly magnitudeBefore: number;
    readonly magnitudeAfter: number;
    readonly snapshotAttackBefore: number;
    readonly snapshotAttackAfter: number;
    /**
     * R-DOT-04「効果量は大きい方」の採用判断に使った、統合時点の対象HPで評価した
     * 1回あたり毒ダメージ（`min(現在HP × 効果率, 付与時攻撃力)`）。`magnitude*`は
     * 各インスタンスが自分の付与時点で評価した保存値であり評価時点が揃わないため、
     * この2値が無いとログから採否の理由を再現できない（PRレビュー[P1]）。
     *
     * R-DOT-01の切り捨て・最低1ダメージを適用する**前**の値であり、整数とは限らず
     * 1未満にもなりうる（再レビュー[P2]）— R-DOT-04が比較尺度とする「効果量」は
     * 丸め前の毒ダメージであり、丸めは発生時にR-DOT-01が最終結果へ適用する別規則
     * だからである。実際に与えるダメージは`ContinuousDamageApplied.calculatedDamage`。
     */
    readonly tickDamageBefore: number;
    readonly tickDamageAfter: number;
    readonly remainingBefore: number;
    readonly remainingAfter: number;
  };
  readonly UnitDefeated: {
    readonly unitId: BattleUnitId;
    readonly causeEventId: DomainEventId;
  };
  readonly ActionCompleting: {
    readonly actorUnitId: BattleUnitId;
    readonly effectiveActionType: EffectiveActionType;
  };
  readonly ActionCompleted: {
    readonly actorUnitId: BattleUnitId;
    readonly effectiveActionType: EffectiveActionType;
  };
  /** R-SKL-04: スキル使用開始時にクールタイムを設定する（`cooldown.count`が0のスキルでは発行しない）。 */
  readonly CooldownStarted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly unit: CooldownUnit;
    readonly initialRemaining: number;
  };
  /** R-SKL-04: 設定した行動・ターンの終了時には減らさず、次回以降の行動・ターン終了で1ずつ減らす。 */
  readonly CooldownReduced: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly unit: CooldownUnit;
    readonly before: number;
    readonly after: number;
  };
  /** R-SKL-04: 残数が0になった時。 */
  readonly CooldownCompleted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly unit: CooldownUnit;
  };
  /** R-SKL-05: チャージ開始をコスト消費・クールタイム設定に続く1つの行動として完了する。 */
  readonly ChargeStarted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly startedActionId: ActionId;
  };
  /** R-SKL-05: チャージ効果発動。チャージ開始とは別の1つの行動として完了する。 */
  readonly ChargeReleased: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly chargeStartActionId: ActionId;
    readonly releaseActionId: ActionId;
  };
  /** R-SKL-05/R-STS-02: 気絶付与時、発動待ちのチャージを維持せずキャンセルした後（`08_ドメインイベント.md`「チャージイベント」）。 */
  readonly ChargeCancelled: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly startedActionId: ActionId;
    readonly reason: "STUN";
  };
  /** R-SKL-05/R-STS-03: 凍結中の行動機会でチャージを維持したまま待機した後（発動を延期）。 */
  readonly ChargeHeldByFreeze: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly startedActionId: ActionId;
    readonly freezeEffectInstanceId: EffectInstanceId;
  };
  readonly TurnCompleting: { readonly turnNumber: number };
  readonly TurnCompleted: { readonly turnNumber: number };
  readonly BattleCompleted: {
    readonly outcome: BattleOutcome;
    readonly completionReason: CompletionReason;
    readonly completedTurn: number;
  };
  /** R-ACT-04: AP/PP/EXゲージ変更を確定した後の主イベント（`08_ドメインイベント.md:475`）。変化量0では発行しない。 */
  readonly ResourceChanged: {
    readonly battleUnitId: BattleUnitId;
    readonly resource: ResourceKind;
    readonly before: number;
    readonly after: number;
    /** Modifier適用後・capacity適用後の最終変化量（`after - before`と一致する）。 */
    readonly delta: number;
    /**
     * M7-002（Issue #185、R-ACT-04）: Modifier適用前・capacity適用前の基礎量。
     * 有効なリソース獲得量Modifier（`RESOURCE_GAIN_MOD`）が存在せず、かつ
     * capacity打ち止めも発生しない場合に限り`delta`と一致する。
     */
    readonly baseDelta: number;
    readonly reason: ResourceChangeReason;
    readonly causeEventId: DomainEventId;
  };
  /** R-PS-05 #2: PP消費の内訳（`ResourceChanged`の子イベント、`stateDelta`は持たない）。 */
  readonly PassivePointConsumed: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly before: number;
    readonly after: number;
    readonly consumedAmount: number;
  };
  /** R-ACT-03: AP・PP消費による増加の内訳（`ResourceChanged`の子イベント）。 */
  readonly ExtraGaugeIncreased: {
    readonly battleUnitId: BattleUnitId;
    readonly causeResource: "AP" | "PP";
    readonly before: number;
    readonly after: number;
    readonly increasedAmount: number;
  };
  /** R-ACT-03: EX最大値超過分を破棄した時（DIAGNOSTIC、`catalog-event-types.ts`の`DIAGNOSTIC_ONLY_EVENT_TYPES`）。 */
  readonly ExtraGaugeOverflowDiscarded: {
    readonly battleUnitId: BattleUnitId;
    /** M7-002（Issue #185）: Modifier適用前・capacity適用前の基礎量。 */
    readonly baseDelta: number;
    /** Modifier適用後・capacity適用前の要求増加量（Modifier不在なら`baseDelta`と同値）。 */
    readonly requestedAmount: number;
    /** 実際に反映された増加量（`delta`と同値。0を含む）。 */
    readonly actualAmount: number;
    readonly discardedAmount: number;
  };
  /** R-PS-05 #4: 発動済み集合への登録とPP消費後。 */
  readonly PassiveActivated: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly ppBefore: number;
    readonly ppAfter: number;
    readonly exBefore: number;
    readonly exAfter: number;
    readonly triggerEventId: DomainEventId;
  };
  /** R-PS-05 #6: PSのEffectSequence解決後（中断していない場合）。 */
  readonly PassiveResolved: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly resolvedStepCount: number;
  };
  /**
   * `08_ドメインイベント.md`「Memoryイベント」（M7-006、Issue #179、R-MEM-01〜04）:
   * Memory の1件の`triggeredEffect`の解決を開始した時。Memoryイベントは
   * `sourceUnitId`を持たず`sourceSide`（そのMemoryを指定した陣営）を持つ。
   */
  readonly MemoryTriggered: {
    readonly memoryDefinitionId: MemoryDefinitionId;
    /** R-MEM-02 #2「同一 Memory 内の`triggeredEffects`定義順」の位置。 */
    readonly triggeredEffectIndex: number;
    readonly sourceSide: Side;
    readonly triggerEventId: DomainEventId;
  };
  /** R-MEM-04: Memory の`triggeredEffect`の`EffectSequence`解決後。 */
  readonly MemoryResolved: {
    readonly memoryDefinitionId: MemoryDefinitionId;
    readonly triggeredEffectIndex: number;
    readonly sourceSide: Side;
    readonly resolvedStepCount: number;
  };
  /**
   * R-SKL-01: PS所有者が解決中に戦闘不能になり中断した時。Issue #217設計方針
   * B/C: `PassiveResolved`/`PassiveInterrupted`の選択は、実際に解決が最後まで
   * 進んだか使用者戦闘不能で打ち切ったかという事実だけから決まり、
   * `unresolvedEffectCount`の値からは導出しない。`unresolvedEffectCount`は
   * 中断時点で実際に開いていたACTION適用一覧のうち未処理のまま残った
   * 「効果単位」数の厳密値（レビュー指摘[P2]、PR #218 2度目の再レビュー:
   * 計数単位は実装`countHits`と一致させ、DAMAGEは残りヒットごとに1、
   * 非DAMAGEは残りapplication（対象1件×EffectAction1件、常にhits.length
   * === 1）ごとに1として数える）であり、まだ開始していないstep・branch・
   * iterationは常に0として扱う（静的な見積もりを行わないため、
   * `INTERRUPTED`かつこの値が0の組合せも正当）。
   */
  readonly PassiveInterrupted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly reason: "OWNER_DEFEATED";
    readonly unresolvedEffectCount: number;
  };
  /** R-SKL-01: AS/EX使用者が解決中に戦闘不能になり中断した時。`unresolvedEffectCount`の契約は`PassiveInterrupted`と同じ（Issue #217設計方針B/C）。 */
  readonly SkillUseInterrupted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly reason: "ACTOR_DEFEATED";
    readonly resolvedEffectCount: number;
    readonly unresolvedEffectCount: number;
  };
  /**
   * `R-EFF-11`/`08_ドメインイベント.md`「RuntimeCounterイベント」（M6最小実装、
   * Issue #143。`APPLIED_EFFECT`スコープはEFF-005/Issue #162で追加）。原因イベントの
   * 直後・候補抽出より前に採番する例外的な子イベント（「複合処理と状態差分の
   * 所有」参照）。`carry`は`CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数
   * （`INCREMENT`では常に0）。`carry`のみが変化した更新でもこのイベント自体は
   * 発行するため（追跡性のため、レビュー再々レビュー[P1]）、`valueChanged`
   * （`before !== after`、閾値を実際に跨いだかどうか）をCatalog側の閾値到達PS
   * 向けの絞り込み条件として持つ。`skillDefinitionId`/`effectInstanceId`は
   * `scope`に応じて排他的に存在する — `SKILL_RUNTIME`は`skillDefinitionId`のみ、
   * `APPLIED_EFFECT`は`effectInstanceId`のみを持つ。
   */
  readonly RuntimeCounterChanged: {
    readonly ownerUnitId: BattleUnitId;
    readonly scope: RuntimeCounterScope;
    readonly counter: RuntimeCounterId;
    readonly skillDefinitionId?: SkillDefinitionId;
    readonly effectInstanceId?: EffectInstanceId;
    readonly before: number;
    readonly after: number;
    readonly carry: number;
    readonly valueChanged: boolean;
  };
  /** `R-EFF-11`: 解決スコープ終了時、PS/Memory候補スタックが空になった後にcounterを破棄する。 */
  readonly RuntimeCounterReset: {
    readonly ownerUnitId: BattleUnitId;
    readonly scope: RuntimeCounterScope;
    readonly counter: RuntimeCounterId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly before: number;
  };
  /**
   * `05_ドメインモデル.md`「AppliedEffect」/`08_ドメインイベント.md`「EffectApplied
   * payload」（R-EFF-01）。新しい効果インスタンスを追加した直後に発行する。
   * `kindKey`は`EffectKindKey`（現状`EffectActionDefinitionId`をそのまま使う、
   * `applied-effect.ts`参照）。`durationUnit`/`durationOwner`/`initialRemaining`は
   * `timeLimit`を持つ場合だけ（`durationOwner`はさらに`timeLimit.owner`が
   * 明示された場合だけ）、`consumptionKind`/`consumptionMaxCount`は`consumption`
   * を持つ場合だけ、`expirationConditions`は`expiration`を持つ場合だけ存在する。
   * いずれも持たない場合は戦闘終了まで保持される。
   */
  readonly EffectApplied: {
    readonly effectInstanceId: EffectInstanceId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    /** R-MEM-04（Issue #179）: Memory由来の付与では`sourceSide`へ置き換わる。 */
    readonly sourceUnitId?: BattleUnitId;
    readonly sourceSide?: Side;
    readonly targetUnitId: BattleUnitId;
    readonly duplicate: boolean;
    readonly kindKey: string;
    /**
     * M7-011（Issue #265、`EFFECT_APPLIED_CLASSIFICATION_PAYLOAD`）: 付与した効果の
     * 分類。`kindKey`が`EffectActionDefinitionId`そのもので分類に使えないため、
     * `TriggerDefinition.condition`の`EVENT_PAYLOAD`が「デバフが付与された際」
     * 「状態異常が付与された際」を表現できるように併せて運ぶ。`categories`は
     * `effect-category-classifier.ts`（R-EFF-02/03の解除・免疫判定の正本）が導く
     * 集合で、R-STS-01により状態異常は`STATUS`と`DEBUFF`の両方を持つため配列。
     * 判定は`op: CONTAINS`で行う。値はソート済み（イベント列の決定性）。
     */
    readonly effectKind: EffectActionKind;
    readonly categories: readonly EffectImmunityCategory[];
    readonly magnitude: number;
    /** TGT-004フェーズ3（Issue #167、R-ACTN-03）: `APPLY_STATUS`由来の付与だけが持つ。 */
    readonly statusKind?: StatusKind;
    readonly durationUnit?: DurationTimeUnit;
    readonly durationOwner?: DurationOwner;
    readonly initialRemaining?: number;
    /** インスタンス自身の残り回数（付与直後は`initialRemaining`と同値。R-EFF-04/06の減算は`EffectDurationReduced`が別途表す、EFF-003スコープ）。 */
    readonly remainingCount?: number;
    readonly consumptionKind?: ConsumptionKind;
    readonly consumptionMaxCount?: number;
    /** インスタンス自身の消費残り回数（付与直後は`consumptionMaxCount`と同値。R-EFF-07の消費は`EffectConsumptionChanged`が別途表す、EFF-003スコープ）。 */
    readonly consumptionRemaining?: number;
    readonly expirationConditions?: readonly ConditionDefinition[];
    readonly linkedEffectGroupId: string | null;
    readonly grantedActionId?: ActionId;
    readonly grantedTurnNumber?: number;
    readonly snapshot?: Readonly<Record<string, number>>;
  };
  /**
   * `08_ドメインイベント.md`「EffectApplicationRejected payload」（M7-001B、
   * Issue #243、R-EFF-03）: `EFFECT_IMMUNITY`由来の有効な免疫が対象カテゴリの
   * 新規付与を拒否した直後に発行する。実際に`AppliedEffect`は作られない
   * （`EffectApplied`は発行しない）ため、この事実自体を記録する専用イベント。
   * `statusKind`は拒否対象が`APPLY_STATUS`由来の場合だけ持つ（`EffectApplied`と
   * 同じ規約）。
   */
  readonly EffectApplicationRejected: {
    readonly battleUnitId: BattleUnitId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    /** R-MEM-04（Issue #179）: Memory由来の付与では`sourceSide`へ置き換わる。 */
    readonly sourceUnitId?: BattleUnitId;
    readonly sourceSide?: Side;
    readonly blockingEffectInstanceId: EffectInstanceId;
    readonly reason: EffectApplicationRejectionReason;
    readonly statusKind?: StatusKind;
  };
  /**
   * `08_ドメインイベント.md`「EffectiveEffectChanged」: R-EFF-05の重複なし効果で
   * 採用対象が変わった時に、`EffectKindKey`ごとに発行する。`before`/`after`は
   * 採用中のインスタンスID（グループに1件も無ければ`undefined`）。同時に複数の
   * `EffectKindKey`グループの採用対象が変わった場合は、グループごとに別の
   * イベントとして発行する。
   */
  readonly EffectiveEffectChanged: {
    readonly battleUnitId: BattleUnitId;
    readonly kindKey: string;
    readonly before?: EffectInstanceId;
    readonly after?: EffectInstanceId;
  };
  /**
   * `EffectApplied`のコメントが予告する`EffectDurationReduced`（EFF-003）。
   * R-EFF-04/06: 行動単位・ターン単位効果の残り回数を1減らすたび（0になる
   * 減算も含む）に発行する。`CooldownReduced`と同じ「減算そのものを
   * 独立Reducer復元可能にする」役割 — `EffectExpired`は0になった後の失効
   * 事実だけを表し、この事件自体（`before`/`after`のstateDelta）は持たない
   * ため、両方をあわせて発行する。
   */
  readonly EffectDurationReduced: {
    readonly effectInstanceId: EffectInstanceId;
    readonly battleUnitId: BattleUnitId;
    readonly unit: Extract<DurationTimeUnit, "ACTION" | "TURN" | "SKILL_USE">;
    readonly before: number;
    readonly after: number;
  };
  /**
   * R-STS-02「再付与時は残り回数が長い方を一つだけ残す」: 気絶の既存
   * `AppliedEffect`インスタンスへ、より長い残り回数を持つ再付与が到達した場合に
   * 発行する（同一インスタンスを新しい残り回数へ差し替える。`EffectDurationReduced`
   * が表す自然減算とは逆方向・別契機のため独立したイベント種別を持つ）。既存の
   * 残り回数が新しい付与以上の場合は何も変更せず、イベントも発行しない
   * （`MarkerApplied`のKEEP_EXISTING方針と同じ「変化が無ければ発行しない」規約）。
   */
  readonly StunDurationChanged: {
    readonly effectInstanceId: EffectInstanceId;
    readonly battleUnitId: BattleUnitId;
    readonly remainingBefore: number;
    readonly remainingAfter: number;
    readonly reason: "REGRANT_EXTENDED";
  };
  /**
   * R-STS-03（M7-004、Issue #183）「新たな攻撃スキルによるダメージで解除する」:
   * 対象の凍結中に、その対象へのDAMAGE EffectActionのヒットが確定した直後
   * （`DamageCalculated`の後、`HitPointReduced`の前）に発行する。継続ダメージ・
   * デバフのみのスキルでは`applyDamageAction`自体を経由しないため、構造的に
   * この解除契機の対象外（R-STS-03「継続ダメージやデバフだけのスキルでは
   * 解除しない」）。`triggeringDamage`は増幅適用後の最終ダメージ。
   */
  readonly FreezeRemoved: {
    readonly effectInstanceId: EffectInstanceId;
    readonly battleUnitId: BattleUnitId;
    readonly triggeringDamage: number;
  };
  /**
   * `08_ドメインイベント.md`「効果イベント」EffectConsumptionChanged。R-EFF-07:
   * 消費条件の成立ごとに、消費残り回数の変化を発行する（0になる消費も含む）。
   */
  readonly EffectConsumptionChanged: {
    readonly effectInstanceId: EffectInstanceId;
    readonly battleUnitId: BattleUnitId;
    readonly kind: ConsumptionKind;
    readonly before: number;
    readonly after: number;
  };
  /**
   * `08_ドメインイベント.md`「効果イベント」EffectExpired/「EffectExpiredの順序」。
   * R-EFF-04/06/07/08: 残り回数（時間制限・消費）が0になった、または
   * `expiration.conditions`が成立した効果インスタンスを即時に失効させた直後に
   * 発行する。R-EFF-09: `linkedEffectGroupId`を共有する子効果の連動失効も
   * `cascaded: true`として同じイベント種別で表す（子を先に、親を後に発行する）。
   */
  readonly EffectExpired: {
    readonly effectInstanceId: EffectInstanceId;
    readonly battleUnitId: BattleUnitId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly kindKey: string;
    readonly reason: EffectExpirationReason;
    readonly linkedEffectGroupId: string | null;
    /** R-EFF-09: 親効果の失効・解除に連動して失効した子効果である場合`true`。 */
    readonly cascaded: boolean;
  };
  /**
   * `08_ドメインイベント.md`「効果イベント」EffectRemoved（R-EFF-02）: `REMOVE_EFFECTS`
   * による明示的な効果解除で`AppliedEffect`を除去した直後に発行する。時間制限・
   * 消費・特殊失効による自然失効（`EffectExpired`）とは区別する — 解除は外部
   * スキルが能動的に取り除いた事実を表す。`MarkerRemoved`と同じく、R-EFF-09の
   * `linkedEffectGroupId`カスケードで巻き込まれた子効果は`cascaded: true`/
   * `reason: LINKED_GROUP_CASCADE`として同じ種別で表す（子を先に、親を後に発行）。
   */
  readonly EffectRemoved: {
    readonly effectInstanceId: EffectInstanceId;
    readonly battleUnitId: BattleUnitId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly kindKey: string;
    readonly reason: EffectRemovalReason;
    readonly linkedEffectGroupId: string | null;
    readonly cascaded: boolean;
  };
  /**
   * `08_ドメインイベント.md`「Markerイベント」/R-EFF-10: 新しい`MarkerState`
   * インスタンスを追加した直後に発行する（ADD/KEEP_EXISTING/REFRESH/REPLACEの
   * いずれも、既存Markerが無い場合はこのイベントになる）。`EffectApplied`と同じ
   * 「`timeLimit`/`consumption`/`expiration`を持つ場合だけ対応フィールドを持つ」
   * 規約に従う。
   */
  readonly MarkerApplied: {
    readonly markerInstanceId: MarkerInstanceId;
    readonly markerId: MarkerId;
    /**
     * R-MEM-04（M7-008、Issue #176）: Memory の `triggeredEffects` 由来の付与だけは
     * 具体的な付与者ユニットを持たず、`sourceSide`（そのMemoryを指定した陣営）を
     * 持つ（`EffectApplied`と同じ規約）。
     */
    readonly sourceUnitId?: BattleUnitId;
    readonly sourceSide?: Side;
    readonly targetUnitId: BattleUnitId;
    readonly stackCount: number;
    readonly stackMax: number | null;
    readonly durationUnit?: DurationTimeUnit;
    readonly durationOwner?: DurationOwner;
    readonly initialRemaining?: number;
    readonly remainingCount?: number;
    readonly consumptionKind?: ConsumptionKind;
    readonly consumptionMaxCount?: number;
    readonly consumptionRemaining?: number;
    readonly expirationConditions?: readonly ConditionDefinition[];
    readonly linkedEffectGroupId: string | null;
  };
  /**
   * `08_ドメインイベント.md`「MarkerUpdated payload」/R-EFF-10: 既存`MarkerState`の
   * スタック数・Durationを変更した直後に発行する。`policy`が呼び出し契機になった
   * `stack.policy`（ADD/KEEP_EXISTING/REFRESH/REPLACE、KEEP_EXISTINGは無変化の
   * ためこのイベント自体を発行しない）を運ぶ`APPLY_MARKER`経由の更新と、
   * `policy`を持たない行動・ターン単位のDuration減算（R-EFF-04/06相当、
   * `EffectDurationReduced`のMarker版を専用イベント種別として持たない代わりに
   * ここへ統合する）の両方をこの1種別で表す — `08_ドメインイベント.md`の
   * Markerイベント表がAppliedEffectより少ない3種別しか持たない設計に合わせた
   * 意図的な統合。
   */
  readonly MarkerUpdated: {
    readonly markerInstanceId: MarkerInstanceId;
    readonly markerId: MarkerId;
    readonly targetUnitId: BattleUnitId;
    /** R-MEM-04: Memory由来の付与・更新だけが`sourceSide`側を持つ（`MarkerApplied`と同じ）。 */
    readonly sourceUnitId?: BattleUnitId;
    readonly sourceSide?: Side;
    readonly policy?: MarkerStackPolicy;
    readonly stackBefore: number;
    readonly stackAfter: number;
    readonly durationUnit?: DurationTimeUnit;
    readonly remainingBefore?: number;
    readonly remainingAfter?: number;
    readonly linkedEffectGroupId: string | null;
  };
  /**
   * `08_ドメインイベント.md`「Markerイベント」/R-EFF-10「Markerが0スタックに
   * なった場合は解除」: 明示的な`REMOVE_MARKER`、時間制限・消費・特殊失効に
   * よる自然消滅、`linkedEffectGroupId`を共有する親の失効に連動したカスケードの
   * いずれかで`MarkerState`を除去した直後に発行する（`EffectExpired`と同じ
   * cascade表現、R-EFF-09）。
   */
  readonly MarkerRemoved: {
    readonly markerInstanceId: MarkerInstanceId;
    readonly markerId: MarkerId;
    readonly targetUnitId: BattleUnitId;
    readonly reason: MarkerRemovalReason;
    readonly linkedEffectGroupId: string | null;
    readonly cascaded: boolean;
  };
  /**
   * `08_ドメインイベント.md`「CombatStatChanged」: R-STA-04の再計算後、実際に
   * 値が変わったstatごとに発行する（変化が無いstatでは発行しない）。
   */
  readonly CombatStatChanged: {
    readonly battleUnitId: BattleUnitId;
    readonly stat: StatKind;
    readonly before: number;
    readonly after: number;
    readonly reason: CombatStatChangeReason;
  };
}

/**
 * `07_戦闘ルール詳細.md` R-STA-04が列挙する再計算契機のうち、現時点で実際に
 * 到達可能なもの（`APPLY_STAT_MOD`の付与・EFF-003の失効）だけを持つ。
 * 「メモリー効果の有効/無効条件の変化」はRES-005のスコープで到達可能になった
 * 時点で追加する。
 */
export type CombatStatChangeReason = "EFFECT_APPLIED" | "EFFECT_EXPIRED" | "EFFECT_REMOVED";

/**
 * `07_戦闘ルール詳細.md` R-EFF-04/06/07/08/09: 効果インスタンスが失効した理由。
 * `LINKED_GROUP_CASCADE`は、自身は時間制限・消費・特殊失効のいずれにも達して
 * いないが、`linkedEffectGroupId`を共有する親効果の失効・解除に連動して失効
 * した子効果自身の理由（`EffectExpired.cascaded`も併せて`true`にする）。
 */
export type EffectExpirationReason =
  | "TIME_LIMIT"
  | "CONSUMPTION"
  | "EXPIRATION_CONDITION"
  /**
   * R-SHD-01第3項（DMG-004、Issue #194）: シールドの残量が0になったことによる
   * 「個別消滅条件」。時間制限（`TIME_LIMIT`）でも`DurationDefinition.consumption`
   * （`CONSUMPTION`）でもない、シールド固有の失効契機である。
   */
  | "SHIELD_DEPLETED"
  | "LINKED_GROUP_CASCADE";

/** `ShieldConsumed.reason`: シールド残量が減った契機（DMG-004、Issue #194）。 */
export type ShieldConsumptionReason =
  | "DAMAGE_ABSORPTION"
  | "CONTINUOUS_DAMAGE_ABSORPTION"
  | "DECAY";

/**
 * `07_戦闘ルール詳細.md` R-EFF-10: `MarkerState`が除去された理由。`REMOVED`は
 * 明示的な`REMOVE_MARKER`によるスタック全解除（現行スキーマでは唯一の
 * スタック即時ゼロ化経路）。`SOURCE_DEFEATED`は`duration.removeOnSourceDefeated`
 * を宣言したMarkerの付与者（`MarkerState.sourceId`）が戦闘不能になったことによる
 * 解除（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020、Issue #279）で、`MarkerState`
 * だけが持つ解除契機である（`AppliedEffect`は付与者の戦闘不能を見る失効機構を
 * 持たないため`EffectExpirationReason`には含めない）。残りは
 * `EffectExpirationReason`と同じ意味（時間制限・消費・特殊失効・
 * `linkedEffectGroupId`カスケード）を持つ。
 */
export type MarkerRemovalReason =
  | "REMOVED"
  | "TIME_LIMIT"
  | "CONSUMPTION"
  | "EXPIRATION_CONDITION"
  | "SOURCE_DEFEATED"
  /**
   * `SOURCE_DEFEATED`と対になるAppliedEffect固有の契機（DMG-004、Issue #194、
   * R-SHD-01）。`MarkerState`はシールド残量を持たないため`MarkerRemoved`が
   * この理由を直接運ぶことはなく、シールド失効に連動して解除されるMarkerは
   * R-EFF-09どおり`LINKED_GROUP_CASCADE`を運ぶ。この型が
   * `EffectExpirationReason`・`EffectRemovalReason`・Marker固有理由の和である
   * という契約（`linked-group-cascade.ts`の`LinkedGroupRemoval.reason`）を
   * 保つために列挙する。
   */
  | "SHIELD_DEPLETED"
  | "LINKED_GROUP_CASCADE";

/**
 * `07_戦闘ルール詳細.md` R-EFF-02/R-EFF-09: `AppliedEffect`が`REMOVE_EFFECTS`で
 * 解除された理由。`REMOVED`は解除スキルが直接対象にしたインスタンス、
 * `LINKED_GROUP_CASCADE`は`linkedEffectGroupId`を共有する親の解除に連動した
 * 子効果（`cascaded: true`）。時間制限・消費・特殊失効による自然失効は
 * `EffectExpired`（`EffectExpirationReason`）が表し、この型には含めない。
 */
export type EffectRemovalReason = "REMOVED" | "LINKED_GROUP_CASCADE";

/**
 * `07_戦闘ルール詳細.md` R-EFF-03（M7-001B、Issue #243）: `EffectApplicationRejected`
 * の拒否理由。現時点では`EFFECT_IMMUNITY`による免疫拒否だけを表す
 * `IMMUNITY`のみだが、`EffectRemovalReason`/`EffectExpirationReason`と同じ
 * 閉じたunionとして今後の拒否理由追加に備える。
 */
export type EffectApplicationRejectionReason = "IMMUNITY";

/**
 * `08_ドメインイベント.md`「EffectActionCompleted payload」。M6時点では
 * `REJECTED`(効果適用拒否、`AppliedEffect`前提のM7スコープ)を生成しない。
 */
export type EffectActionResultKind = "APPLIED" | "SKIPPED" | "MISSED" | "REJECTED" | "INTERRUPTED";

/** `08_ドメインイベント.md`「ResourceChanged payload」。 */
export type ResourceChangeReason =
  | "SKILL_COST"
  | "WAIT_COST"
  | "EX_GAIN"
  | "EFFECT_ACTION"
  | "TURN_RECOVERY";

export type BattleDomainEventType = keyof BattleDomainEventPayloadMap;

/**
 * `08_ドメインイベント.md`が定義するイベントの判別共用体。M3の19種別に加え、
 * M5（issue #20）が`ActionWaited`/`ActionReservationRemoved`を追加する。
 */
export type BattleDomainEvent = {
  readonly [Type in BattleDomainEventType]: DomainEventEnvelope & {
    readonly eventType: Type;
    readonly payload: BattleDomainEventPayloadMap[Type];
  };
}[BattleDomainEventType];
