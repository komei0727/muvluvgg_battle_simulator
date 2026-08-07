import { fileURLToPath } from "node:url";
import { applyEffectActionGroups } from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetReference } from "../../domain/catalog/definitions/references.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import {
  definitionsWith,
  effectActionGroupContext,
  seedRecorder,
  testBattleUnit,
} from "../fixtures/index.js";

/**
 * ユニット単位production結合テスト（`__tests__/production-catalog/units/`）の
 * `-001` 効果発現テーブルを駆動する共通ハーネス（`12_テスト戦略.md`
 * 「ユニット効果軸」）。
 *
 * 対象ユニットが持つ**個々のEffectActionが単体で何を起こすか**だけを、実
 * `catalog/` の未改変定義に対して観測する。EffectActionを1件だけ含む最小の合成
 * スキルへ包んで `resolveSkillOrder`→`applyEffectActionGroups`（実解決経路）を
 * 通すため、
 *
 * - スキル側の対象選択・発動条件・PSトリガ・stepの分岐は関与しない
 *   （それらは同じファイルの `-002` 以降が機構ごとに検証する）。
 * - 行動のAP消費・EXゲージ獲得というenvelopeも混ざらない
 *   （`resolveSkillUse` ではなく EffectSequence 層から駆動するため）。
 *
 * これにより「そのユニットの全EffectActionが1件残らず効果を発揮する」ことを、
 * 定義ごとに1行の表で宣言できる。
 */

export const PRODUCTION_CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

/** 合成スキルが対象へ向ける先。盤面の3体はこの3値と1対1に対応する。 */
export type ManifestationTarget = "SELF" | "ALLY" | "ENEMY";

export const SUBJECT_ID = "ally:subject";
export const ALLY_ID = "ally:peer";
export const ENEMY_ID = "enemy:foe";

/** 相手役ユニット定義のID。実Catalogのユニットとは無関係な最小定義を使う。 */
export const STAND_IN_UNIT_ID = "UNIT_TEST_MANIFESTATION_STAND_IN";

const HARNESS_SKILL_ID = "SKL_TEST_MANIFESTATION";
const HARNESS_BINDING_ID = "TGT_TEST_MANIFESTATION";

/**
 * 効果量を桁で読める値に固定する。会心率0・属性相性0により乱数と属性倍率が
 * 観測へ混ざらず、`SKILL_POWER` のダメージは `(攻撃力 - 防御力) × power` の
 * 切り捨てそのものになる。防御力を0にしないのは、`DEFENSE` のstat modが実効値を
 * 動かしたこと（`CombatStatChanged`）まで観測できるようにするため。
 */
export const MANIFESTATION_COMBAT_STATS: CombatStats = {
  maximumHp: 10000,
  attack: 1000,
  defense: 500,
  criticalRate: 0,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

export const MANIFESTATION_LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 };

/**
 * 盤面3体の初期状態。上限にも0にも触れていない中間値へ置くことで、増減どちらの
 * `MODIFY_RESOURCE`／`HEAL`／`DAMAGE`も境界で丸められずに観測できる
 * （満タンHPでは`overheal: DISCARD`のHEALが、満タンAPでは加算が消える）。
 * `CURRENT_HP_RATIO`系Formulaの評価点もこの1点で決まる。
 */
export const MANIFESTATION_INITIAL_STATE = {
  currentHp: MANIFESTATION_COMBAT_STATS.maximumHp / 2,
  currentAp: 2,
  currentPp: 2,
  currentExtraGauge: 0,
} as const;

/** 表の行ごとに前提状態（既存効果・クールダウン・HP・リソース）を作る差分。 */
export interface ManifestationBoardOverrides {
  readonly subject?: Partial<BattleUnit>;
  readonly ally?: Partial<BattleUnit>;
  readonly enemy?: Partial<BattleUnit>;
  readonly combatStats?: Partial<CombatStats>;
}

export interface ManifestationBoard {
  readonly units: readonly BattleUnit[];
  readonly subject: BattleUnit;
  readonly ally: BattleUnit;
  readonly enemy: BattleUnit;
  readonly definitions: BattleDefinitions;
}

/**
 * 対象ユニット1体・味方1体・敵1体の最小盤面。相手役は実Catalogのユニットでは
 * なく `testUnitDefinition` の最小定義にして、相手側のPS・特性が観測へ混ざらない
 * ようにする。
 */
export function manifestationBoard(
  snapshot: BattleCatalogSnapshot,
  unitDefinitionId: string,
  overrides: ManifestationBoardOverrides = {},
): ManifestationBoard {
  const combatStats = { ...MANIFESTATION_COMBAT_STATS, ...overrides.combatStats };
  const subject = testBattleUnit({
    battleUnitId: SUBJECT_ID,
    unitDefinitionId,
    position: { column: "CENTER", row: "FRONT" },
    combatStats,
    limits: MANIFESTATION_LIMITS,
    overrides: { ...MANIFESTATION_INITIAL_STATE, ...overrides.subject },
  });
  const ally = testBattleUnit({
    battleUnitId: ALLY_ID,
    unitDefinitionId: STAND_IN_UNIT_ID,
    position: { column: "CENTER", row: "BACK" },
    combatStats,
    limits: MANIFESTATION_LIMITS,
    overrides: { ...MANIFESTATION_INITIAL_STATE, ...overrides.ally },
  });
  const enemy = testBattleUnit({
    battleUnitId: ENEMY_ID,
    unitDefinitionId: STAND_IN_UNIT_ID,
    side: "ENEMY",
    position: { column: "CENTER", row: "FRONT" },
    combatStats,
    limits: MANIFESTATION_LIMITS,
    overrides: { ...MANIFESTATION_INITIAL_STATE, ...overrides.enemy },
  });
  return {
    units: [subject, ally, enemy],
    subject,
    ally,
    enemy,
    definitions: definitionsWith(snapshot, { units: [STAND_IN_UNIT_ID] }),
  };
}

const HARNESS_TRAITS: SkillDefinition["traits"] = {
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

/** 検証対象のEffectActionを1件だけ、指定の相手へ向けて実行する最小の合成AS。 */
function harnessSkill(
  effectActionDefinitionId: string,
  target: ManifestationTarget,
): SkillDefinition {
  const binding = createTargetBindingId(HARNESS_BINDING_ID);
  const stepTarget: TargetReference =
    target === "SELF" ? { kind: "SELF" } : { kind: "BINDING", targetBindingId: binding };
  return {
    skillDefinitionId: createSkillDefinitionId(HARNESS_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings:
        target === "SELF"
          ? []
          : [
              {
                targetBindingId: binding,
                selector: target === "ALLY" ? ALLY_EXCEPT_SELF : ENEMY_ONE,
              },
            ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: stepTarget,
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(effectActionDefinitionId) },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: HARNESS_TRAITS,
    metadata: { displayName: HARNESS_SKILL_ID, tags: [] },
  };
}

/** 付与・解除された効果の要約。`AppliedEffect`のうち観測に必要な列だけを持つ。 */
export interface ObservedEffect {
  readonly unitId: string;
  readonly effectActionDefinitionId: string;
  readonly magnitude: number;
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
 * EffectAction 1件がもたらした観測結果。**変化が無かった項目はキーごと落とす**
 * ため、表の期待値は「そのEffectActionが本当に起こしたこと」だけを列挙でき、
 * `toEqual` による完全一致で「余計なことを起こしていない」ことも同時に守れる。
 */
export interface EffectManifestation {
  readonly eventTypes: readonly string[];
  /**
   * `eventTypes` が繰り返された回数（1回のときは省略）。多ヒットのDAMAGEは同じ
   * pipelineイベント列をヒット数だけ並べるため、そのまま展開すると表が読めない。
   * 「7段階 × 4ヒット」と宣言できるよう周期を畳む。
   */
  readonly eventCycles?: number;
  readonly hpDeltas?: Readonly<Record<string, number>>;
  readonly effectsApplied?: readonly ObservedEffect[];
  readonly effectsRemoved?: readonly ObservedEffect[];
  readonly markers?: readonly ObservedMarker[];
  readonly resources?: readonly ObservedResource[];
  readonly cooldowns?: readonly ObservedCooldown[];
}

/**
 * EffectSequenceのstep envelope。kindによらず必ず現れるため観測から落とす
 * （どのEffectActionでも同じ4件が並ぶだけで、kindごとの差を何も語らない）。
 */
const ENVELOPE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "EffectStepStarting",
  "EffectStepCompleted",
  "EffectActionStarting",
  "EffectActionCompleted",
]);

/** 全体が同一ブロックの反復なら、その最小ブロックと反復回数へ畳む。 */
function compressCycles(eventTypes: readonly string[]): {
  readonly block: readonly string[];
  readonly cycles: number;
} {
  for (let period = 1; period < eventTypes.length; period++) {
    if (eventTypes.length % period !== 0) {
      continue;
    }
    if (eventTypes.every((eventType, index) => eventType === eventTypes[index % period])) {
      return { block: eventTypes.slice(0, period), cycles: eventTypes.length / period };
    }
  }
  return { block: eventTypes, cycles: 1 };
}

function effectSummaries(units: readonly BattleUnit[]): readonly ObservedEffect[] {
  return units.flatMap((unit) =>
    unit.appliedEffects.map((effect) => ({
      unitId: unit.battleUnitId,
      effectActionDefinitionId: effect.effectActionDefinitionId,
      magnitude: effect.magnitude,
    })),
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

function cooldownEntries(units: readonly BattleUnit[]): readonly ObservedCooldown[] {
  return units.flatMap((unit) =>
    Object.entries(unit.cooldowns).map(([skillDefinitionId, state]) => ({
      unitId: unit.battleUnitId,
      skillDefinitionId,
      remaining: (state as { remaining: number }).remaining,
    })),
  );
}

/** 実行するEffectAction 1件とその向き先。 */
export interface ManifestationStep {
  readonly effectActionDefinitionId: string;
  readonly target: ManifestationTarget;
}

export interface ObserveEffectActionOptions {
  readonly snapshot: BattleCatalogSnapshot;
  readonly unitDefinitionId: string;
  readonly effectActionDefinitionId: string;
  readonly target: ManifestationTarget;
  readonly board?: ManifestationBoardOverrides;
  /**
   * 観測対象の前に実行しておく production EffectAction。既存効果を要求する
   * `REMOVE_EFFECTS` のように、前提状態そのものが別のproduction定義で作られる
   * ものを、手組みの`AppliedEffect`ではなく実定義で用意するために使う。
   * これらが起こした変化は観測の基準線に含める（差分には現れない）。
   */
  readonly precedingSteps?: readonly ManifestationStep[];
  /** 命中・会心・確率抽選を左右する乱数列。既定は「命中・非会心」へ倒す固定列。 */
  readonly random?: RandomSource;
}

/**
 * 実 `catalog/` のEffectAction 1件を最小合成スキル経由で実行し、変化した観測項目
 * だけを返す。戻り値は表の期待値と `toEqual` で突き合わせる前提の正規形。
 */
export function observeEffectAction(options: ObserveEffectActionOptions): EffectManifestation {
  const board = manifestationBoard(options.snapshot, options.unitDefinitionId, options.board);
  const { recorder, rootEventId } = seedRecorder("B_MANIFEST");

  let units = board.units;
  const runStep = (step: ManifestationStep): void => {
    const skill = harnessSkill(step.effectActionDefinitionId, step.target);
    const definitions: BattleDefinitions = {
      ...board.definitions,
      skillDefinitions: new Map(board.definitions.skillDefinitions).set(
        skill.skillDefinitionId,
        skill,
      ),
    };
    const actor = units.find((unit) => unit.battleUnitId === board.subject.battleUnitId);
    if (actor === undefined) {
      throw new Error(`subject "${board.subject.battleUnitId}" left the board`);
    }
    units = applyEffectActionGroups(
      resolveSkillOrder(
        skill,
        actor,
        units,
        definitions.effectActions,
        undefined,
        definitions.unitDefinitions,
      ),
      units,
      effectActionGroupContext({
        actor,
        skillId: HARNESS_SKILL_ID,
        definitions,
        recorder,
        rootEventId,
        ...(options.random === undefined ? {} : { random: options.random }),
      }),
    ).units;
  };

  for (const step of options.precedingSteps ?? []) {
    runStep(step);
  }

  const unitsBefore = units;
  const eventsBefore = recorder.getEvents().length;
  runStep({
    effectActionDefinitionId: options.effectActionDefinitionId,
    target: options.target,
  });

  const hpDeltas: Record<string, number> = {};
  const beforeById = new Map(unitsBefore.map((unit) => [unit.battleUnitId, unit]));
  for (const unit of units) {
    const delta = unit.currentHp - (beforeById.get(unit.battleUnitId)?.currentHp ?? unit.currentHp);
    if (delta !== 0) {
      hpDeltas[unit.battleUnitId] = delta;
    }
  }
  const effectsApplied = differenceOf(effectSummaries(units), effectSummaries(unitsBefore));
  const effectsRemoved = differenceOf(effectSummaries(unitsBefore), effectSummaries(units));
  const markers = differenceOf(markerSummaries(units), markerSummaries(unitsBefore));
  const resources = resourceDeltas(units, unitsBefore);
  const cooldowns = differenceOf(cooldownEntries(units), cooldownEntries(unitsBefore));

  const { block, cycles } = compressCycles(
    recorder
      .getEvents()
      .slice(eventsBefore)
      .map((event) => event.eventType)
      .filter((eventType) => !ENVELOPE_EVENT_TYPES.has(eventType)),
  );

  return {
    eventTypes: block,
    ...(cycles === 1 ? {} : { eventCycles: cycles }),
    ...(Object.keys(hpDeltas).length === 0 ? {} : { hpDeltas }),
    ...(effectsApplied.length === 0 ? {} : { effectsApplied }),
    ...(effectsRemoved.length === 0 ? {} : { effectsRemoved }),
    ...(markers.length === 0 ? {} : { markers }),
    ...(resources.length === 0 ? {} : { resources }),
    ...(cooldowns.length === 0 ? {} : { cooldowns }),
  };
}

/**
 * `-001` の表の1行。`skillDefinitionId` は「このEffectActionを持つスキル」を
 * 宣言する列で、全Skill IDが表に現れることで網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合が成立する。
 */
export interface EffectManifestationCase {
  readonly skillDefinitionId: string;
  readonly effectActionDefinitionId: string;
  readonly target: ManifestationTarget;
  readonly board?: ManifestationBoardOverrides;
  readonly precedingSteps?: readonly ManifestationStep[];
  readonly random?: RandomSource;
  readonly expected: EffectManifestation;
}
