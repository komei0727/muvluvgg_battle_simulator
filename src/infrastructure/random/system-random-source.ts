import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";

/**
 * `11_インフラストラクチャ設計.md`「SystemRandomSource」: 会心・暗闇などの確率判定
 * だけに使う非暗号用途の乱数アダプター。完全再現が要件でないためランタイムの
 * 疑似乱数(`Math.random`)をそのまま使う。
 */
export class SystemRandomSource implements RandomSource {
  next(): number {
    return Math.random();
  }
}

/** Battleごとに新しい`SystemRandomSource`を生成する。RandomSourceはリクエスト間で共有しない。 */
export class SystemRandomSourceFactory implements RandomSourceFactory {
  create(): RandomSource {
    return new SystemRandomSource();
  }
}
