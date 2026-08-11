import type { Attribute, UnitType } from "../../catalog/definitions/catalog-enums.js";

/**
 * R-ENH-02: 学園レベルはタイプ3系統・属性6系統の計9系統を持ち、系統ごとに
 * 1回あたりの加算量が異なる。
 */
export type AcademyLevelSystem = "UNIT_TYPE" | "ATTRIBUTE";

/** 1系統ぶんの学園レベル加算量。会心率など他ステータスは対象外（R-ENH-01 #5）。 */
export interface AcademyStatAddition {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
}

/** R-ENH-02 #4: 1回のローテーション加算で入る量。 */
const ADDITION_PER_STEP: Readonly<Record<AcademyLevelSystem, AcademyStatAddition>> = {
  UNIT_TYPE: { hp: 120, attack: 90, defense: 50 },
  ATTRIBUTE: { hp: 240, attack: 180, defense: 100 },
};

const NO_ADDITION: AcademyStatAddition = { hp: 0, attack: 0, defense: 0 };

/** R-ENH-02 #1: 各系統はレベル1から始まる。省略された系統はこのレベルとして扱う。 */
const STARTING_ACADEMY_LEVEL = 1;

/**
 * R-ENH-02 #2/#3: レベル1から1レベル上がるごとにHP→攻撃力→防御力のローテーションで
 * 1ステータスへ加算する。加算回数 `n = L − 1` の閉形式（HP `⌊(n+2)/3⌋`、
 * 攻撃力 `⌊(n+1)/3⌋`、防御力 `⌊n/3⌋`）で求める — 上限が無いため反復では回数が
 * レベルに比例してしまう。
 *
 * レベルが1以上の整数であることはCommand検証（`09_アプリケーション設計.md`）が
 * 保証するため、ここでは値域を検査しない純関数として扱う。
 */
export function calculateAcademyLevelAddition(
  system: AcademyLevelSystem,
  level: number,
): AcademyStatAddition {
  const step = ADDITION_PER_STEP[system];
  const additions = level - 1;
  return {
    hp: Math.floor((additions + 2) / 3) * step.hp,
    attack: Math.floor((additions + 1) / 3) * step.attack,
    defense: Math.floor(additions / 3) * step.defense,
  };
}

/** 陣営単位の学園レベル指定（R-ENH-01 #1）。省略した系統はレベル1とする。 */
export interface AcademyLevels {
  readonly unitTypes?: Partial<Record<UnitType, number>>;
  readonly attributes?: Partial<Record<Attribute, number>>;
}

/**
 * R-ENH-02 #5: ユニットへ適用するのは、自身のユニットタイプに対応するタイプ系統と、
 * 自身の属性に対応する属性系統の2つだけ。他系統のレベルは同じ陣営の指定でも影響しない。
 */
export function resolveAcademyLevelAddition(
  levels: AcademyLevels | undefined,
  unitType: UnitType,
  attribute: Attribute,
): AcademyStatAddition {
  if (levels === undefined) {
    return NO_ADDITION;
  }
  const type = calculateAcademyLevelAddition(
    "UNIT_TYPE",
    levels.unitTypes?.[unitType] ?? STARTING_ACADEMY_LEVEL,
  );
  const attributeAddition = calculateAcademyLevelAddition(
    "ATTRIBUTE",
    levels.attributes?.[attribute] ?? STARTING_ACADEMY_LEVEL,
  );
  return {
    hp: type.hp + attributeAddition.hp,
    attack: type.attack + attributeAddition.attack,
    defense: type.defense + attributeAddition.defense,
  };
}
