import { fileURLToPath } from "node:url";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulateBattleCommand } from "../../application/simulation/simulate-battle-command.js";
import type { SimulateBattleResult } from "../../application/simulation/simulation-result-assembler.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import { loadProductionSnapshot } from "../fixtures/index.js";
import { ManualClock } from "../clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../id/fixed-battle-id-generator.js";
import { CatalogBuilder } from "../scenario/catalog-builder.js";
import {
  ENEMY_ALL,
  damageEffectAction,
  formationSlot,
  unitDefinition,
} from "../scenario/definition-builders.js";

/**
 * ユニット単位production結合テストの `-100`（1バトル完走の中での全スキル発動）を
 * 駆動する共通ハーネス（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `-001` の効果発現テーブルは EffectAction を1件だけ含む最小の合成スキルへ包んで
 * 通すため、スキル側の発動条件・PSトリガ・step分岐・対象範囲・AP/PP/EXの資源経済・
 * クールタイムが観測に現れない。この層はそれらすべてを含んだ実戦闘を1本完走させ、
 * 「定義した全スキルが実戦闘で到達可能であること」を発動回数と発動順で固定する。
 *
 * 対象ユニットの定義（unit / skill / effectAction）は実 `catalog/` のまま無改変で、
 * 相手役と味方だけを合成ユニットに差し替える。合成にする理由は2つある。
 *
 * - 相手側・味方側のPSや特性が観測へ混ざらないようにするため
 *   （`effect-manifestation.ts` の stand-in と同じ理由）。
 * - 耐久と攻撃力を自由に置けるようにするため。実Catalogのユニット同士では戦闘が
 *   1〜2ターンで決着してEXゲージが最大に届かず、EXが永久に発動しない。
 */

export const PRODUCTION_CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

/** 合成ユニットが使う最小ASのID。定義は`syntheticSkill`が組み立てる。 */
const SYNTHETIC_SKILL_ID = (peerId: string): string => `SKL_TEST_FULL_BATTLE_${peerId}`;
const SYNTHETIC_ACTION_ID = (peerId: string): string => `ACT_TEST_FULL_BATTLE_${peerId}`;
/** どの合成ユニットも満タンにならないEXゲージを持つ（EX発動を観測へ混ぜないため）。 */
const SYNTHETIC_EX_SKILL_ID = "SKL_TEST_FULL_BATTLE_EX";

/**
 * 盤面へ置く合成ユニット1種。`attack` が 0 のときASを持たせず、
 * 「攻撃されるだけで自分からはスキルを使わない」味方になる
 * （`SkillUseStarting` を起点にするPSトリガを意図的に発火させないため）。
 */
export interface SyntheticUnitSpec {
  /** `UNIT_TEST_FULL_BATTLE_` を除いた短い識別子。 */
  readonly id: string;
  readonly maximumHp: number;
  readonly attack: number;
  /** ASのクールタイム（行動数）。0 なら毎行動使える。 */
  readonly cooldown?: number;
  readonly actionSpeed?: number;
}

export interface FullBattleBoard {
  readonly unitDefinitionId: string;
  readonly synthetics: readonly SyntheticUnitSpec[];
  /** 対象ユニットを含む味方編成。`syntheticSlot`／`subjectSlot`で組み立てる。 */
  readonly allySlots: readonly FormationSlot[];
  readonly enemySlots: readonly FormationSlot[];
  readonly turnLimit?: number;
  /** RandomSourceが常に返す値。会心・命中の分岐をこの1値で決定化する。 */
  readonly randomValue?: number;
  readonly battleId?: string;
}

type FormationSlot = SimulateBattleCommand["allyFormation"]["slots"][number];

export function syntheticUnitId(id: string): string {
  return `UNIT_TEST_FULL_BATTLE_${id}`;
}

/** 対象ユニットの編成スロット。 */
export function subjectSlot(
  unitDefinitionId: string,
  column: 0 | 1 | 2,
  row: "FRONT" | "REAR" = "FRONT",
): FormationSlot {
  return formationSlot(unitDefinitionId, column, row);
}

/** 合成ユニットの編成スロット。 */
export function syntheticSlot(
  id: string,
  column: 0 | 1 | 2,
  row: "FRONT" | "REAR" = "FRONT",
): FormationSlot {
  return formationSlot(syntheticUnitId(id), column, row);
}

/** 枯渇しない決定的RandomSource。乱数消費数を数えずに完走させる。 */
class ConstantRandomSourceFactory implements RandomSourceFactory {
  private readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  create(): RandomSource {
    const value = this.value;
    return { next: () => value };
  }
}

/** 敵全体へ1件のDAMAGEを撃つだけの最小AS。クールタイムだけ外から指定できる。 */
function syntheticSkill(peerId: string, cooldown: number): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(SYNTHETIC_SKILL_ID(peerId)),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_ALL"), selector: ENEMY_ALL }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ALL") },
          actions: [
            {
              effectActionDefinitionId: createEffectActionDefinitionId(SYNTHETIC_ACTION_ID(peerId)),
            },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: cooldown },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      // 会心・回避の分岐を観測へ持ち込まない（対象ユニット側の観測を汚さないため）。
      accuracy: { guaranteedHit: true },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: `full-battle synthetic ${peerId}`, tags: [] },
  };
}

/** 副作用のない、EXゲージが満タンにならないEXスキル。 */
function inertExSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(SYNTHETIC_EX_SKILL_ID),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 1_000_000 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: "full-battle inert EX", tags: [] },
  };
}

/** 実production定義と合成ユニットを1つのCatalogへ合成する。 */
function buildCatalog(board: FullBattleBoard) {
  const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [board.unitDefinitionId]);
  const subject = snapshot.units.get(createUnitDefinitionId(board.unitDefinitionId));
  if (subject === undefined) {
    throw new Error(`UnitDefinition "${board.unitDefinitionId}" is not present in the catalog`);
  }

  const builder = new CatalogBuilder()
    .withUnit(subject, ...board.synthetics.map(syntheticUnitDefinition))
    .withSkill(...snapshot.skills.values(), inertExSkill())
    .withEffectAction(...snapshot.effectActions.values());

  for (const spec of board.synthetics) {
    if (spec.attack <= 0) {
      continue;
    }
    builder
      .withSkill(syntheticSkill(spec.id, spec.cooldown ?? 0))
      // power 1・防御0のため、1ヒットのダメージは`attack`そのものになる。
      .withEffectAction(damageEffectAction(SYNTHETIC_ACTION_ID(spec.id), 1));
  }
  return builder.build();
}

function syntheticUnitDefinition(spec: SyntheticUnitSpec) {
  return unitDefinition(syntheticUnitId(spec.id), {
    baseStats: {
      maximumHp: spec.maximumHp,
      attack: spec.attack,
      defense: 0,
      criticalRate: 0,
      criticalDamageBonus: 0,
      affinityBonus: 0,
      actionSpeed: spec.actionSpeed ?? 1,
      maximumAp: 3,
      maximumPp: 3,
    },
    activeSkillDefinitionIds:
      spec.attack > 0 ? [createSkillDefinitionId(SYNTHETIC_SKILL_ID(spec.id))] : [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId(SYNTHETIC_EX_SKILL_ID),
  });
}

export interface FullBattleObservation {
  readonly outcome: string;
  readonly completionReason: string;
  readonly completedTurn: number;
  /** 対象ユニットのスキルごとの発動回数（発動しなかったスキルはキーごと現れない）。 */
  readonly activationCounts: Readonly<Record<string, number>>;
  /**
   * 対象ユニットのスキルが発動した順序。`SKL_<UNIT_ID断片>_` を落とした短縮名で並べる
   * （表として読めるようにするため。IDの完全形は`activationCounts`のキーが持つ）。
   */
  readonly activationOrder: readonly string[];
  /** 不変条件アサーション（`assertBattleInvariants`）へ渡すための生の結果。 */
  readonly result: SimulateBattleResult;
}

/**
 * 実戦闘を1本完走させ、対象ユニットのスキル発動だけを抽出する。
 *
 * 合成ユニット側のスキル使用は観測から落とす。対象ユニットの宣言スキルIDだけを
 * 数えるため、同じスキルIDが盤面に2体以上ぶん存在しないこと（対象ユニットは
 * 味方側に1体だけ置くこと）が前提になる。
 */
export function observeFullBattle(board: FullBattleBoard): FullBattleObservation {
  const catalog = buildCatalog(board);
  const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [board.unitDefinitionId]);
  const subject = snapshot.units.get(createUnitDefinitionId(board.unitDefinitionId))!;
  const declared = new Set(
    [
      ...subject.activeSkillDefinitionIds,
      ...subject.passiveSkillDefinitionIds,
      ...(subject.extraSkillDefinitionId === undefined ? [] : [subject.extraSkillDefinitionId]),
    ].map(String),
  );

  const useCase = new SimulateBattleUseCase({
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator([board.battleId ?? "B_FULL_BATTLE"]),
    randomSourceFactory: new ConstantRandomSourceFactory(board.randomValue ?? 0.05),
    clock: new ManualClock(0),
  });
  const result = useCase.execute(
    {
      allyFormation: { slots: [...board.allySlots], memoryDefinitionIds: [] },
      enemyFormation: { slots: [...board.enemySlots], memoryDefinitionIds: [] },
      turnLimit: board.turnLimit ?? 30,
      logLevel: "DIAGNOSTIC",
    },
    { requestId: "full-battle", deadlineEpochMs: Number.MAX_SAFE_INTEGER },
  );

  // AS・EXは行動として`SkillUseStarting`を、PSはトリガ解決として`PassiveActivated`を
  // 発行する（PSは`SkillUseStarting`を発行しない）。両方を数えて初めて3種のスキルが
  // 同じ粒度で並ぶ。同じ発動が両方に現れることはないため二重計上にならない。
  const prefix = `SKL_${board.unitDefinitionId.replace(/^UNIT_/, "")}_`;
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const event of result.events) {
    if (event.type !== "SKILL_USE_STARTING" && event.type !== "PASSIVE_ACTIVATED") {
      continue;
    }
    const id = (event.details as Record<string, unknown> | undefined)?.["skillDefinitionId"];
    if (typeof id !== "string" || !declared.has(id)) {
      continue;
    }
    counts[id] = (counts[id] ?? 0) + 1;
    order.push(id.startsWith(prefix) ? id.slice(prefix.length) : id);
  }

  return {
    outcome: String(result.outcome),
    completionReason: String(result.completionReason),
    completedTurn: Number(result.completedTurn),
    activationCounts: counts,
    activationOrder: order,
    result,
  };
}

export interface StandardBoardOptions {
  readonly unitDefinitionId: string;
  /**
   * 敵の数。単体攻撃しか持たないユニットでも複数回の対象選択が起きるよう、
   * 1体では全スキルへ届かないユニットだけ2体にする。
   */
  readonly enemyCount: 1 | 2;
  /**
   * 正面の味方が持つASのクールタイム（行動数）。0 だと毎行動ASを使うため、
   * `SkillUseStarting` を起点にするPSが毎ターンPPを使い切り、より安いPSを
   * 締め出すことがある。その場合だけ間隔を空ける。
   */
  readonly frontPeerCooldown?: number;
  /** 全スキルが発動しきる最小のターン数を置く。 */
  readonly turnLimit: number;
  readonly battleId?: string;
}

/**
 * 第1バッチが共有する標準盤面。対象ユニットを後衛中央列へ置き、
 * 前へ味方を並べる。それぞれの合成ユニットが受け持つ役割は次のとおり。
 *
 * - `FOE`: 20,000,000 HP のため `turnLimit` まで倒れきらず、戦闘が短期決着して
 *   EXゲージが最大へ届かない事態を防ぐ。攻撃力2,000は味方を段階的に削り、
 *   HP割合を条件にするスキル（`HP_RATIO`）の窓を開ける。
 * - `FRONT`: 対象ユニットの正面（同じ列の前衛）。`IN_FRONT_OF` を要求するPSの相手役。
 * - `PEER`: 早期に戦闘不能になり `UnitDefeated` を起点にするPSを発火させる。
 * - `WALL`: 2体が生き残ることで味方生存数を4以上に保ち、`ALIVE_UNIT_COUNT` を
 *   条件にするPSを成立させる。
 */
export function standardFullBattleBoard(options: StandardBoardOptions): FullBattleBoard {
  return {
    unitDefinitionId: options.unitDefinitionId,
    synthetics: [
      { id: "FOE", maximumHp: 20_000_000, attack: 2_000 },
      { id: "FRONT", maximumHp: 6_000, attack: 1, cooldown: options.frontPeerCooldown ?? 0 },
      { id: "PEER", maximumHp: 6_000, attack: 1 },
      { id: "WALL", maximumHp: 600_000, attack: 1 },
    ],
    allySlots: [
      subjectSlot(options.unitDefinitionId, 0, "REAR"),
      syntheticSlot("FRONT", 0, "FRONT"),
      syntheticSlot("PEER", 1, "FRONT"),
      syntheticSlot("WALL", 2, "FRONT"),
      syntheticSlot("WALL", 1, "REAR"),
    ],
    enemySlots: Array.from({ length: options.enemyCount }, (_, index) =>
      syntheticSlot("FOE", index as 0 | 1 | 2, "FRONT"),
    ),
    turnLimit: options.turnLimit,
    ...(options.battleId === undefined ? {} : { battleId: options.battleId }),
  };
}

/** そのユニットが宣言する全スキルの定義ID（AS→PS→EXの定義順）。 */
export function declaredSkillIds(unitDefinitionId: string): readonly string[] {
  const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [unitDefinitionId]);
  const unit = snapshot.units.get(createUnitDefinitionId(unitDefinitionId));
  if (unit === undefined) {
    throw new Error(`UnitDefinition "${unitDefinitionId}" is not present in the catalog`);
  }
  return [
    ...unit.activeSkillDefinitionIds,
    ...unit.passiveSkillDefinitionIds,
    ...(unit.extraSkillDefinitionId === undefined ? [] : [unit.extraSkillDefinitionId]),
  ].map(String);
}
