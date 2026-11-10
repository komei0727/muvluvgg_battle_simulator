// Mirrors docs/ui-design/03_API・データ連携設計.md §12.5「状態の組み立て直し」と
// docs/ddd/10_API設計.md「差分の適用」。
//
// `initialState`へ`stateTransitions`を`stateVersionAfter`の昇順に適用し、任意の版の
// 状態（`BattleStateResponse`と同じ形）を返す。版`v`の状態は`stateVersionAfter <= v`の
// 遷移をすべて適用したものである。
//
// 長い戦闘では遷移が数万件に達し、全ての版の完全な状態を保持するとメモリを使い切る。
// 呼び出し側が渡す版（行動トレースの区間の先頭）にだけ完全な状態を保持し、その間の版は
// 直前のcheckpointから必要な遷移だけを適用して求める。
//
// `entities`は`shared`へ依存できない（02_フロントエンドアーキテクチャ設計.md §5）ため、
// 入力はwire型ではなく実際に読む最小限の構造的型で受け取る。差分は`unknown`として
// 受け取り、読めない部分（未知のキー・想定外の形）は無視して落ちない。差分の値は複製して
// 状態へ入れる —— 返した状態を呼び出し側が書き換えても、入力の遷移や以後の結果を変えない。

export interface ReplaySourceUnit {
  readonly battleUnitId: string;
  readonly [key: string]: unknown;
}

export interface ReplaySourceState {
  readonly units: readonly ReplaySourceUnit[];
  readonly [key: string]: unknown;
}

export interface ReplaySourceTransition {
  readonly [key: string]: unknown;
}

/**
 * 戦術演習だけで現れ、`BattleStateResponse`に適用先を持たない差分（`exercise`と
 * `units.<id>.baseCombatStats`、R-TEX-02〜04）。状態へ混ぜると最後まで適用した結果が
 * `finalState`と一致しなくなるため、状態とは別に返す。最初の差分の`before`を初期値とし、
 * 一度も差分が現れない項目は持たない。`baseCombatStats`は差分と同じく比率のまま。
 */
export interface ReplayedExerciseState {
  readonly totalScore?: number;
  readonly breakCount?: number;
  readonly baseCombatStats: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface BattleStateReplay<TState extends ReplaySourceState> {
  /** 最後の遷移の後の版。遷移が無ければ0。 */
  readonly latestVersion: number;
  /** 版`stateVersion`の状態。返り値は呼び出しごとに独立した複製である。 */
  stateAt(stateVersion: number): TState;
  /** 版`stateVersion`の演習専用の値。演習の差分を持たない応答では`undefined`。 */
  exerciseAt(stateVersion: number): ReplayedExerciseState | undefined;
}

type MutableRecord = Record<string, unknown>;

interface MutableExercise {
  totalScore?: number;
  breakCount?: number;
  baseCombatStats: Record<string, Record<string, number>>;
}

interface Snapshot {
  readonly state: MutableRecord;
  readonly exercise: MutableExercise;
}

interface OrderedTransition {
  readonly stateVersionAfter: number;
  readonly delta: unknown;
}

/**
 * `10_API設計.md`「EntityCollectionDelta」の対象。`idField`は`added`の要素を識別するID項目。
 * `scalarField`は`updated.after`が要素全体ではなくその項目の値だけで届くときの適用先 ——
 * APIはクールタイムの更新を残数の数値だけで返す（`{ id, before: 2, after: 1 }`）ため、
 * 要素を置き換えずに`remaining`だけを書き換え、ID項目と設定スコープを残す。
 */
interface EntityCollectionSpec {
  readonly idField: string;
  readonly scalarField?: string;
}

const ENTITY_COLLECTIONS: Readonly<Record<string, EntityCollectionSpec>> = {
  effects: { idField: "effectInstanceId" },
  subUnits: { idField: "subUnitInstanceId" },
  markers: { idField: "markerInstanceId" },
  cooldowns: { idField: "skillDefinitionId", scalarField: "remaining" },
};

const RESOURCE_KEYS: readonly string[] = ["ap", "pp", "extraGauge"];
const BATTLE_KEYS: readonly string[] = ["battleStatus", "turnNumber", "cycleNumber"];
const EXERCISE_KEYS: readonly ("totalScore" | "breakCount")[] = ["totalScore", "breakCount"];
const FORMATION_SIDES: readonly string[] = ["ally", "enemy"];
const FORMATION_KEYS: readonly string[] = ["activeFormationNumber", "defeatedCount"];

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ before, after }`の形をした`ValueChange`なら、その`after`を返す。 */
function readValueChange(change: unknown): { readonly after: unknown } | undefined {
  if (!isRecord(change) || !("after" in change)) {
    return undefined;
  }
  return { after: change["after"] };
}

/** `ValueChange`を`target[key]`へ適用する。`after: null`は値が無くなったことを表す。 */
function applyValueChange(target: MutableRecord, key: string, change: unknown): void {
  const valueChange = readValueChange(change);
  if (valueChange === undefined) {
    return;
  }
  if (valueChange.after === null) {
    delete target[key];
  } else {
    target[key] = structuredClone(valueChange.after);
  }
}

function childRecord(parent: MutableRecord, key: string): MutableRecord {
  const existing = parent[key];
  if (isRecord(existing)) {
    return existing;
  }
  const created: MutableRecord = {};
  parent[key] = created;
  return created;
}

/** `{ [statName]: ValueChange }`の各項目を`target`の同名キーへ適用する。 */
function applyValueChangeMap(target: MutableRecord, key: string, changes: unknown): void {
  if (!isRecord(changes)) {
    return;
  }
  const record = childRecord(target, key);
  for (const [name, change] of Object.entries(changes)) {
    applyValueChange(record, name, change);
  }
}

/**
 * `resources`（現在値）と`resourceMaximums`（上限）の差分を、
 * `resources.{ap,pp,extraGauge}.{current,maximum}`へ適用する。
 */
function applyResourceChanges(
  unit: MutableRecord,
  changes: unknown,
  field: "current" | "maximum",
): void {
  if (!isRecord(changes)) {
    return;
  }
  for (const resourceKey of RESOURCE_KEYS) {
    if (readValueChange(changes[resourceKey]) === undefined) {
      continue;
    }
    const gauge = childRecord(childRecord(unit, "resources"), resourceKey);
    applyValueChange(gauge, field, changes[resourceKey]);
  }
}

/**
 * `EntityCollectionDelta`を配列の位置ではなくID項目で適用する。`removed`を除き、
 * `updated`をその場で`after`へ置き換え（`scalarField`を持つ集合で`after`が数値なら、
 * その項目だけを書き換え）、`added`を末尾へ加える。
 */
function applyEntityCollection(
  unit: MutableRecord,
  key: string,
  { idField, scalarField }: EntityCollectionSpec,
  delta: unknown,
): void {
  if (!isRecord(delta)) {
    return;
  }
  const added = Array.isArray(delta["added"]) ? delta["added"].filter(isRecord) : [];
  const existing = unit[key];
  if (!Array.isArray(existing) && added.length === 0) {
    return;
  }
  let elements: unknown[] = Array.isArray(existing) ? existing : [];
  const idOf = (element: unknown): unknown => (isRecord(element) ? element[idField] : undefined);

  if (Array.isArray(delta["removed"])) {
    const removedIds = new Set(
      delta["removed"].flatMap((entry) =>
        isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
      ),
    );
    elements = elements.filter((element) => {
      const id = idOf(element);
      return typeof id !== "string" || !removedIds.has(id);
    });
  }
  if (Array.isArray(delta["updated"])) {
    for (const entry of delta["updated"]) {
      if (!isRecord(entry) || typeof entry["id"] !== "string") {
        continue;
      }
      const index = elements.findIndex((element) => idOf(element) === entry["id"]);
      if (index < 0) {
        continue;
      }
      const after = entry["after"];
      const current = elements[index];
      if (isRecord(after)) {
        elements[index] = structuredClone(after);
      } else if (scalarField !== undefined && typeof after === "number" && isRecord(current)) {
        elements[index] = { ...current, [scalarField]: after };
      }
    }
  }
  for (const element of added.map((entry) => structuredClone(entry))) {
    const index = elements.findIndex((current) => idOf(current) === element[idField]);
    if (index >= 0) {
      elements[index] = element;
    } else {
      elements.push(element);
    }
  }
  unit[key] = elements;
}

function applyUnitDelta(unit: MutableRecord, delta: MutableRecord): void {
  applyValueChange(unit, "combatStatus", delta["combatStatus"]);
  if (readValueChange(delta["hp"]) !== undefined) {
    applyValueChange(childRecord(unit, "hp"), "current", delta["hp"]);
  }
  if (readValueChange(delta["hpMaximum"]) !== undefined) {
    applyValueChange(childRecord(unit, "hp"), "maximum", delta["hpMaximum"]);
  }
  applyResourceChanges(unit, delta["resources"], "current");
  applyResourceChanges(unit, delta["resourceMaximums"], "maximum");
  applyValueChangeMap(unit, "combatStats", delta["combatStats"]);
  applyValueChangeMap(unit, "shields", delta["shields"]);
  applyValueChange(unit, "charge", delta["charge"]);
  for (const [key, spec] of Object.entries(ENTITY_COLLECTIONS)) {
    applyEntityCollection(unit, key, spec, delta[key]);
  }
}

function sideRank(side: unknown): number {
  return side === "ALLY" ? 0 : side === "ENEMY" ? 1 : 2;
}

function compareUnitOrder(a: MutableRecord, b: MutableRecord): number {
  const bySide = sideRank(a["side"]) - sideRank(b["side"]);
  if (bySide !== 0) {
    return bySide;
  }
  const formationOf = (unit: MutableRecord): number =>
    typeof unit["formationNumber"] === "number" ? unit["formationNumber"] : 0;
  return formationOf(a) - formationOf(b);
}

/**
 * 総力戦の`addedUnits`を`units`の規定の位置（陣営、編成番号、配置順）へ挿入する。
 * 要素は同じ編成の中で配置順に並んで届くため、陣営・編成番号が同じかそれより前の
 * 最後のユニットの直後へ順に挿入すれば配置順も保たれる。
 */
function applyAddedUnits(units: MutableRecord[], addedUnits: unknown): void {
  if (!Array.isArray(addedUnits)) {
    return;
  }
  for (const added of addedUnits) {
    if (!isRecord(added) || typeof added["battleUnitId"] !== "string") {
      continue;
    }
    const existingIndex = units.findIndex((u) => u["battleUnitId"] === added["battleUnitId"]);
    if (existingIndex >= 0) {
      units[existingIndex] = structuredClone(added);
      continue;
    }
    let insertAt = 0;
    units.forEach((current, index) => {
      if (compareUnitOrder(current, added) <= 0) {
        insertAt = index + 1;
      }
    });
    units.splice(insertAt, 0, structuredClone(added));
  }
}

function applyFormations(state: MutableRecord, delta: unknown): void {
  const formations = state["formations"];
  if (!isRecord(delta) || !isRecord(formations)) {
    return;
  }
  for (const side of FORMATION_SIDES) {
    const sideDelta = delta[side];
    const sideState = formations[side];
    if (!isRecord(sideDelta) || !isRecord(sideState)) {
      continue;
    }
    for (const key of FORMATION_KEYS) {
      applyValueChange(sideState, key, sideDelta[key]);
    }
  }
}

function applyExercise(exercise: MutableExercise, delta: MutableRecord): void {
  const exerciseDelta = delta["exercise"];
  if (isRecord(exerciseDelta)) {
    for (const key of EXERCISE_KEYS) {
      const after = readValueChange(exerciseDelta[key])?.after;
      if (typeof after === "number") {
        exercise[key] = after;
      }
    }
  }
  forEachBaseCombatStatChange(delta, (battleUnitId, stat, change) => {
    if (typeof change["after"] === "number") {
      (exercise.baseCombatStats[battleUnitId] ??= {})[stat] = change["after"];
    }
  });
}

function forEachBaseCombatStatChange(
  delta: MutableRecord,
  visit: (battleUnitId: string, stat: string, change: MutableRecord) => void,
): void {
  const units = delta["units"];
  if (!isRecord(units)) {
    return;
  }
  for (const [battleUnitId, unitDelta] of Object.entries(units)) {
    if (!isRecord(unitDelta) || !isRecord(unitDelta["baseCombatStats"])) {
      continue;
    }
    for (const [stat, change] of Object.entries(unitDelta["baseCombatStats"])) {
      if (isRecord(change)) {
        visit(battleUnitId, stat, change);
      }
    }
  }
}

/** 1つの遷移を適用する。`addedUnits`を先に適用し、同じ遷移の`units`の対象にする。 */
function applyTransition(snapshot: Snapshot, transition: OrderedTransition): void {
  const { state, exercise } = snapshot;
  state["stateVersion"] = transition.stateVersionAfter;
  const delta = transition.delta;
  if (!isRecord(delta)) {
    return;
  }
  const units = state["units"] as MutableRecord[];
  applyAddedUnits(units, delta["addedUnits"]);
  if (isRecord(delta["units"])) {
    for (const [battleUnitId, unitDelta] of Object.entries(delta["units"])) {
      const unit = units.find((candidate) => candidate["battleUnitId"] === battleUnitId);
      if (unit !== undefined && isRecord(unitDelta)) {
        applyUnitDelta(unit, unitDelta);
      }
    }
  }
  if (isRecord(delta["battle"])) {
    for (const key of BATTLE_KEYS) {
      applyValueChange(state, key, delta["battle"][key]);
    }
  }
  if (isRecord(delta["actionQueue"]) && Array.isArray(delta["actionQueue"]["after"])) {
    state["actionQueue"] = structuredClone(delta["actionQueue"]["after"]);
  }
  applyExercise(exercise, delta);
  applyFormations(state, delta["formations"]);
}

/** 演習専用の値の初期値を、各項目が最初に現れる差分の`before`から求める。 */
function initialExercise(transitions: readonly OrderedTransition[]): MutableExercise | undefined {
  const exercise: MutableExercise = { baseCombatStats: {} };
  let found = false;
  for (const { delta } of transitions) {
    if (!isRecord(delta)) {
      continue;
    }
    const exerciseDelta = delta["exercise"];
    if (isRecord(exerciseDelta)) {
      for (const key of EXERCISE_KEYS) {
        const change = exerciseDelta[key];
        if (isRecord(change)) {
          found = true;
          if (exercise[key] === undefined && typeof change["before"] === "number") {
            exercise[key] = change["before"];
          }
        }
      }
    }
    forEachBaseCombatStatChange(delta, (battleUnitId, stat, change) => {
      found = true;
      const stats = (exercise.baseCombatStats[battleUnitId] ??= {});
      if (stats[stat] === undefined && typeof change["before"] === "number") {
        stats[stat] = change["before"];
      }
    });
  }
  return found ? exercise : undefined;
}

function orderTransitions(
  transitions: readonly ReplaySourceTransition[],
): readonly OrderedTransition[] {
  return transitions
    .flatMap((transition) => {
      const version = transition["stateVersionAfter"];
      return typeof version === "number" && Number.isInteger(version) && version > 0
        ? [{ stateVersionAfter: version, delta: transition["delta"] }]
        : [];
    })
    .sort((a, b) => a.stateVersionAfter - b.stateVersionAfter);
}

/** `stateVersionAfter > version`となる最初の遷移の位置。 */
function firstIndexAfter(transitions: readonly OrderedTransition[], version: number): number {
  let low = 0;
  let high = transitions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (transitions[middle]!.stateVersionAfter <= version) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}

export function createBattleStateReplay<TState extends ReplaySourceState>(
  initialState: TState,
  stateTransitions: readonly ReplaySourceTransition[],
  checkpointVersions: readonly number[],
): BattleStateReplay<TState> {
  const transitions = orderTransitions(stateTransitions);
  const latestVersion = transitions.at(-1)?.stateVersionAfter ?? 0;
  const exerciseSeed = initialExercise(transitions);

  const initialSnapshot: Snapshot = {
    state: structuredClone(initialState),
    exercise: exerciseSeed ?? { baseCombatStats: {} },
  };
  if (!Array.isArray(initialSnapshot.state["units"])) {
    initialSnapshot.state["units"] = [];
  }

  // 昇順のcheckpoint版と、その時点の完全な状態。版0は常に持つ。
  const checkpointList = [
    ...new Set(
      checkpointVersions.filter((v) => Number.isInteger(v) && v > 0 && v <= latestVersion),
    ),
  ].sort((a, b) => a - b);
  const checkpoints: { readonly version: number; readonly snapshot: Snapshot }[] = [
    { version: 0, snapshot: cloneSnapshot(initialSnapshot) },
  ];
  if (checkpointList.length > 0) {
    const working = initialSnapshot;
    let next = 0;
    for (const transition of transitions) {
      if (next >= checkpointList.length) {
        break;
      }
      // 遷移の版が飛ぶとき、間の版のcheckpointはこの遷移を適用する前の状態である
      while (next < checkpointList.length && checkpointList[next]! < transition.stateVersionAfter) {
        checkpoints.push({ version: checkpointList[next]!, snapshot: cloneSnapshot(working) });
        next += 1;
      }
      applyTransition(working, transition);
      while (
        next < checkpointList.length &&
        checkpointList[next]! === transition.stateVersionAfter
      ) {
        checkpoints.push({ version: checkpointList[next]!, snapshot: cloneSnapshot(working) });
        next += 1;
      }
    }
  }

  function snapshotAt(stateVersion: number): Snapshot {
    if (!Number.isInteger(stateVersion) || stateVersion < 0 || stateVersion > latestVersion) {
      throw new RangeError(
        `stateVersion ${String(stateVersion)} is outside 0..${String(latestVersion)}`,
      );
    }
    let checkpoint = checkpoints[0]!;
    for (const candidate of checkpoints) {
      if (candidate.version > stateVersion) {
        break;
      }
      checkpoint = candidate;
    }
    const snapshot = cloneSnapshot(checkpoint.snapshot);
    for (
      let index = firstIndexAfter(transitions, checkpoint.version);
      index < transitions.length && transitions[index]!.stateVersionAfter <= stateVersion;
      index += 1
    ) {
      applyTransition(snapshot, transitions[index]!);
    }
    return snapshot;
  }

  return {
    latestVersion,
    stateAt(stateVersion) {
      return snapshotAt(stateVersion).state as unknown as TState;
    },
    exerciseAt(stateVersion) {
      const { exercise } = snapshotAt(stateVersion);
      return exerciseSeed === undefined ? undefined : exercise;
    },
  };
}
