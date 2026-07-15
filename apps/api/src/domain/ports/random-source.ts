export interface RandomSource {
  /** Returns a value in [0, 1). */
  next(): number;
}
