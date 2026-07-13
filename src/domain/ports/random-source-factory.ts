import type { RandomSource } from "./random-source.js";

/**
 * `09_アプリケーション設計.md`: 「Battleごとに専用のRandomSourceを生成する」
 * 「Battle、Observation、RandomSource、実行ガードはリクエスト間で共有しない」。
 * `SimulateBattleUseCase`は`execute`呼び出しごとにこれを介して新しい
 * `RandomSource`を1つ取得し、そのBattleの生存期間全体で使い回す。
 */
export interface RandomSourceFactory {
  create(): RandomSource;
}
