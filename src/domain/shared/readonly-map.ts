/**
 * Wraps `map` in a plain object exposing only `ReadonlyMap`'s read methods —
 * no `set`/`delete`/`clear` exist on the returned value at all, so a caller
 * cannot mutate it even by casting away the `ReadonlyMap` type (unlike
 * `Object.freeze`, which does not stop `Map.prototype.set` — Map mutation is
 * implemented via internal slots, not own properties). Used wherever a
 * Definition index or Catalog snapshot crosses an API boundary
 * (`11_インフラストラクチャ設計.md`「外部へ可変なMapや配列を返さない」).
 *
 * Takes a defensive snapshot copy so later mutation of the source `map` (if
 * the caller still holds a reference to it) cannot leak through either.
 */
export function toReadonlyMap<K, V>(map: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const snapshot = new Map(map);
  return {
    get size() {
      return snapshot.size;
    },
    get(key: K): V | undefined {
      return snapshot.get(key);
    },
    has(key: K): boolean {
      return snapshot.has(key);
    },
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
      snapshot.forEach((value, key) => callback(value, key, this), thisArg);
    },
    keys() {
      return snapshot.keys();
    },
    values() {
      return snapshot.values();
    },
    entries() {
      return snapshot.entries();
    },
    [Symbol.iterator]() {
      return snapshot[Symbol.iterator]();
    },
  };
}
