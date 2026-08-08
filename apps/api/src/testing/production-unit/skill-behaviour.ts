import { fileURLToPath } from "node:url";
import {
  isExUsable,
  selectAsCandidate,
} from "../../domain/battle/action/action-selection-policy.js";
import { evaluateActivationCondition } from "../../domain/battle/lifecycle/activation-condition-evaluator.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
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
import { createActionId } from "../../domain/shared/event-ids.js";
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
} from "../fixtures/index.js";
import { openPassiveChain, type PassiveTriggerEvent } from "./passive-activation.js";

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
    combatStats,
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
  readonly markers?: readonly ObservedMarker[];
  readonly resources?: readonly ObservedResource[];
  readonly cooldowns?: readonly ObservedCooldown[];
}

export type SkillUse =
  | {
      readonly kind: "ACTIVE";
      readonly skillDefinitionId: string;
      readonly actionType?: "AS" | "EX";
    }
  | {
      readonly kind: "PASSIVE";
      readonly skillDefinitionId: string;
      /** 契機イベント。PSは実際に発行されたイベントからしか発動しない。 */
      readonly trigger: PassiveTriggerEvent<BattleDomainEventType>;
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
              {
                targetBindingId: binding,
                selector: action.target === "ALLY" ? ALLY_EXCEPT_SELF : ENEMY_ONE,
              },
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

/** 観測の前に前提状態を作るために撃つ、実 production EffectAction 1件。 */
export interface PrecedingAction {
  readonly effectActionDefinitionId: string;
  readonly target: "SELF" | "ALLY" | "ENEMY";
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
}

/**
 * 実 `catalog/` のスキルを1回使い、変化した観測項目だけを返す。戻り値は表の
 * 期待値と `toEqual` で突き合わせる前提の正規形。
 */
export function observeSkillUse(options: ObserveSkillUseOptions): SkillUseObservation {
  const board = productionBoard(options.snapshot, options.unitDefinitionId, options.board);
  const skill = skillFrom(options.snapshot, options.use.skillDefinitionId);
  const random = options.random ?? noMissNoCrit();

  // 前提アクションは観測の基準線に含める（差分には現れない）。実行はしているので
  // 実行ベース網羅の集合へは入る。
  let baseline = board.units;
  for (const action of options.precedingActions ?? []) {
    const skillDefinition = precedingSkill(action);
    const definitions: BattleDefinitions = {
      ...board.definitions,
      skillDefinitions: new Map(board.definitions.skillDefinitions).set(
        skillDefinition.skillDefinitionId,
        skillDefinition,
      ),
    };
    const actor = baseline.find((unit) => unit.battleUnitId === board.subject.battleUnitId);
    if (actor === undefined) {
      throw new Error(`subject "${board.subject.battleUnitId}" left the board`);
    }
    const { recorder, rootEventId } = seedRecorder("B_PRECEDING");
    const applied = applyEffectActionGroups(
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
      }),
    );
    baseline = applied.units;
    for (const executed of executedActions(recorder.getEvents())) {
      if (executed.resultKind === undefined) {
        executedActionIds.add(executed.effectActionDefinitionId);
      }
    }
  }

  let after: readonly BattleUnit[];
  let events: readonly BattleDomainEvent[];

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
  } else {
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: options.use.triggeredBy ?? "enemy:front",
      random,
      battleId: "B_BEHAVIOUR",
      ...(options.use.turnNumber === undefined ? {} : { turnNumber: options.use.turnNumber }),
    });
    after = chain.fire(options.use.trigger, baseline);
    events = chain.recorder.getEvents();
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
  const resources = resourceDeltas(after, baseline);
  const cooldowns = differenceOf(cooldownEntries(after), cooldownEntries(baseline));

  return {
    ...(actions.length === 0 ? {} : { actions }),
    ...(Object.keys(hpDeltas).length === 0 ? {} : { hpDeltas }),
    ...(effectsApplied.length === 0 ? {} : { effectsApplied }),
    ...(effectsRemoved.length === 0 ? {} : { effectsRemoved }),
    ...(markers.length === 0 ? {} : { markers }),
    ...(resources.length === 0 ? {} : { resources }),
    ...(cooldowns.length === 0 ? {} : { cooldowns }),
  };
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
  readonly random?: RandomSource;
  readonly expected: SkillUseObservation;
}
