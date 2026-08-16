import type { RandomSourceFactory } from "./random-source-factory.js";

/**
 * seedと試行番号から決定的な`RandomSource`を供給するポート。
 *
 * 同一の`(seed, runIndex)`からは常に同一の乱数列を返し、それ以外の何にも依存しない。
 * 大量試行の評価が編成候補ごとに同じ`runIndex`の乱数列を共有できる（共通乱数法）よう、
 * 候補の識別子や順序をこの契約へ持ち込まない。
 *
 * 返すのが`RandomSource`ではなく`RandomSourceFactory`なのは、Battleごとに専用の
 * `RandomSource`を生成するという{@link RandomSourceFactory}の契約を保ったまま、
 * 同じ乱数列を何度でも再生できるようにするためである。
 */
export interface SeededRandomSourceProvider {
  forRun(seed: string, runIndex: number): RandomSourceFactory;
}
