import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import type { SeededRandomSourceProvider } from "../../domain/ports/seeded-random-source-provider.js";

/**
 * `11_インフラストラクチャ設計.md`「SeededRandomSource」: seedから決定的な乱数列を
 * 生成する`RandomSource`アダプター。mulberry32（32bit状態の非暗号用途PRNG）を
 * 依存ライブラリなしで実装する。
 *
 * 本番の単発シミュレーションは完全再現を要件とせず`SystemRandomSource`を使い続ける。
 * 再現性と共通乱数法が要る大量試行の評価経路だけがこちらを使う。
 */
export class Mulberry32RandomSource implements RandomSource {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** 任意のseed文字列を32bit符号なし整数へ畳み込む（FNV-1a）。衝突耐性は要求しない。 */
export function hashSeedString(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const UNSIGNED_32_BIT_MAX = 0xffffffff;

/**
 * 32bit演算は引数を暗黙に切り捨て・折り返すため、範囲外の値を受け取ると別々の入力が
 * 同じサブシードへ落ちる（`2 ** 32`は`0`と、`0.5`は`0`と衝突する）。大量試行で
 * 2つの試行が黙って同じ乱数列を共有すると、分散を過小評価した統計が何の兆候もなく
 * 出るため、暗黙変換に委ねず範囲外を明示的に失敗させる。
 */
function assertUnsigned32BitInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UNSIGNED_32_BIT_MAX) {
    throw new RangeError(
      `${name} must be an unsigned 32-bit integer (0..${UNSIGNED_32_BIT_MAX}), got ${value}`,
    );
  }
}

/**
 * 試行1回分のサブシードを導出する（splitmix32のfinalizer）。
 *
 * `baseSeed`と`runIndex`以外に依存させない。一括評価は編成候補ごとに同じ`runIndex`の
 * 乱数列を共有する（共通乱数法）ことで候補間比較の分散を下げるため、候補の順序や
 * 位置がサブシードへ混ざると成立しない。
 *
 * 引数はいずれも符号なし32bit整数（`0`〜`0xffffffff`）に限る。この範囲内では加算部・
 * 各段とも32bitで可逆な変換のみで構成するため、`runIndex`が異なれば導出結果も必ず
 * 異なる（確率的にではなく構成上）。範囲外は{@link assertUnsigned32BitInteger}が弾く。
 */
export function deriveRunSeed(baseSeed: number, runIndex: number): number {
  assertUnsigned32BitInteger(baseSeed, "baseSeed");
  assertUnsigned32BitInteger(runIndex, "runIndex");
  let mixed = (baseSeed + Math.imul(runIndex + 1, 0x9e3779b9)) | 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x21f0aaad);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x735a2d97);
  mixed ^= mixed >>> 15;
  return mixed >>> 0;
}

/** {@link SeededRandomSourceProvider}のmulberry32アダプター。 */
export class Mulberry32SeededRandomSourceProvider implements SeededRandomSourceProvider {
  forRun(seed: string, runIndex: number): RandomSourceFactory {
    const runSeed = deriveRunSeed(hashSeedString(seed), runIndex);
    return {
      create: (): RandomSource => new Mulberry32RandomSource(runSeed),
    };
  }
}
