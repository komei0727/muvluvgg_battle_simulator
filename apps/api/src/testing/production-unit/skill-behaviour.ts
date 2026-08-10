import { fileURLToPath } from "node:url";
import {
  isExUsable,
  selectAsCandidate,
} from "../../domain/battle/action/action-selection-policy.js";
import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import type { DamageResultRegistry } from "../../domain/battle/skill/formula-evaluator.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { evaluateActivationCondition } from "../../domain/battle/lifecycle/activation-condition-evaluator.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import {
  resolveChargeRelease,
  resolveChargeStart,
} from "../../domain/battle/lifecycle/action-charge-resolver.js";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyEffectActionGroups } from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import type { Attribute, UnitType } from "../../domain/catalog/definitions/catalog-enums.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetReference } from "../../domain/catalog/definitions/references.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { BattleDomainEventType } from "../../domain/battle/events/domain-event.js";
import { createActionId, createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";
import {
  definitionsWith,
  noMissNoCrit,
  skillFrom,
  testBattleUnit,
  testMarker,
  testUnitDefinition,
  effectActionGroupContext,
  seedRecorder,
  unitFrom,
  type SeededRecorder,
} from "../fixtures/index.js";
import { applyProductionEffect } from "./effect-application.js";
import {
  openPassiveChain,
  type PassiveChain,
  type PassiveTriggerEvent,
} from "./passive-activation.js";
import type { RealDamageTrigger, RealEffectApplicationTrigger } from "./trigger-events.js";

/**
 * ユニット単位production結合テスト（`__tests__/production-catalog/units/`）の
 * 振る舞い表を駆動する共通ハーネス（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は **EffectAction ではなくスキル使用1回**。実 `catalog/` の未改変定義を
 * 実経路（AS/EXは`selectAsCandidate`→`resolveSkillUse`、PSは
 * `PassiveActivationRuntime`）へ通し、次の4点を1つの観測へまとめる。
 *
 * 1. 発動したか（`activationCondition`・クールタイム・AP・対象候補、PSはtrigger条件）
 * 2. 誰が対象になったか（production の `targetBindings`/`filters`/`order` をそのまま通す）
 * 3. どの分岐の腕が選ばれたか（`actions` が実行済みEffectActionを実行順に持つ）
 * 4. 何が起きたか（HP・効果付与/解除・マーカー・リソース収支・クールタイム）
 *
 * 変化しなかった観測項目はキーごと落とすため、`toEqual` の完全一致が
 * 「宣言した振る舞いが起きること」と「余計なことを起こさないこと」を同時に固定する。
 */

export const PRODUCTION_CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

/** 相手役ユニット定義のID。実Catalogのユニットとは無関係な最小定義を使う。 */
export const STAND_IN_UNIT_ID = "UNIT_TEST_PRODUCTION_STAND_IN";

export const SUBJECT_ID = "ally:subject";

/**
 * 効果量を桁で読める値に固定する。会心率0・属性相性0により乱数と属性倍率が
 * 観測へ混ざらず、`SKILL_POWER` のダメージは `(攻撃力 - 防御力) × power` の
 * 切り捨てそのものになる。防御力を0にしないのは、`DEFENSE` のstat modが実効値を
 * 動かしたこと（`CombatStatChanged`）まで観測できるようにするため。
 */
export const BOARD_COMBAT_STATS: CombatStats = {
  maximumHp: 10000,
  attack: 1000,
  defense: 500,
  criticalRate: 0,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

export const BOARD_LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 };

/**
 * 盤面の初期状態。上限にも0にも触れていない中間値へ置くことで、増減どちらの
 * `MODIFY_RESOURCE`／`HEAL`／`DAMAGE`も境界で丸められずに観測できる
 * （満タンHPでは`overheal: DISCARD`のHEALが、満タンAPでは加算が消える）。
 * `CURRENT_HP_RATIO`系Formulaの評価点もこの1点で決まる。
 */
export const BOARD_INITIAL_STATE = {
  currentHp: BOARD_COMBAT_STATS.maximumHp / 2,
  currentAp: BOARD_LIMITS.maximumAp,
  currentPp: BOARD_LIMITS.maximumPp,
  currentExtraGauge: 0,
} as const;

export interface BoardMarkerSpec {
  readonly markerId: string;
  readonly stackCount?: number;
}

/**
 * 混乱（R-CFS-01）を保持している状態を盤面の前提として作る。
 *
 * 混乱を付与するproduction定義は `ACT_OLGA_VETERAN_EX_CONFUSION` の1件だけで、
 * 検証対象ユニットのスナップショットには載らない（`loadProductionSnapshot` は
 * 対象ユニット分しか読まない）。前提そのものは検証対象ではないため、`statusDetails`
 * だけをその実定義と同じ値（`damageReductionRate: 0.3`／`lowAttackBaseDamageRate: 0.1`）
 * で組み立てる。**反転そのものは合成しない** — 対象がどちら側の誰へ振り替わるかは
 * `resolveSkillOrder` の実処理が決める。
 */
export function confusionStatus(targetUnitId: string): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_TEST_CONFUSION");
  return {
    effectInstanceId: createEffectInstanceId(`B_BEHAVIOUR:confusion:${targetUnitId}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceUnitId: createBattleUnitId("enemy:front"),
    targetUnitId: createBattleUnitId(targetUnitId),
    magnitude: 0,
    categories: ["DEBUFF"],
    statusKind: "CONFUSION",
    statusDetails: { confusion: { damageReductionRate: 0.3, lowAttackBaseDamageRate: 0.1 } },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

export interface BoardUnitSpec {
  readonly id: string;
  readonly position: FormationPosition;
  /** 属性。`TARGET_STATE.ATTRIBUTE` を読む条件の成立／不成立を作り分けるために使う。 */
  readonly attribute?: Attribute;
  /**
   * ユニット種別。`TARGET_STATE.UNIT_TYPE` は `UnitDefinition` から読むため、
   * 種別ごとに別のスタンドイン定義を登録する必要がある（既定は `PHYSICAL`）。
   */
  readonly unitType?: UnitType;
  /** 省略時はスタンドイン定義。実Catalogの別ユニットを置きたい場合だけ指定する。 */
  readonly unitDefinitionId?: string;
  /**
   * この1体だけの戦闘ステータス上書き。`HIGHEST_ATTACK` のように**盤面の中で誰が
   * 上位か**で対象が決まる order を判別するために使う（盤面全体を動かす
   * `BoardOverrides.combatStats` では相対順位が作れない）。
   */
  readonly combatStats?: Partial<CombatStats>;
  /** HP・リソース・クールタイムなどの前提状態。 */
  readonly state?: Partial<BattleUnit>;
  /**
   * 保持済みマーカー。`MarkerState` は対象ユニットIDを要るため、盤面ビルダーが
   * ユニットを組んだ後に構築する（表からは `markerId` と段数だけを宣言する）。
   */
  readonly markers?: readonly BoardMarkerSpec[];
}

/**
 * 既定の相手役配置。敵は3体（前列2・後列1）置き、`count: 1` + `order` の
 * 対象選択が「どれを選んだか」で差が出るようにする。味方も前後に散らして
 * 位置条件（`POSITION_RELATION`・行/列フィルタ）が判別できるようにする。
 */
const DEFAULT_ALLIES: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];

const DEFAULT_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

export interface BoardOverrides {
  /** 検証対象ユニットの配置と前提状態。 */
  readonly subject?: {
    readonly position?: FormationPosition;
    /**
     * 属性。実戦闘では `UnitDefinition` をそのまま写す（R-ATR-02）が、盤面は
     * 相手役も含め既定の `AGGRESSIVE` で揃えて属性相性倍率を観測から外している。
     * 「自身を含む◯◯属性の味方に」のように**自分の属性が対象集合を決める**定義だけ、
     * その行で実定義の属性を明示して自身を成立側へ入れる（攻撃を伴わない効果に限る —
     * 指定すると相手役との相性倍率がダメージへ乗る）。
     */
    readonly attribute?: Attribute;
    readonly state?: Partial<BattleUnit>;
    readonly markers?: readonly BoardMarkerSpec[];
  };
  /** 既定の味方配置を差し替える。 */
  readonly allies?: readonly BoardUnitSpec[];
  /** 既定の敵配置を差し替える。 */
  readonly enemies?: readonly BoardUnitSpec[];
  readonly combatStats?: Partial<CombatStats>;
}

export interface ProductionBoard {
  readonly units: readonly BattleUnit[];
  readonly subject: BattleUnit;
  readonly definitions: BattleDefinitions;
}

/** ユニット種別ごとに別IDのスタンドイン定義を持つ（`UNIT_TYPE` 条件の作り分け用）。 */
function standInDefinitionId(unitType: UnitType | undefined): string {
  return unitType === undefined ? STAND_IN_UNIT_ID : `${STAND_IN_UNIT_ID}_${unitType}`;
}

function boardUnit(
  spec: BoardUnitSpec,
  side: Side,
  combatStats: CombatStats,
  fallbackDefinitionId: string,
): BattleUnit {
  const unit = testBattleUnit({
    battleUnitId: spec.id,
    unitDefinitionId:
      spec.unitDefinitionId ??
      (spec.unitType === undefined ? fallbackDefinitionId : standInDefinitionId(spec.unitType)),
    side,
    position: spec.position,
    ...(spec.attribute === undefined ? {} : { attribute: spec.attribute }),
    combatStats: { ...combatStats, ...spec.combatStats },
    limits: BOARD_LIMITS,
    overrides: { ...BOARD_INITIAL_STATE, ...spec.state },
  });
  if (spec.markers === undefined || spec.markers.length === 0) {
    return unit;
  }
  return {
    ...unit,
    markerStates: spec.markers.map((marker, index) =>
      testMarker(unit, marker.markerId, {
        ...(marker.stackCount === undefined ? {} : { stackCount: marker.stackCount }),
        markerInstanceId: `MARKER_INSTANCE_${spec.id}_${index}`,
      }),
    ),
  };
}

/**
 * 検証対象ユニット1体 + 味方2体 + 敵3体の盤面。相手役は実Catalogのユニットでは
 * なく最小定義にして、相手側のPS・特性が観測へ混ざらないようにする。
 */
export function productionBoard(
  snapshot: BattleCatalogSnapshot,
  unitDefinitionId: string,
  overrides: BoardOverrides = {},
): ProductionBoard {
  const combatStats = { ...BOARD_COMBAT_STATS, ...overrides.combatStats };
  const subject = boardUnit(
    {
      id: SUBJECT_ID,
      position: overrides.subject?.position ?? { column: "CENTER", row: "FRONT" },
      unitDefinitionId,
      ...(overrides.subject?.attribute === undefined
        ? {}
        : { attribute: overrides.subject.attribute }),
      ...(overrides.subject?.state === undefined ? {} : { state: overrides.subject.state }),
      ...(overrides.subject?.markers === undefined ? {} : { markers: overrides.subject.markers }),
    },
    "ALLY",
    combatStats,
    unitDefinitionId,
  );
  const allies = (overrides.allies ?? DEFAULT_ALLIES).map((spec) =>
    boardUnit(spec, "ALLY", combatStats, STAND_IN_UNIT_ID),
  );
  const enemies = (overrides.enemies ?? DEFAULT_ENEMIES).map((spec) =>
    boardUnit(spec, "ENEMY", combatStats, STAND_IN_UNIT_ID),
  );
  const unitTypes = new Set(
    [...(overrides.allies ?? DEFAULT_ALLIES), ...(overrides.enemies ?? DEFAULT_ENEMIES)]
      .map((spec) => spec.unitType)
      .filter((unitType): unitType is UnitType => unitType !== undefined),
  );
  return {
    units: [subject, ...allies, ...enemies],
    subject,
    definitions: definitionsWith(snapshot, {
      units: [
        STAND_IN_UNIT_ID,
        ...[...unitTypes].map((unitType) =>
          testUnitDefinition(standInDefinitionId(unitType), { unitType }),
        ),
      ],
    }),
  };
}

/** 実行されたEffectAction 1件。分岐で選ばれなかった腕はここに現れない。 */
export interface ObservedAction {
  readonly effectActionDefinitionId: string;
  readonly targets: readonly string[];
  /** `APPLIED` 以外のときだけ現れる（SKIPPED / MISSED / REJECTED / INTERRUPTED）。 */
  readonly resultKind?: string;
}

/** 付与・解除された効果。期間・消費条件の**宣言**も観測に含める。 */
export interface ObservedEffect {
  readonly unitId: string;
  readonly effectActionDefinitionId: string;
  readonly magnitude: number;
  /** `duration.definition` から写した宣言（`timeLimit`/`consumption` が無ければ省略）。 */
  readonly timeLimit?: { readonly unit: string; readonly count: number; readonly owner?: string };
  readonly consumption?: { readonly kind: string; readonly maxCount: number };
  readonly statusKind?: string;
}

export interface ObservedMarker {
  readonly unitId: string;
  readonly markerId: string;
  readonly stackCount: number;
}

export interface ObservedResource {
  readonly unitId: string;
  readonly resource: "AP" | "PP" | "EX_GAUGE";
  readonly delta: number;
}

export interface ObservedCooldown {
  readonly unitId: string;
  readonly skillDefinitionId: string;
  readonly remaining: number;
}

/**
 * スキル使用1回の観測結果。**変化が無かった項目はキーごと落とす**ため、表の
 * 期待値は「そのスキル使用が本当に起こしたこと」だけを列挙できる。
 */
export interface SkillUseObservation {
  /** 発動しなかったときだけ `false` が現れる（発動した場合はキーごと省略）。 */
  readonly activated?: false;
  readonly actions?: readonly ObservedAction[];
  readonly hpDeltas?: Readonly<Record<string, number>>;
  readonly effectsApplied?: readonly ObservedEffect[];
  readonly effectsRemoved?: readonly ObservedEffect[];
  /** 増えたMarker（段数が変わった場合は変化後の段数で現れる）。 */
  readonly markers?: readonly ObservedMarker[];
  /** 消えたMarker。`REMOVE_MARKER` が実際に剥がしたことはここにしか現れない。 */
  readonly markersRemoved?: readonly ObservedMarker[];
  readonly resources?: readonly ObservedResource[];
  readonly cooldowns?: readonly ObservedCooldown[];
  /**
   * チャージ状態（R-SKL-05）の変化。開始で保持スキルIDが、解放で `null` が現れる。
   * `resolution.kind: CHARGE` のスキルは開始と解放で別々の行動になるため、
   * どちらを観測したのかがこの欄だけで読める。
   */
  readonly charge?: string | null;
}

export type SkillUse =
  | {
      readonly kind: "ACTIVE";
      readonly skillDefinitionId: string;
      readonly actionType?: "AS" | "EX";
    }
  | {
      /**
       * `resolution.kind: CHARGE` のスキル。`START` はチャージ開始の行動だけを、
       * `RELEASE` は開始を基準線へ繰り込んだうえで `chargeRelease` EffectSequence
       * だけを観測する（実戦闘でも両者は別の行動であり、同じ観測には載らない）。
       */
      readonly kind: "CHARGE";
      readonly skillDefinitionId: string;
      readonly phase: "START" | "RELEASE";
    }
  | {
      readonly kind: "PASSIVE";
      readonly skillDefinitionId: string;
      /**
       * 契機イベント。PSは実際に発行されたイベントからしか発動しない。
       * {@link RealDamageTrigger}／{@link RealEffectApplicationTrigger} を渡した
       * 場合は実pipeline・実 resolver が発行したイベントをそのまま契機に使う
       * （payload欄の欠落や、実装が載せた分類そのものまで検出できる）。
       */
      readonly trigger:
        | PassiveTriggerEvent<BattleDomainEventType>
        | RealDamageTrigger
        | RealEffectApplicationTrigger;
      /** 契機イベントの発行元（`ActionStarted` のactor）。既定は敵前列。 */
      readonly triggeredBy?: string;
      /** `TURN_NUMBER` を読む条件のための評価ターン。既定は1。 */
      readonly turnNumber?: number;
    };

function effectSummaries(units: readonly BattleUnit[]): readonly ObservedEffect[] {
  return units.flatMap((unit) =>
    unit.appliedEffects.map((effect) => {
      const definition = effect.duration.definition;
      return {
        unitId: unit.battleUnitId,
        effectActionDefinitionId: effect.effectActionDefinitionId,
        magnitude: effect.magnitude,
        ...(definition.timeLimit === undefined
          ? {}
          : {
              timeLimit: {
                unit: definition.timeLimit.unit,
                count: definition.timeLimit.count,
                ...(definition.timeLimit.owner === undefined
                  ? {}
                  : { owner: definition.timeLimit.owner }),
              },
            }),
        ...(definition.consumption === undefined
          ? {}
          : {
              consumption: {
                kind: definition.consumption.kind,
                maxCount: definition.consumption.maxCount,
              },
            }),
        ...(effect.statusKind === undefined ? {} : { statusKind: effect.statusKind }),
      };
    }),
  );
}

function markerSummaries(units: readonly BattleUnit[]): readonly ObservedMarker[] {
  return units.flatMap((unit) =>
    unit.markerStates.map((marker) => ({
      unitId: unit.battleUnitId,
      markerId: marker.markerId,
      stackCount: marker.stackCount,
    })),
  );
}

function cooldownEntries(units: readonly BattleUnit[]): readonly ObservedCooldown[] {
  return units.flatMap((unit) =>
    Object.entries(unit.cooldowns).map(([skillDefinitionId, state]) => ({
      unitId: unit.battleUnitId,
      skillDefinitionId,
      remaining: (state as { remaining: number }).remaining,
    })),
  );
}

/** 多重集合の差分（同一内容が複数あっても件数で数える）。 */
function differenceOf<T>(after: readonly T[], before: readonly T[]): readonly T[] {
  const remaining = before.map((item) => JSON.stringify(item));
  return after.filter((item) => {
    const index = remaining.indexOf(JSON.stringify(item));
    if (index === -1) {
      return true;
    }
    remaining.splice(index, 1);
    return false;
  });
}

function resourceDeltas(
  after: readonly BattleUnit[],
  before: readonly BattleUnit[],
): readonly ObservedResource[] {
  const beforeById = new Map(before.map((unit) => [unit.battleUnitId, unit]));
  const observed: ObservedResource[] = [];
  for (const unit of after) {
    const previous = beforeById.get(unit.battleUnitId);
    if (previous === undefined) {
      continue;
    }
    const pairs = [
      ["AP", unit.currentAp - previous.currentAp],
      ["PP", unit.currentPp - previous.currentPp],
      ["EX_GAUGE", unit.currentExtraGauge - previous.currentExtraGauge],
    ] as const;
    for (const [resource, delta] of pairs) {
      if (delta !== 0) {
        observed.push({ unitId: unit.battleUnitId, resource, delta });
      }
    }
  }
  return observed;
}

function executedActions(events: readonly BattleDomainEvent[]): readonly ObservedAction[] {
  return events
    .filter(
      (event): event is Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }> =>
        event.eventType === "EffectActionCompleted",
    )
    .map((event) => ({
      effectActionDefinitionId: event.payload.effectActionDefinitionId,
      targets: [...event.payload.targetUnitIds],
      ...(event.payload.resultKind === "APPLIED" ? {} : { resultKind: event.payload.resultKind }),
    }));
}

const PRECEDING_SKILL_ID = "SKL_TEST_PRECEDING";
const PRECEDING_BINDING_ID = "TGT_TEST_PRECEDING";

const PRECEDING_TRAITS: SkillDefinition["traits"] = {
  priorityAttack: false,
  simultaneousActivationLimited: false,
  exclusiveActivationGroupId: null,
  accuracy: { guaranteedHit: false },
  piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
};

const ALLY_EXCEPT_SELF: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ALLY",
  count: 1,
  filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } }],
  order: ["DEFAULT"],
  includeDefeated: false,
};

const ENEMY_ONE: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: 1,
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function subjectOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  const found = units.find((unit) => unit.battleUnitId === battleUnitId);
  if (found === undefined) {
    throw new Error(`subject "${battleUnitId}" left the board`);
  }
  return found;
}

/** 前提状態を作るために、production EffectAction 1件だけを指定の相手へ撃つ合成AS。 */
function precedingSkill(action: PrecedingAction): SkillDefinition {
  const binding = createTargetBindingId(PRECEDING_BINDING_ID);
  const stepTarget: TargetReference =
    action.target === "SELF" ? { kind: "SELF" } : { kind: "BINDING", targetBindingId: binding };
  const selector = action.target === "ALLY" ? ALLY_EXCEPT_SELF : ENEMY_ONE;
  // payload が別の TargetBinding を参照する EffectAction（`APPLY_DAMAGE_LINK.linkTo`）は、
  // その binding が合成スキルに無いと解決できず effect が一度も付かない。前提アクションは
  // 「その効果を保持している状態」を作るためだけのものなので、参照先は対象と同じ解決で足りる。
  return {
    skillDefinitionId: createSkillDefinitionId(PRECEDING_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 0 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings:
        action.target === "SELF"
          ? []
          : [
              { targetBindingId: binding, selector },
              ...(action.payloadBindingIds ?? []).map((id) => ({
                targetBindingId: createTargetBindingId(id),
                selector,
              })),
            ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: stepTarget,
          actions: [
            {
              effectActionDefinitionId: createEffectActionDefinitionId(
                action.effectActionDefinitionId,
              ),
            },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: PRECEDING_TRAITS,
    metadata: { displayName: PRECEDING_SKILL_ID, tags: [] },
  };
}

/**
 * このモジュール経由で実行されたEffectAction IDを蓄積する。ユニット軸の
 * 実行ベース網羅監査（「表に書かれている」ではなく「実際に走った」）が参照する。
 */
const executedActionIds = new Set<string>();

/** 直近の `resetExecutedActionIds` 以降に実際に実行されたEffectAction ID。 */
export function collectedExecutedActionIds(): ReadonlySet<string> {
  return new Set(executedActionIds);
}

export function resetExecutedActionIds(): void {
  executedActionIds.clear();
}

/** 契機を作る相手役の攻撃。実Catalogとは無関係な最小DAMAGE定義。 */
const STRIKE_SKILL_ID = "SKL_TEST_TRIGGER_STRIKE";
const STRIKE_ACTION_ID = "ACT_TEST_TRIGGER_STRIKE";

function strikeDamageAction(power: number): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(STRIKE_ACTION_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

/**
 * 契機イベントを実ダメージpipelineに発行させる。PS連鎖はここでは走らせず
 * （`onFactEventForPassiveChain`を渡さない）、発行された当のイベントを
 * 呼び出し側が `fireRecorded` へ流すことで、「実装が実際に載せたpayload」だけで
 * PSが候補化されることを確かめられる。
 */
function strikeForTrigger(
  chain: PassiveChain,
  trigger: RealDamageTrigger,
  units: readonly BattleUnit[],
  damageResults: DamageResultRegistry,
): { readonly units: readonly BattleUnit[]; readonly triggerEvent: BattleDomainEvent } {
  const attacker = subjectOf(units, trigger.from);
  const eventType = trigger.event ?? "DamageApplied";
  const struck = applyDamageAction(
    attacker,
    [
      {
        targetUnitId: createBattleUnitId(trigger.to),
        effectActionDefinitionId: createEffectActionDefinitionId(STRIKE_ACTION_ID),
        hitIndex: 1,
      },
    ],
    strikeDamageAction(trigger.power ?? 1),
    units,
    noMissNoCrit(),
    {
      recorder: chain.recorder,
      turnNumber: 1,
      cycleNumber: 1,
      actionId: chain.actionId,
      skillUseId: chain.recorder.nextSkillUseId(),
      resolutionScopeId: chain.resolutionScopeId,
      rootEventId: chain.rootEventId,
      parentEventId: chain.rootEventId,
      skillDefinitionId: createSkillDefinitionId(STRIKE_SKILL_ID),
      skillType: trigger.skillType,
      damageResults,
    },
  );
  const triggerEvent = chain.eventsOfType(eventType).at(-1);
  if (triggerEvent === undefined) {
    throw new Error(`the strike from "${trigger.from}" emitted no ${eventType}`);
  }
  return { units: struck.units, triggerEvent };
}

/** 観測の前に前提状態を作るために撃つ、実 production EffectAction 1件。 */
export interface PrecedingAction {
  readonly effectActionDefinitionId: string;
  readonly target: "SELF" | "ALLY" | "ENEMY";
  /**
   * この EffectAction の payload が参照する TargetBinding のID（`APPLY_DAMAGE_LINK`
   * の `linkTo` 等）。合成スキルへ同名の binding を宣言しないと参照が解決できず、
   * 効果が一度も付かないまま前提が空振りする。解決先は対象と同じで足りる —
   * 前提アクションが作るのは「その効果を保持している」状態そのものだけである。
   */
  readonly payloadBindingIds?: readonly string[];
}

export interface ObserveSkillUseOptions {
  readonly snapshot: BattleCatalogSnapshot;
  readonly unitDefinitionId: string;
  readonly use: SkillUse;
  readonly board?: BoardOverrides;
  /**
   * 観測対象の前に適用しておく production EffectAction。既存効果を要求する
   * `REMOVE_EFFECTS` のように、前提そのものが別のproduction定義で作られるものを、
   * 手組みの`AppliedEffect`ではなく実定義で用意する。これらが起こした変化は
   * 観測の基準線に含める（差分には現れない）。
   */
  readonly precedingActions?: readonly PrecedingAction[];
  /** 命中・会心・確率分岐の抽選列。既定は「命中・非会心」へ倒す固定列。 */
  readonly random?: RandomSource;
  /**
   * 前提アクション側の抽選列。既定は観測と同じ「命中・非会心」へ倒す固定列で、
   * `probability` を持つ効果（確率付与の状態異常）は**外れる**。前提として
   * その効果を保持している状態が要るときだけ、当たり側へ倒した列を渡す。
   * 観測側とは別インスタンスにして、消費位置が混ざらないようにする。
   */
  readonly precedingRandom?: RandomSource;
}

/**
 * 前提アクションを順に適用し、観測の基準線となる盤面を返す。
 *
 * 実行はしているが**実行ベース網羅の実績には数えない** — 前提アクションは
 * production スキルの対象選択・分岐・発動条件を通さず EffectAction 1件を合成
 * スキルで直接撃つものなので、これを数えると「スキル使用単位で保証する」という
 * 方針そのものを迂回できてしまう（production 側では一度も `APPLIED` にならない
 * Action を前提で撃つだけで `-003` を通せる）。
 *
 * `EventRecorder` は effectInstanceId／markerInstanceId／skillUseId とイベント連番を
 * 内部カウンタから発番するため、**1つだけ作って全前提アクションで共有する**。
 * 反復ごとに作り直すとカウンタが1から再開し、baselineへ同一runtime IDを持つ効果や
 * Markerが並んで、解除・リンク・消費が実戦闘に存在しない状態で評価される。
 */
export interface PrecedingActionOptions {
  /** 確率付与を当たり側へ倒したい場合の抽選列。既定は「命中・非会心」の固定列。 */
  readonly random?: RandomSource;
  /**
   * イベント記録先。前提アクションが出したイベント（`EffectActionCompleted` の
   * `resultKind` やStateDelta）まで見たい `-004` 以降のためだけに渡す。
   */
  readonly recorder?: SeededRecorder;
}

export function applyPrecedingActions(
  board: ProductionBoard,
  actions: readonly PrecedingAction[],
  options: PrecedingActionOptions = {},
): readonly BattleUnit[] {
  if (actions.length === 0) {
    return board.units;
  }
  const random = options.random;
  let baseline = board.units;
  const { recorder, rootEventId } = options.recorder ?? seedRecorder("B_PRECEDING");
  for (const action of actions) {
    const skillDefinition = precedingSkill(action);
    const definitions: BattleDefinitions = {
      ...board.definitions,
      skillDefinitions: new Map(board.definitions.skillDefinitions).set(
        skillDefinition.skillDefinitionId,
        skillDefinition,
      ),
    };
    const actor = subjectOf(baseline, board.subject.battleUnitId);
    baseline = applyEffectActionGroups(
      resolveSkillOrder(
        skillDefinition,
        actor,
        baseline,
        definitions.effectActions,
        undefined,
        definitions.unitDefinitions,
      ),
      baseline,
      effectActionGroupContext({
        actor,
        skillId: PRECEDING_SKILL_ID,
        definitions,
        recorder,
        rootEventId,
        ...(random === undefined ? {} : { random }),
      }),
    ).units;
  }
  return baseline;
}

/**
 * 実 `catalog/` のスキルを1回使い、変化した観測項目だけを返す。戻り値は表の
 * 期待値と `toEqual` で突き合わせる前提の正規形。
 */
export function observeSkillUse(options: ObserveSkillUseOptions): SkillUseObservation {
  const board = productionBoard(options.snapshot, options.unitDefinitionId, options.board);
  const skill = skillFrom(options.snapshot, options.use.skillDefinitionId);
  const random = options.random ?? noMissNoCrit();

  let baseline = applyPrecedingActions(board, options.precedingActions ?? [], {
    ...(options.precedingRandom === undefined ? {} : { random: options.precedingRandom }),
  });

  let after: readonly BattleUnit[];
  let events: readonly BattleDomainEvent[];
  // 契機を実経路に出させる場合、その発行が済んだ位置から先だけを観測に載せる
  // （契機自身が出したイベントは「観測対象のスキル使用が起こしたこと」ではない）。
  let eventsFrom = 0;

  if (options.use.kind === "ACTIVE") {
    const actionType = options.use.actionType ?? (skill.skillType === "EX" ? "EX" : "AS");
    // 発動可否は行動選択層が持つ（`activationCondition`・クールタイム・AP・対象候補）。
    // `resolveSkillUse` はこれらを評価しないため、先にゲートを通す。
    // `activationCondition` の実evaluatorは `domain/battle/lifecycle` が供給する。
    // 注入しないと `TRUE` 以外の条件で行動選択層が例外を投げる。
    const usable =
      actionType === "EX"
        ? isExUsable(
            skill,
            subjectOf(baseline, board.subject.battleUnitId),
            baseline,
            board.definitions.unitDefinitions,
            evaluateActivationCondition,
          )
        : selectAsCandidate(
            [skill],
            subjectOf(baseline, board.subject.battleUnitId),
            baseline,
            board.definitions.unitDefinitions,
            evaluateActivationCondition,
          ).kind === "SKILL";
    if (!usable) {
      return { activated: false };
    }
    const recorder = new EventRecorder(createBattleId("B_BEHAVIOUR"));
    const result = resolveSkillUse(
      subjectOf(baseline, board.subject.battleUnitId),
      skill,
      actionType,
      actionType,
      baseline,
      board.definitions,
      random,
      recorder,
      1,
      0,
      createActionId("B_BEHAVIOUR:action:1"),
      recorder.nextResolutionScopeId(),
    );
    after = result.units;
    events = recorder.getEvents();
  } else if (options.use.kind === "CHARGE") {
    // チャージ開始も1つの行動選択を通る（AP・クールタイム・`activationCondition`）。
    const usable =
      selectAsCandidate(
        [skill],
        subjectOf(baseline, board.subject.battleUnitId),
        baseline,
        board.definitions.unitDefinitions,
        evaluateActivationCondition,
      ).kind === "SKILL";
    if (!usable) {
      return { activated: false };
    }
    const recorder = new EventRecorder(createBattleId("B_BEHAVIOUR"));
    const started = resolveChargeStart(
      subjectOf(baseline, board.subject.battleUnitId),
      skill,
      "AS",
      "AS",
      baseline,
      board.definitions,
      random,
      recorder,
      1,
      0,
      createActionId("B_BEHAVIOUR:action:1"),
      recorder.nextResolutionScopeId(),
    );
    if (options.use.phase === "START") {
      after = started.units;
      events = recorder.getEvents();
    } else {
      // 開始の行動そのものは基準線へ繰り込み、解放が起こしたことだけを残す。
      baseline = started.units;
      const releaseRecorder = new EventRecorder(createBattleId("B_BEHAVIOUR_RELEASE"));
      const released = resolveChargeRelease(
        subjectOf(baseline, board.subject.battleUnitId),
        "AS",
        baseline,
        board.definitions,
        random,
        releaseRecorder,
        1,
        1,
        createActionId("B_BEHAVIOUR_RELEASE:action:1"),
        releaseRecorder.nextResolutionScopeId(),
      );
      after = released.units;
      events = releaseRecorder.getEvents();
    }
  } else {
    const trigger = options.use.trigger;
    const isRealDamage = (candidate: typeof trigger): candidate is RealDamageTrigger =>
      "kind" in candidate && candidate.kind === "REAL_DAMAGE";
    const isRealApplication = (
      candidate: typeof trigger,
    ): candidate is RealEffectApplicationTrigger =>
      "kind" in candidate && candidate.kind === "REAL_EFFECT_APPLICATION";
    // R-SKL-08の「同じ解決スコープ内で直前に確定したDAMAGE結果」は実行時registryが
    // 持つ。契機を作る実ダメージとPS連鎖が同じスコープに居ることを表すため、
    // 両者へ同じMapを渡す（反撃系の`DAMAGE_RECEIVED_RATIO`はこれを読む）。
    const damageResults: DamageResultRegistry = new Map();
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId:
        options.use.triggeredBy ??
        (isRealDamage(trigger) || isRealApplication(trigger) ? trigger.from : "enemy:front"),
      random,
      battleId: "B_BEHAVIOUR",
      damageResults,
      ...(options.use.turnNumber === undefined ? {} : { turnNumber: options.use.turnNumber }),
    });
    if (isRealDamage(trigger)) {
      // 契機は実pipelineに出させる。ここで減ったHPはPS自身が起こした変化と
      // 区別するため、観測の基準線（`baseline`）へ繰り込む。
      const struck = strikeForTrigger(chain, trigger, baseline, damageResults);
      baseline = struck.units;
      after = chain.fireRecorded(struck.triggerEvent, struck.units);
    } else if (isRealApplication(trigger)) {
      // 契機の付与そのもの（効果・イベント）は基準線へ繰り込み、PSが起こした
      // ことだけを残す。実ダメージ契機がHP減少を基準線へ入れるのと同じ扱い。
      const granted = applyProductionEffect({
        chain,
        definitions: board.definitions,
        units: baseline,
        effectActionDefinitionId: trigger.effectActionDefinitionId,
        from: trigger.from,
        to: trigger.to,
      });
      baseline = granted.units;
      eventsFrom = granted.eventsAfter;
      after = chain.fireRecorded(granted.event, granted.units);
    } else {
      after = chain.fire(trigger, baseline);
    }
    events = chain.recorder.getEvents().slice(eventsFrom);
    const activated = events.some(
      (event) =>
        event.eventType === "PassiveActivated" &&
        event.payload.skillDefinitionId === options.use.skillDefinitionId,
    );
    if (!activated) {
      return { activated: false };
    }
  }

  const actions = executedActions(events);
  for (const action of actions) {
    // `SKIPPED`/`MISSED`/`REJECTED`/`INTERRUPTED` は効果が一度も発現していない。
    // これを網羅の達成として数えると、その定義やresolverが壊れていても `-003` を
    // 通してしまうため、実際に適用された分だけを実行集合へ入れる。
    if (action.resultKind === undefined) {
      executedActionIds.add(action.effectActionDefinitionId);
    }
  }
  // サブユニット追加ダメージに付随するデバフ（R-SUB-02第3項）は、EffectAction群の
  // 解決器ではなく `grantSubUnitAdditionalDamageDebuff` フックから直接付与されるため
  // `EffectActionCompleted` を持たない。付与が起きた事実は `EffectApplied` が示しており
  // `APPLIED` と同等以上の証拠なので、こちらも実行の実績として数える。
  for (const event of events) {
    if (event.eventType === "EffectApplied") {
      executedActionIds.add(event.payload.effectActionDefinitionId);
    }
  }

  const hpDeltas: Record<string, number> = {};
  const beforeById = new Map(baseline.map((unit) => [unit.battleUnitId, unit]));
  for (const unit of after) {
    const delta = unit.currentHp - (beforeById.get(unit.battleUnitId)?.currentHp ?? unit.currentHp);
    if (delta !== 0) {
      hpDeltas[unit.battleUnitId] = delta;
    }
  }
  const effectsApplied = differenceOf(effectSummaries(after), effectSummaries(baseline));
  const effectsRemoved = differenceOf(effectSummaries(baseline), effectSummaries(after));
  const markers = differenceOf(markerSummaries(after), markerSummaries(baseline));
  // 段数が動いただけ（3→4）は `markers` が変化後の段数で表す。ここへ入れるのは
  // 保持そのものが無くなったMarkerだけにして、`REMOVE_MARKER` の効果と区別する。
  const remainingKeys = new Set(
    markerSummaries(after).map((marker) => `${marker.unitId}/${marker.markerId}`),
  );
  const markersRemoved = markerSummaries(baseline).filter(
    (marker) => !remainingKeys.has(`${marker.unitId}/${marker.markerId}`),
  );
  const resources = resourceDeltas(after, baseline);
  const cooldowns = differenceOf(cooldownEntries(after), cooldownEntries(baseline));
  const chargeBefore = beforeById.get(board.subject.battleUnitId)?.charge;
  const chargeAfter = subjectOf(after, board.subject.battleUnitId).charge;
  const chargeChanged =
    chargeBefore?.skill.skillDefinitionId !== chargeAfter?.skill.skillDefinitionId;

  return {
    ...(chargeChanged
      ? { charge: (chargeAfter?.skill.skillDefinitionId as string | undefined) ?? null }
      : {}),
    ...(actions.length === 0 ? {} : { actions }),
    ...(Object.keys(hpDeltas).length === 0 ? {} : { hpDeltas }),
    ...(effectsApplied.length === 0 ? {} : { effectsApplied }),
    ...(effectsRemoved.length === 0 ? {} : { effectsRemoved }),
    ...(markers.length === 0 ? {} : { markers }),
    ...(markersRemoved.length === 0 ? {} : { markersRemoved }),
    ...(resources.length === 0 ? {} : { resources }),
    ...(cooldowns.length === 0 ? {} : { cooldowns }),
  };
}

export interface SelectActiveSkillOptions {
  readonly snapshot: BattleCatalogSnapshot;
  readonly unitDefinitionId: string;
  readonly board?: BoardOverrides;
}

/**
 * 実 `UnitDefinition` が宣言する順のASを行動選択層（R-ACT-02）へ丸ごと通し、
 * 選ばれたスキルIDを返す（使用可能なASが1つも無ければ `"WAIT"`）。
 *
 * `activationCondition` は行動選択層が評価するため、`resolveSkillUse` を直接
 * 呼ぶだけでは発動可否を見られない。さらに「条件が不成立のASを候補から外して
 * **宣言順の次のAS**へ送る」という R-ACT-02 の送り先は、1スキルだけを渡す
 * 観測（`observeSkillUse` の `activated: false`）には現れない — 宣言順の全ASを
 * 渡すこの経路にしか現れない。
 */
export function selectedActiveSkill(options: SelectActiveSkillOptions): string {
  const board = productionBoard(options.snapshot, options.unitDefinitionId, options.board);
  const declared = unitFrom(
    options.snapshot,
    options.unitDefinitionId,
  ).activeSkillDefinitionIds.map((skillDefinitionId) =>
    skillFrom(options.snapshot, skillDefinitionId),
  );
  const selected = selectAsCandidate(
    declared,
    board.subject,
    board.units,
    board.definitions.unitDefinitions,
    evaluateActivationCondition,
  );
  return selected.kind === "SKILL" ? selected.skill.skillDefinitionId : "WAIT";
}

/**
 * 振る舞い表の1行。`intent` は原文の該当句を人が読める形で残す欄で、
 * `raw/` がCIに存在しない以上、転記根拠をレビューできる唯一の接点になる。
 */
export interface SkillBehaviourCase {
  readonly skillDefinitionId: string;
  readonly intent: string;
  readonly use: SkillUse;
  readonly board?: BoardOverrides;
  readonly precedingActions?: readonly PrecedingAction[];
  /**
   * 抽選列は**生成関数**で持つ。`SequenceRandomSource` は消費位置を持つ状態物であり、
   * 表は `-001` と実行ベース網羅監査（`-003`）の2回回されるため、インスタンスを
   * 共有すると2周目が exhausted で落ちる。
   */
  readonly random?: () => RandomSource;
  /** 前提アクション側の抽選列。`random` と同じ理由で生成関数として持つ。 */
  readonly precedingRandom?: () => RandomSource;
  readonly expected: SkillUseObservation;
}
