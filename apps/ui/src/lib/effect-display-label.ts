// docs/ui-design/01_UI要求・画面設計.md §8.6「効果の表示名」: 効果インスタンス・効果定義を
// `キャラ正式名-スキル種別番号-効果内容`で表す。論理名（`effectActionDefinitionId`）は
// 本文に出さず、呼び出し側がツールチップへ回す。
//
// 付与元スキルは戦闘ログの`skillUseId`から引き、効果IDから逆引きしない —— 複数スキルが
// 同じ効果定義を共有するため、効果IDだけでは付与したスキルが決まらない。
//
// `lib`は`shared`・`entities`へ依存できないため、Catalog・ロスター・イベントは読む項目だけを
// 構造的型で受け取る（`shared/api`のwire型の値をそのまま渡せる）。

export interface EffectLabelSkillSummary {
  readonly skillDefinitionId: string;
  /** 宣言ユニットがちょうど1体のスキルだけが持つ（`AS1`／`PS2`／`EX`等）。 */
  readonly slotLabel?: string;
}

export interface EffectLabelEffectSummary {
  readonly effectActionDefinitionId: string;
  readonly kind: string;
  readonly stat?: string;
  readonly valueType?: string;
  readonly direction?: string;
  readonly damageType?: string;
  readonly status?: string;
  /** `formula`が`CONSTANT`のときだけ届く。`EffectApplied.magnitude`と同じ尺度。 */
  readonly constantMagnitude?: number;
}

export interface EffectLabelMemorySummary {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
}

export interface EffectLabelCatalog {
  /** 旧APIは返さないため任意。不在時は付与元スキルと効果内容を解決できない。 */
  readonly skills?: readonly EffectLabelSkillSummary[];
  readonly effects?: readonly EffectLabelEffectSummary[];
  readonly memories?: readonly EffectLabelMemorySummary[];
}

export type EffectLabelUnitNames = ReadonlyMap<string, { readonly displayName: string }>;

export type EffectLabelEvent = Readonly<Record<string, unknown>>;

/** 効果インスタンス1件の付与。`EffectApplied`のエンベロープ・detailsから取り出したもの。 */
export interface EffectGrantLabelInput {
  readonly effectActionDefinitionId: string;
  readonly originUnitId?: string;
  /** `originUnitId`を持たない付与（R-MEM-04のメモリー由来）の発生陣営。 */
  readonly originSide?: string;
  readonly skillUseId?: string;
  /** 付与時点で評価された効果量（`EffectApplied.magnitude`）。 */
  readonly magnitude?: number;
}

export interface EffectLabeler {
  /** インスタンスの表示名。量は付与時点の`magnitude`を使う。 */
  grantLabel(grant: EffectGrantLabelInput): string;
  /**
   * 効果定義の表示名。量は定義上の固定値だけを使う（付与ごとの量は定義単位では1つに決まらない）。
   * 付与元は、渡した付与の付与元がすべて同じときだけ出す。
   */
  definitionLabel(
    effectActionDefinitionId: string,
    grants: readonly EffectGrantLabelInput[],
  ): string;
  /**
   * 効果インスタンスの表示名。同じ`effectInstanceId`の付与（`EFFECT_APPLIED`と、採用元を
   * 入れ替えた`EFFECT_MERGED`）の履歴から引き、無ければ`fallback`（状態スナップショットが
   * 持つ付与元等）と定義上の固定値で表す。どちらも無ければインスタンスIDを返す。
   *
   * `atSequence`を渡すとその時点までの履歴だけを見る（イベントの文言用）。`fallback`が
   * 定義を持てば、それと定義・付与元が一致する最新の付与を使う（スナップショット用。
   * 統合で採用元が入れ替わる前の状態でも、その状態の付与元で表す）。
   */
  instanceLabel(
    effectInstanceId: string,
    fallback?: EffectGrantLabelInput,
    atSequence?: number,
  ): string;
  /** 付与履歴から引いたインスタンスの論理名。ツールチップへ回すために使う。 */
  instanceDefinitionId(effectInstanceId: string, atSequence?: number): string | undefined;
  /**
   * スキルの表示名`キャラ正式名-スキル種別番号`。種別番号が引けなければその位置に論理名を出す
   * （効果内容が引けない場合と同じ縮退）。使用者が分からなければ種別番号だけで表す。
   */
  skillLabel(actorUnitId: string | undefined, skillDefinitionId: string): string;
  /** スキル定義単位の表示名。キャラ名は、使用者が全員同じ表示名のときだけ出す。 */
  skillDefinitionLabel(skillDefinitionId: string, actorUnitIds: readonly string[]): string;
}

const SEPARATOR = "-";

/** `effect-event-formatters.ts`の`resolveOrigin`と同じ規約: 発生源がユニットでなければ陣営で表す。 */
const MEMORY_ORIGIN_SUFFIX = "陣営のMemory";

const STAT_LABELS: Readonly<Record<string, string>> = {
  MAXIMUM_HP: "HP",
  ATTACK: "攻撃力",
  DEFENSE: "防御力",
  ACTION_SPEED: "行動速度",
  CRITICAL_RATE: "会心率",
  CRITICAL_DAMAGE_BONUS: "会心ダメージ",
  AFFINITY_BONUS: "属性相性",
};

/**
 * R-STA-01「パーセントポイント加算ステータス」。それ自体がパーセンテージで表される値であり、
 * `valueType: FIXED`でも量は`0.3`＝30%の尺度で届く。
 */
const POINT_ADDITIVE_STATS: ReadonlySet<string> = new Set([
  "CRITICAL_RATE",
  "CRITICAL_DAMAGE_BONUS",
  "AFFINITY_BONUS",
]);

const DAMAGE_DIRECTION_LABELS: Readonly<Record<string, string>> = {
  OUTGOING: "与",
  INCOMING: "被",
};

const DAMAGE_TYPE_LABELS: Readonly<Record<string, string>> = {
  PHYSICAL: "物理",
  EN: "EN",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  STUN: "気絶",
  FREEZE: "凍結",
  BLIND: "暗闇",
  STEALTH: "ステルス",
  EVASION: "回避",
  HIT_EVASION: "回避",
  DAMAGE_IMMUNITY: "ダメージ無効",
  CRITICAL_GUARANTEE: "会心確定",
  CRITICAL_PREVENTION: "会心不可",
  GUARANTEED_HIT: "必中",
  CONFUSION: "混乱",
  DAMAGE_TO_HEAL: "幻惑",
};

/** 量の文言を持たないkindの種別名。ここに無いkind（将来の追加）は効果内容を解決できない扱いにする。 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  DAMAGE: "ダメージ",
  HEAL: "回復",
  APPLY_CONTINUOUS_HEAL: "継続回復",
  APPLY_CONTINUOUS_DAMAGE: "継続ダメージ",
  APPLY_STAT_MOD: "ステータス補正",
  APPLY_DAMAGE_MOD: "ダメージ補正",
  APPLY_PIERCING_MOD: "貫通補正",
  APPLY_HEALING_MOD: "回復量補正",
  APPLY_HEALING_LINK: "回復リンク",
  MODIFY_RESOURCE: "リソース増減",
  MODIFY_RESOURCE_CAPACITY: "リソース上限増減",
  APPLY_STATUS: "状態",
  APPLY_SHIELD: "シールド",
  REMOVE_EFFECTS: "効果解除",
  EFFECT_IMMUNITY: "効果無効",
  APPLY_MARKER: "マーカー",
  REMOVE_MARKER: "マーカー除去",
  APPLY_DEATH_SURVIVAL: "戦闘不能耐性",
  APPLY_TARGET_REDIRECT: "狙われ変更",
  APPLY_COVER: "かばう",
  APPLY_REFLECT: "反射",
  APPLY_DAMAGE_LINK: "ダメージリンク",
  APPLY_SUBUNIT: "サブユニット",
  COOLDOWN_MANIPULATION: "クールタイム操作",
  APPLY_ATTACK_DAMAGE_BONUS: "攻撃ダメージ加算",
  APPLY_FOLLOW_UP_ATTACK: "追撃",
  APPLY_RESOURCE_GAIN_MOD: "獲得量補正",
};

/** 小数第2位までに丸め、`0.07 * 100`のような浮動小数誤差を表示へ出さない。 */
function trimNumber(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function signed(value: number, text: string): string {
  return `${value < 0 ? "-" : "+"}${text}`;
}

function percentText(ratio: number): string {
  return signed(ratio, `${trimNumber(Math.abs(ratio) * 100)}%`);
}

function statModText(summary: EffectLabelEffectSummary, magnitude: number | undefined): string {
  const statLabel =
    summary.stat !== undefined
      ? (STAT_LABELS[summary.stat] ?? summary.stat)
      : KIND_LABELS["APPLY_STAT_MOD"]!;
  if (magnitude === undefined) {
    return statLabel;
  }
  const asPercent =
    summary.valueType === "RATIO" ||
    (summary.stat !== undefined && POINT_ADDITIVE_STATS.has(summary.stat));
  return `${statLabel}${asPercent ? percentText(magnitude) : signed(magnitude, trimNumber(Math.abs(magnitude)))}`;
}

function damageModText(summary: EffectLabelEffectSummary, magnitude: number | undefined): string {
  const direction =
    summary.direction !== undefined ? DAMAGE_DIRECTION_LABELS[summary.direction] : undefined;
  const damageType =
    summary.damageType !== undefined
      ? (DAMAGE_TYPE_LABELS[summary.damageType] ?? summary.damageType)
      : "";
  const label =
    direction !== undefined
      ? `${direction}${damageType}ダメージ`
      : KIND_LABELS["APPLY_DAMAGE_MOD"]!;
  return magnitude === undefined ? label : `${label}${percentText(magnitude)}`;
}

function contentText(
  summary: EffectLabelEffectSummary | undefined,
  magnitude: number | undefined,
): string | undefined {
  if (summary === undefined) {
    return undefined;
  }
  switch (summary.kind) {
    case "APPLY_STAT_MOD":
      return statModText(summary, magnitude);
    case "APPLY_DAMAGE_MOD":
      return damageModText(summary, magnitude);
    case "APPLY_STATUS":
      return summary.status !== undefined
        ? (STATUS_LABELS[summary.status] ?? summary.status)
        : KIND_LABELS["APPLY_STATUS"];
    case "APPLY_SHIELD":
      return magnitude === undefined
        ? KIND_LABELS["APPLY_SHIELD"]
        : `${KIND_LABELS["APPLY_SHIELD"]!}(${Math.round(magnitude).toString()})`;
    default:
      return KIND_LABELS[summary.kind];
  }
}

interface SkillUseOrigin {
  readonly skillDefinitionId?: string;
  readonly memoryDefinitionId?: string;
}

function detailString(event: EffectLabelEvent, key: string): string | undefined {
  const details = event["details"];
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * `skillUseId`ごとの発生源。同じ`skillUseId`のうち`sequence`が最も小さい、
 * `skillDefinitionId`（`SKILL_USE_STARTED`／`PASSIVE_ACTIVATED`等）または`memoryDefinitionId`
 * （`MEMORY_TRIGGERED`）を持つイベントから取る。Memoryの解決もPSと同じく`skillUseId`を採番する。
 */
function indexSkillUseOrigins(
  events: readonly EffectLabelEvent[],
): ReadonlyMap<string, SkillUseOrigin> {
  const sorted = [...events].sort(
    (a, b) =>
      (typeof a["sequence"] === "number" ? a["sequence"] : 0) -
      (typeof b["sequence"] === "number" ? b["sequence"] : 0),
  );
  const origins = new Map<string, SkillUseOrigin>();
  for (const event of sorted) {
    const skillUseId = event["skillUseId"];
    if (typeof skillUseId !== "string" || origins.has(skillUseId)) {
      continue;
    }
    const skillDefinitionId = detailString(event, "skillDefinitionId");
    if (skillDefinitionId !== undefined) {
      origins.set(skillUseId, { skillDefinitionId });
      continue;
    }
    const memoryDefinitionId = detailString(event, "memoryDefinitionId");
    if (memoryDefinitionId !== undefined) {
      origins.set(skillUseId, { memoryDefinitionId });
    }
  }
  return origins;
}

function detailNumber(event: EffectLabelEvent, key: string): number | undefined {
  const details = event["details"];
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function envelopeString(event: EffectLabelEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

interface GrantRecord {
  readonly sequence: number;
  readonly grant: EffectGrantLabelInput;
}

function sequenceOf(event: EffectLabelEvent): number {
  return typeof event["sequence"] === "number" ? event["sequence"] : 0;
}

/** 付与元の読み方は`effect-trace-projector.ts`と同じ（detailsを優先し、無ければエンベロープ）。 */
function grantFrom(
  event: EffectLabelEvent,
  effectActionDefinitionId: string,
  magnitude: number | undefined,
): EffectGrantLabelInput {
  const originUnitId = detailString(event, "sourceUnitId") ?? envelopeString(event, "sourceUnitId");
  const originSide = detailString(event, "sourceSide") ?? envelopeString(event, "sourceSide");
  const skillUseId = envelopeString(event, "skillUseId");
  return {
    effectActionDefinitionId,
    ...(originUnitId !== undefined ? { originUnitId } : {}),
    ...(originUnitId === undefined && originSide !== undefined ? { originSide } : {}),
    ...(skillUseId !== undefined ? { skillUseId } : {}),
    ...(magnitude !== undefined ? { magnitude } : {}),
  };
}

/**
 * R-DOT-04の毒の統合で、新しい付与の効果量が採られたか。採られた場合だけDomainは定義・付与者を
 * 新しい付与のものへ入れ替える（`continuous-damage-service.ts`）。採否は統合時点で評価した
 * 毒ダメージの比較（新しい付与が厳密に大きいときだけ採る）なので、`tickDamageAfter`が
 * `tickDamageBefore`を上回ることと同値になる。比較値を持たないログでは定義の変化で判断する。
 */
function mergeAdoptsIncoming(event: EffectLabelEvent, current: EffectGrantLabelInput): boolean {
  const before = detailNumber(event, "tickDamageBefore");
  const after = detailNumber(event, "tickDamageAfter");
  if (before !== undefined && after !== undefined) {
    return after > before;
  }
  return detailString(event, "effectActionDefinitionId") !== current.effectActionDefinitionId;
}

/**
 * `effectInstanceId`ごとの付与の履歴（`sequence`昇順）。`EFFECT_APPLIED`で始まり、毒の統合
 * （`EFFECT_MERGED`）で採用元が入れ替わるたびに1件積む。インスタンスIDは統合でも変わらない。
 */
function indexGrantHistory(
  events: readonly EffectLabelEvent[],
): ReadonlyMap<string, readonly GrantRecord[]> {
  const sorted = [...events].sort((a, b) => sequenceOf(a) - sequenceOf(b));
  const history = new Map<string, GrantRecord[]>();
  for (const event of sorted) {
    const effectInstanceId = detailString(event, "effectInstanceId");
    const effectActionDefinitionId = detailString(event, "effectActionDefinitionId");
    if (effectInstanceId === undefined || effectActionDefinitionId === undefined) {
      continue;
    }
    const records = history.get(effectInstanceId);
    if (event["type"] === "EFFECT_APPLIED") {
      const record = {
        sequence: sequenceOf(event),
        grant: grantFrom(event, effectActionDefinitionId, detailNumber(event, "magnitude")),
      };
      history.set(effectInstanceId, [...(records ?? []), record]);
      continue;
    }
    const current = records?.at(-1);
    if (event["type"] === "EFFECT_MERGED" && records !== undefined && current !== undefined) {
      if (mergeAdoptsIncoming(event, current.grant)) {
        records.push({
          sequence: sequenceOf(event),
          grant: grantFrom(event, effectActionDefinitionId, detailNumber(event, "magnitudeAfter")),
        });
      }
    }
  }
  return history;
}

/** スナップショットの定義・付与元と食い違わない付与か。付与元を持たない代替は定義だけで比べる。 */
function matchesFallback(grant: EffectGrantLabelInput, fallback: EffectGrantLabelInput): boolean {
  if (grant.effectActionDefinitionId !== fallback.effectActionDefinitionId) {
    return false;
  }
  if (fallback.originUnitId === undefined && fallback.originSide === undefined) {
    return true;
  }
  return grant.originUnitId === fallback.originUnitId && grant.originSide === fallback.originSide;
}

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(SEPARATOR);
}

export function createEffectLabeler(
  catalog: EffectLabelCatalog | undefined,
  units: EffectLabelUnitNames,
  events: readonly EffectLabelEvent[],
): EffectLabeler {
  const slotBySkillId = new Map(
    (catalog?.skills ?? []).map((skill) => [skill.skillDefinitionId, skill.slotLabel] as const),
  );
  const effectById = new Map(
    (catalog?.effects ?? []).map((effect) => [effect.effectActionDefinitionId, effect] as const),
  );
  const memoryNameById = new Map(
    (catalog?.memories ?? []).map(
      (memory) => [memory.memoryDefinitionId, memory.displayName] as const,
    ),
  );
  const skillUseOrigins = indexSkillUseOrigins(events);
  const grantHistory = indexGrantHistory(events);

  /** その時点までの履歴のうち、代替と食い違わない最新の付与。代替が無ければ最新の付与。 */
  function grantOf(
    effectInstanceId: string,
    fallback: EffectGrantLabelInput | undefined,
    atSequence: number | undefined,
  ): EffectGrantLabelInput | undefined {
    const records = (grantHistory.get(effectInstanceId) ?? []).filter(
      (record) => atSequence === undefined || record.sequence <= atSequence,
    );
    const candidates =
      fallback === undefined
        ? records
        : records.filter((record) => matchesFallback(record.grant, fallback));
    return candidates.at(-1)?.grant;
  }

  /** 付与元（キャラ名-スキル種別番号、メモリー名、または陣営）。何も分からなければ空文字。 */
  function originPrefixOf(grant: EffectGrantLabelInput): string {
    const origin =
      grant.skillUseId !== undefined ? skillUseOrigins.get(grant.skillUseId) : undefined;
    if (grant.originUnitId !== undefined) {
      const unitName = units.get(grant.originUnitId)?.displayName ?? grant.originUnitId;
      const slot =
        origin?.skillDefinitionId !== undefined
          ? slotBySkillId.get(origin.skillDefinitionId)
          : undefined;
      return joinParts([unitName, slot]);
    }
    const memoryName =
      origin?.memoryDefinitionId !== undefined
        ? memoryNameById.get(origin.memoryDefinitionId)
        : undefined;
    if (memoryName !== undefined) {
      return memoryName;
    }
    return grant.originSide !== undefined ? `${grant.originSide}${MEMORY_ORIGIN_SUFFIX}` : "";
  }

  function contentOf(effectActionDefinitionId: string, magnitude: number | undefined): string {
    return (
      contentText(effectById.get(effectActionDefinitionId), magnitude) ?? effectActionDefinitionId
    );
  }

  function grantLabel(grant: EffectGrantLabelInput): string {
    return joinParts([
      originPrefixOf(grant),
      contentOf(grant.effectActionDefinitionId, grant.magnitude),
    ]);
  }

  function slotOf(skillDefinitionId: string): string {
    return slotBySkillId.get(skillDefinitionId) ?? skillDefinitionId;
  }

  return {
    grantLabel,
    instanceLabel(effectInstanceId, fallback, atSequence) {
      const grant = grantOf(effectInstanceId, fallback, atSequence);
      if (grant !== undefined) {
        return grantLabel(grant);
      }
      if (fallback === undefined) {
        return effectInstanceId;
      }
      const magnitude =
        fallback.magnitude ?? effectById.get(fallback.effectActionDefinitionId)?.constantMagnitude;
      return grantLabel({ ...fallback, ...(magnitude !== undefined ? { magnitude } : {}) });
    },
    instanceDefinitionId(effectInstanceId, atSequence) {
      return grantOf(effectInstanceId, undefined, atSequence)?.effectActionDefinitionId;
    },
    skillLabel(actorUnitId, skillDefinitionId) {
      const unitName =
        actorUnitId !== undefined
          ? (units.get(actorUnitId)?.displayName ?? actorUnitId)
          : undefined;
      return joinParts([unitName, slotOf(skillDefinitionId)]);
    },
    skillDefinitionLabel(skillDefinitionId, actorUnitIds) {
      const names = new Set(
        actorUnitIds.map((actorUnitId) => units.get(actorUnitId)?.displayName ?? actorUnitId),
      );
      const unitName = names.size === 1 ? [...names][0] : undefined;
      return joinParts([unitName, slotOf(skillDefinitionId)]);
    },
    definitionLabel(effectActionDefinitionId, grants) {
      const prefixes = new Set(grants.map(originPrefixOf));
      const prefix = prefixes.size === 1 ? [...prefixes][0] : undefined;
      return joinParts([
        prefix,
        contentOf(
          effectActionDefinitionId,
          effectById.get(effectActionDefinitionId)?.constantMagnitude,
        ),
      ]);
    },
  };
}
