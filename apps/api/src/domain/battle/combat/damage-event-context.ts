import type { BattleUnit } from "../model/battle-unit.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import type {
  DomainEventId,
  ActionId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ResolveBreakHook } from "../events/break-resolution.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type {
  AccuracyMode,
  ConsumptionKind,
  DamageType,
  SkillType,
} from "../../catalog/definitions/catalog-enums.js";
import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { AttackDeathSurvivalLedger } from "./defensive-intervention-policy.js";

/**
 * R-SUB-02: 1スキル使用（EffectSequence）の中で、ある対象へまだ加えていないサブユニット
 * 追加ヒット。元攻撃がその対象を最初に狙ったDAMAGEで作り、以後のDAMAGEの会心を合算する。
 *
 * - `damageType`／`accuracyMode`: その対象を最初に狙ったDAMAGEのもの（追加ダメージの
 *   ダメージタイプ既定と命中特性の継承元）
 * - `critical`: そのスキル使用でその対象へのヒットが1つでも会心だったか
 * - `sourceEffectInstanceIds`: その対象を狙ったDAMAGEの解決開始時点で使用者が保持していた
 *   サブユニット（初出順）。DAMAGEの途中の連鎖で付与されたサブユニットは同じ攻撃へ加えない
 */
export interface PendingSubUnitAddition {
  readonly damageType: DamageType;
  readonly accuracyMode: AccuracyMode;
  critical: boolean;
  readonly sourceEffectInstanceIds: EffectInstanceId[];
}

/**
 * R-SUB-02: 1スキル使用（EffectSequence）が共有するサブユニット追加ヒットの台帳。
 * `resolveEffectSequencePlan`がEffectSequenceごとに新規生成する（mutable）。
 *
 * - `pending`: まだ解決していない対象（Mapの挿入順＝対象の初出順）
 * - `added`: 既に加えた「サブユニットのインスタンス|対象」。同じ対象へ2度加えない
 * - `nextHitIndex`: 追加ヒットのヒット番号。スキル使用の中で通し番号にする
 */
export interface SubUnitAdditionLedger {
  readonly pending: Map<BattleUnitId, PendingSubUnitAddition>;
  readonly added: Set<string>;
  nextHitIndex: number;
}

export function emptySubUnitAdditionLedger(): SubUnitAdditionLedger {
  return { pending: new Map(), added: new Set(), nextHitIndex: 0 };
}

export interface DamageHitOutcome {
  readonly targetUnitId: BattleUnitId;
  readonly hitIndex: number;
  /** false when the hit was skipped instead of applied (target already defeated, or MISS). */
  readonly applied: boolean;
  readonly isCritical: boolean;
  readonly damage: number;
}

/**
 * R-FUP-01（Issue #474）: 1回のAS/EXスキル使用が横断的に蓄積する追撃（攻撃ライダー）の
 * 捕捉。呼び出し側（`action-skill-use-resolver.ts`）がスキル使用ごとに
 * {@link emptyFollowUpAttackCapture}で1つ生成して`DamageEventContext`へ渡し、
 * `applyDamageActionSteps`が命中判定へ到達したヒットを基準に書き込む（mutable）。
 *
 * - `riders`: 攻撃側がヒット観測開始時点で保持していた`isFollowUpAttack`効果。
 *   `NEXT_OUTGOING_ATTACK`の消費と同じ到達点で捕捉することで、「相乗りする攻撃」と
 *   「バフを消費する攻撃」を同一に保つ。インスタンス自身は最初のDAMAGE EffectActionの
 *   末尾で失効するため、追撃解決に必要な定義参照だけをここへ写す
 * - `attackedTargetUnitIds`: 命中判定へ到達したヒットの対象（初出順・重複なし。
 *   R-SUB-02「攻撃が誰を狙ったか」と同じ規約で、戦闘不能スキップは含めない）
 * - `anyApplied`/`anyCritical`: スキル使用内の全DAMAGE EffectActionを合算した
 *   「1発でも命中したか」「1発でも会心になったか」。追撃の発生可否と会心継承の素材
 */
export interface FollowUpAttackCapture {
  readonly riders: Map<
    EffectInstanceId,
    {
      readonly effectActionDefinitionId: EffectActionDefinitionId;
      readonly sourceUnitId?: BattleUnitId;
    }
  >;
  readonly attackedTargetUnitIds: BattleUnitId[];
  anyApplied: boolean;
  anyCritical: boolean;
  /** R-FUP-01 #3: このスキル使用の追撃を解決済みか（DAMAGE区間の終わりで1回だけ解決する）。 */
  resolved: boolean;
}

/** {@link FollowUpAttackCapture}の初期値。1回のスキル使用ごとに新規生成する。 */
export function emptyFollowUpAttackCapture(): FollowUpAttackCapture {
  return {
    riders: new Map(),
    attackedTargetUnitIds: [],
    anyApplied: false,
    anyCritical: false,
    resolved: false,
  };
}

export interface ApplyDamageActionResult {
  readonly units: readonly BattleUnit[];
  readonly hits: readonly DamageHitOutcome[];
  /**
   * 使用者が戦闘不能になったことで未処理のまま残ったヒット数。MISSや対象の戦闘不能に
   * よる通常のスキップ（`DamageHitOutcome.applied`が`false`になる別のケース）は含まない
   * — 使用者(attacker)が戦闘不能になる前に到達したヒットは、命中/MISSに関わらず
   * 「解決済み」として数える。
   */
  readonly interruptedCount: number;
  /**
   * 使用者の戦闘不能で未解決の効果を残したまま打ち切った場合`true`。
   * `interruptedCount`とは別に持つ（HEALの`ApplyHealActionResult.interrupted`と同じ理由）
   * — R-SUB-02のサブユニット追加ヒットは`hits`に含まれないため、追加ヒットの解決中に
   * 使用者が戦闘不能になっても`interruptedCount`は0のままになり、そのままでは
   * `effect-action-group-resolver.ts`が`EffectActionCompleted`を`APPLIED`として発行して
   * 後続stepまで進んでしまう。
   */
  readonly interrupted: boolean;
  /**
   * このEffectAction適用中に実際に記録された最後のイベントID（最終ヒットの
   * `DamageApplied`、致死なら`UnitDefeated`）。呼び出し側が
   * `EffectActionCompleted.parentEventId`をこれへ設定することで、イベントログの直接因果が
   * 実際の解決経路（`EffectActionStarting`固定ではない）を表せるようにする。全ヒットが
   * スキップ・中断されて何も記録されなかった場合は`context.parentEventId`のまま変化しない。
   */
  readonly lastEventId: DomainEventId;
}

/** `applyDamageActionSteps`がyieldする1ステップ（記録済みイベント列と、その時点の`units`）。 */
export interface DamageStep {
  readonly events: readonly BattleDomainEvent[];
  readonly units: readonly BattleUnit[];
}

/** ヒットイベント（HitConfirmed〜UnitDefeated）が共有する因果関係コンテキスト。全て`ActionStarted`の解決スコープに属する。 */
export interface DamageEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** PSがターン開始・終了など行動外のトップレベルイベントから発動した場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** 各ヒットの直接の契機（`SkillUseStarted.eventId`）。ヒット同士は互いを親としない。 */
  readonly parentEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
  /**
   * R-CFS-02（DMG-009）: このDAMAGEを発生させたスキルの種別。混乱は「アクティブスキルで
   * 攻撃する際」だけに働くため、`AS`かどうかをここで判別する。`skillDefinitionId`から
   * 引けば済むように見えるが、`combat/`はCatalogの`skillDefinitions`マップへ到達できない
   * （`onFactEventForPassiveChain`等と同じmodule境界）ため、呼び出し側（`lifecycle/`）が
   * 解決して渡す。
   *
   * 未指定なら混乱の効果を適用しない — 「ASかどうか分からない攻撃」を混乱の対象に含めると、
   * 継続ダメージ由来のような非スキル経路まで巻き込むためである（R-DTH-01の幻惑はスキル種別を
   * 問わないため、この値を参照しない）。
   */
  readonly skillType?: SkillType;
  /**
   * R-FUP-01（Issue #474）: AS/EXスキル使用側（`action-skill-use-resolver.ts`）だけが
   * 渡す追撃捕捉。未指定なら捕捉を行わない — PS/Memory自身のEffectSequenceや
   * チャージ解放の攻撃は追撃の相乗り対象外（消費だけが起こる）である。
   */
  readonly followUpAttackCapture?: FollowUpAttackCapture;
  /**
   * R-SUB-02: このスキル使用（EffectSequence）のサブユニット追加ヒット台帳。指定時は
   * 台帳へ記録するだけで、追加ヒットはDAMAGE区間の終わりにまとめて解決する
   * （`releasePendingSubUnitAdditionsSteps`）。追加は攻撃1回につき元攻撃の対象ごと・
   * 各体1ヒットで、会心はスキル使用全体のその対象へのヒットから継承する。未指定なら
   * このDAMAGE EffectActionの直後に解決する（単体のDAMAGE解決テスト用）。
   */
  readonly subUnitAdditions?: SubUnitAdditionLedger;
  /**
   * `DamageApplied`（および`UnitDefeated`）の確定直後にPS即時連鎖を同期的に解決するフック。
   * 呼び出し側（`lifecycle/`、Domain層のmodule境界により`combat/`自身は`triggering/`へ
   * 依存できない）が注入する。戻り値の`units`をそのまま以後の`working`として使う。
   * 未指定ならPS解決を行わない（R-SKL-06のACTION step単位の即時解決は本フックの範囲外で、
   * 本フックはR-SKL-01/02が要求する「ヒットごとの直ちの解決」までを満たす）。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
  /**
   * R-EFF-07: `ownerUnitId`が保持する`kind`一致の消費条件効果を1消費する
   * （`EffectConsumptionChanged`発行）。`onFactEventForPassiveChain`と同じ理由
   * （Domain層のmodule境界により`combat/`は`effects/`へ依存できない）で
   * 呼び出し側（`lifecycle/`）が注入する。未指定なら消費条件を評価しない。
   *
   * 消費回数が0になったインスタンスの実際の除去・CombatStat再計算は、この呼び出しの
   * 中では行わない場合がある（`NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`は
   * `14_Catalog定義スキーマ.md`「上限に到達した効果は、該当するEffectActionの解決後に
   * 失効する」契約のため、呼び出し側の実装が`finalizeConsumedEffectDurations`まで
   * 遅延させる）。このヒットの会心・ダメージ計算は、消費し終えた直後の`units`
   * （まだ除去前のcombatStats）をそのまま使ってよい。
   *
   * 凍結解除（`removeFreezeEffect`）と同じくステップを`yield`するgeneratorを返す。
   * 消費で0になったインスタンスの失効はR-EFF-09のカスケードを伴い、そのカスケード分・
   * seed分の各除去は「次の除去へ進む前にPS/Memory連鎖へ通知する」必要があるため
   * （まとめて最終stateで通知すると、子`EffectExpired`のwatcherが親を既に除去済みとして
   * 観測する）。
   */
  readonly consumeEffectDuration?: (
    ownerUnitId: BattleUnitId,
    kind: ConsumptionKind,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
    /** R-HIT-04: 指定時はこの1インスタンスだけを消費する（Nヒット回避の自己消費）。 */
    effectInstanceId?: EffectInstanceId,
    /** R-EFF-07: `consumption.damageType`を宣言した効果の照合に使う、契機の攻撃のタイプ。 */
    attackDamageType?: DamageType,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * `consumeEffectDuration`が遅延させた消費済みインスタンス
   * （`NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`）を、このEffectAction
   * （`applyDamageAction`1回分、全ヒット）の解決完了後にまとめて失効させる
   * （`EffectExpired`発行、CombatStat再計算を含む）。`consumeEffectDuration`と同じ理由で
   * 呼び出し側が注入する。未指定、または遅延対象が無ければ何もしない。
   */
  /**
   * R-EFF-07: 同じACTION stepの別のDAMAGE（別の攻撃）が使い切り、その攻撃の終了まで失効を
   * 待っている効果のうち、この攻撃が消費していないもの。この攻撃の計算と吸収には参加させない。
   */
  readonly suspendedEffectInstanceIds?: ReadonlySet<EffectInstanceId>;
  /**
   * R-EFF-07: {@link suspendedEffectInstanceIds}を除いて能力値を計算し直したユニット。
   * 攻撃側・防御側の命中・回避・会心・貫通・補正・ダメージ式・無効の判定でだけ使い、
   * `working`へは書き戻さない。未指定ならユニットそのもの。
   */
  readonly unitView?: (unit: BattleUnit) => BattleUnit;
  /**
   * R-EFF-07: 以後のヒットを新しい1回の攻撃として数え始める。1つの`DamageEventContext`で
   * 複数の攻撃を順に解決する呼び出し（追撃ライダーごとの追撃、R-FUP-01）が、前の攻撃の
   * `finalizeConsumedEffectDurations`を済ませてから呼ぶ。
   */
  readonly beginNextAttack?: () => void;
  readonly finalizeConsumedEffectDurations?: (
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-SKL-08: `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`が参照する「同じ解決スコープ内の
   * 直前DAMAGE結果」を保持する、呼び出し側が1解決スコープ（1行動、または行動外トップレベル
   * イベント）ごとに新規生成する共有registry。未指定なら
   * `LAST_DAMAGE_DEALT`/`LAST_DAMAGE_RECEIVED`を要求するFormulaは`FormulaEvaluator`が
   * 明確な例外で拒否する。
   */
  readonly damageResults?: DamageResultRegistry;
  /**
   * R-TEX-02: 戦闘モードが`TACTICAL_EXERCISE`のときだけ呼び出し側（`lifecycle/`）が
   * 渡す、Battleが所有する演習状態。HPへ向かったダメージ量をここへ計上し
   * `ExerciseScoreAccumulated`を発行する。未指定なら通常戦闘であり、スコア計上も
   * イベント発行も一切行わない。
   */
  readonly exercise?: ExerciseRuntime;
  /**
   * R-TEX-03: 演習の敵ユニットのHPが0へ到達したとき、戦闘不能に代えてブレイク・復活を
   * 解決する`BreakResolutionService`。`removeFreezeEffect`等とまったく同じ理由
   * （`combat/`は`effects/`へ依存できない、module境界）で呼び出し側が注入する。
   *
   * `exercise`を指定しながらこれを省略した場合、敵のHP0到達は`UnitDefeated`へ
   * 落ちる代わりに明確な例外になる（`requireResolveBreak`）— 配線漏れが
   * 「その経路だけ演習が終了する」という形で潜伏しないようにするためである。
   */
  readonly resolveBreak?: ResolveBreakHook;
  /**
   * R-ACTN-01 #2: このヒット列を解決した対象が`TargetSelectorDefinition.includeDefeated:
   * true`で選択された場合`true`。未指定（`false`扱い）なら、これまでどおり参照時点で既に
   * 戦闘不能な対象へのヒットを適用しない。`true`の場合は、対象が戦闘不能であることを理由に
   * ヒットをスキップしない — DAMAGEも他のEffectAction種別と同じ明示指定を尊重する
   * （`effect-action-group-resolver.ts`の非DAMAGE分岐と対になる契約）。
   */
  readonly includeDefeated?: boolean;
  /**
   * CAP_TRIGGER_CONTEXT（RES-005）: このPSを発動させた原因イベントの発生源・対象の
   * `BattleUnitId`。`FormulaSourceReference.kind: TRIGGER_SOURCE`/`TRIGGER_TARGET`を持つ
   * DAMAGE Formulaの評価に使う。`TRIGGER_TARGET`は複数ユニットを指しうるが、Formula側は
   * 単一参照のため先頭の1体を使う（R-TGT-10と同じ規約）。未指定ならこれらを要求する
   * Formulaは`FormulaEvaluator`が明確な例外で拒否する。
   *
   * `BattleUnit`ではなくIDを保持する — ヒットごとのループで先行するヒットが対象のHP・
   * combatStatsを変更しうるため、Formula評価の直前に`working`（このヒット時点の最新状態）
   * から都度引き直す。
   */
  readonly triggerSourceUnitId?: BattleUnitId;
  readonly triggerTargetUnitIds?: readonly BattleUnitId[];
  /**
   * R-SKL-08（`TRIGGER_SKILL_USE_DAMAGE_*`）: このPSを発動させた原因イベントが属する
   * スキル使用の`SkillUseId`。元攻撃全体で与えた・受けたダメージの合計を引く鍵になる。
   * AS/EX使用・Memory由来の解決や、スキル使用に属さない契機では`undefined`。
   */
  readonly triggerSkillUseId?: SkillUseId;
  /**
   * R-STS-03（凍結解除）＋R-EFF-09（`linkedEffectGroupId`カスケード）: 呼び出し側
   * （`lifecycle/`、`combat/`は`effects/`へ依存できないため）が注入する、凍結除去の完全な
   * 処理（`FreezeRemoved`発行、同グループの未失効子効果があれば`duration-expiry-service.ts`
   * と同じ順序・イベント形でカスケード除去、`recalculateCombatStats`）。未指定の場合は
   * `AppliedEffect`を直接filterし`FreezeRemoved`だけを発行する簡易版へfallbackする
   * （カスケード・CombatStat再計算は行わない — 既存テストが`effects/`層のモックを用意
   * しなくても動き続けるための最小動作）。
   *
   * カスケードの各ステップを`yield`するgeneratorを返す — `context.onFactEventForPassiveChain`
   * が指定されていれば（AS/EX・チャージ解放）`applyDamageActionSteps`がこのgeneratorを
   * 同期的に駆動しステップごとに通知する。未指定（PS自身のEffectSequence解決）なら
   * `applyDamageActionSteps`自身が`yield`し、呼び出し元
   * （`resolveOneEffectActionApplication`）が`driveActivation`の共有stateへ正しく参加させる。
   * `.next()`へ渡す値は、そのyield中にPS連鎖が変化させた最新の`units`（変化が無ければ
   * 渡さない）。
   */
  readonly removeFreezeEffect?: (
    targetUnitId: BattleUnitId,
    freezeEffectInstanceId: EffectInstanceId,
    triggeringDamage: number,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-SHD-01第3項／R-SUB-01「個別消滅条件」（DMG-004／DMG-005）: 残量が0になったシールド
   * インスタンス、または耐久力が0になったサブユニットインスタンスを`EffectExpired`
   * （`reason: SHIELD_DEPLETED` / `SUBUNIT_DEPLETED`）として失効させ、R-EFF-09の
   * `linkedEffectGroupId`カスケード（production例: `SKL_LILY_SINGER_PS2`「シールドの消滅と
   * 共に攻撃力バフも消滅する」）とCombatStat再計算まで行う完全な処理。`removeFreezeEffect`と
   * まったく同じ理由（`combat/`は`effects/`へ依存できない、module境界）で呼び出し側
   * （`lifecycle/`）が注入し、同じ「除去1件ごとに`yield`する」規約を持つ。
   *
   * 未指定の場合は`AppliedEffect`を直接filterし`EffectExpired`だけを発行する簡易版へ
   * fallbackする（カスケード・CombatStat再計算は行わない — `removeFreezeEffect`のfallbackと
   * 同じ、hookを用意しない単体テスト用の最小動作）。
   */
  readonly expireDepletedAbsorbers?: (
    targetUnitId: BattleUnitId,
    depletedEffectInstanceIds: readonly EffectInstanceId[],
    reason: DepletedAbsorberReason,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-SUB-02第3項（`SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`、DMG-005）: サブユニットの追加
   * ダメージに付随するデバフを、追加ダメージを与えた対象へ付与する。
   * `expireDepletedAbsorbers`とまったく同じ理由（`combat/`は`effects/`とCatalogの
   * `effectActions`マップへ到達できない）で呼び出し側が注入し、同じ「1件ごとに`yield`する」
   * 規約を持つ。未指定なら追加デバフを付与しない（hookを用意しない単体テストでは追加
   * ダメージだけが起きる）。
   */
  readonly grantSubUnitAdditionalDamageDebuff?: (
    targetUnitId: BattleUnitId,
    debuffEffectActionDefinitionId: EffectActionDefinitionId,
    ownerUnitId: BattleUnitId,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-INT-01 #5（`APPLY_DEATH_SURVIVAL.healAfterSurvival`、DMG-006）: 致死を耐えた直後の
   * 回復をR-HEAL-01の手順（`heal-application-service.ts`の`applyOneHealSteps`、
   * HealingModifier・overheal破棄・回復リンク転送を含む）で適用する。
   * `grantSubUnitAdditionalDamageDebuff`とまったく同じ理由（`combat/`は`lifecycle/`へ
   * 依存できない、module境界）で呼び出し側が注入し、同じ「1件ごとに`yield`する」規約を持つ。
   * 未指定なら耐えた後の回復を行わない（hookを用意しない単体テストでは`survivalHp`まで
   * 戻すだけになる）。
   *
   * 回復元・回復対象はどちらも耐えたユニット自身である（`healAfterSurvival`は
   * `APPLY_DEATH_SURVIVAL`の保持者が自力で立ち直る効果であり、付与者の回復量補正を受ける
   * 規則をR-INT-01もCatalog schemaも持たない）。
   */
  /**
   * R-INT-01 #5: この攻撃で致死を耐えたユニットの台帳。同じ攻撃の適用（範囲攻撃の各対象・
   * R-SUB-02の追加ヒット・反射やリンクの派生ダメージ）で共有する。未指定なら
   * `applyDamageActionSteps`がその1回の解決だけの台帳を作る。
   */
  readonly attackDeathSurvivals?: AttackDeathSurvivalLedger;
  /**
   * R-INT-01 #5: 同じstepのまだ終わっていない別の攻撃が耐えに使い、その攻撃の終了で消費する
   * 予定の回数（効果インスタンスごと）。この攻撃はその回数を除いて残る耐えだけを使う。
   */
  readonly reservedDeathSurvivals?: ReadonlyMap<EffectInstanceId, number>;
  /**
   * R-INT-01 #5＋R-SUB-02: 攻撃の終了時に呼ぶ。保留中の追加ヒットがあり、致死耐えの精算を
   * その解決後まで呼び出し側が預かった場合`true`を返す（このときここでは精算しない）。
   */
  readonly holdAttackDeathSurvivals?: (ledger: AttackDeathSurvivalLedger) => boolean;
  readonly applyDeathSurvivalHeal?: (
    targetUnitId: BattleUnitId,
    effectActionDefinitionId: EffectActionDefinitionId,
    formula: FormulaDefinition,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-FUP-01（Issue #474）: 追撃ヒットが適用された対象へ`onHitEffects`の1件
   * （`FOLLOW_UP_ON_HIT_EFFECT_KINDS`のいずれか）を付与する。
   * `grantSubUnitAdditionalDamageDebuff`とまったく同じ理由（`combat/`は`effects/`と
   * Catalogの`effectActions`マップへ到達できない）で呼び出し側が注入し、同じ
   * 「1件ごとに`yield`する」規約を持つ。`sourceUnitId`は付与の帰属先（ライダーを
   * 付与したユニット。Memory由来等で不明なら攻撃者へフォールバックする）。
   */
  /**
   * R-DMG-05 #2a: DAMAGEの`hitConfirmedEffects`の1件を、最初の命中が確定した対象へ
   * 付与する。`grantFollowUpOnHitEffect`と同じ理由で呼び出し側が注入し、同じ
   * 「1件ごとに`yield`する」規約を持つ。未指定なら付与しない。
   */
  readonly grantHitConfirmedEffect?: (
    targetUnitId: BattleUnitId,
    effectActionDefinitionId: EffectActionDefinitionId,
    attackerUnitId: BattleUnitId,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  readonly grantFollowUpOnHitEffect?: (
    targetUnitId: BattleUnitId,
    onHitEffectActionDefinitionId: EffectActionDefinitionId,
    attackerUnitId: BattleUnitId,
    sourceUnitId: BattleUnitId | undefined,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
}

/**
 * `expireDepletedAbsorbers`が運ぶ「吸収先を使い切った」失効理由。R-SHD-01第3項の
 * シールド枯渇とR-SUB-01のサブユニット枯渇は、どちらも時間制限でも消費条件でもない
 * 個別消滅条件であり、失効経路（`expireEffectsSteps`）を共有する。
 */
export type DepletedAbsorberReason = "SHIELD_DEPLETED" | "SUBUNIT_DEPLETED";
