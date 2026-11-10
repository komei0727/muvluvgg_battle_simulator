import { useId } from "react";
import { svgIdOf } from "./svg-id.js";
import type {
  TraceChipKind,
  TraceChipView,
  TraceGaugeView,
  TraceUnitCardView,
} from "./trace-board-view.js";
import styles from "./UnitTraceCard.module.css";

// 01_UI要求・画面設計.md §8.10「盤面」。`index.html`のCSP（`style-src 'self'`）のため、
// バー・ゲージの幅はinline styleではなくSVGの属性で与え、色と模様はCSS Modulesのclassへ
// 分ける。バーの座標系は横100（最大値に対する百分率）とし、`preserveAspectRatio="none"`で
// カードの幅へ伸ばす。

export interface UnitTraceCardProps {
  readonly card: TraceUnitCardView;
}

const BAR_WIDTH = 100;
/** シールドが細すぎて見えなくならないよう、HPが満タンでも最低限の幅を見せる。 */
const MIN_SHIELD_WIDTH = 4;

const SIDE_LABEL = { ALLY: "味方", ENEMY: "敵" } as const;
const ROW_LABEL = { FRONT: "前衛", REAR: "後衛" } as const;

const CHIP_KIND_LABEL: Readonly<Record<TraceChipKind, string>> = {
  BUFF: "バフ",
  DEBUFF: "デバフ",
  STATUS_ABNORMALITY: "状態異常",
  MARKER: "マーカー",
  CHARGE: "チャージ",
  OTHER: "効果",
};

const CHIP_KIND_CLASS: Readonly<Record<TraceChipKind, string | undefined>> = {
  BUFF: styles.chipBuff,
  DEBUFF: styles.chipDebuff,
  STATUS_ABNORMALITY: styles.chipStatus,
  MARKER: styles.chipMarker,
  CHARGE: styles.chipCharge,
  OTHER: styles.chipOther,
};

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("ja-JP");
}

function signed(value: number): string {
  return `${value > 0 ? "+" : "−"}${formatNumber(Math.abs(value))}`;
}

function percent(value: number, maximum: number): number {
  if (maximum <= 0) {
    return 0;
  }
  const ratio = Math.min(Math.max(value / maximum, 0), 1);
  return Math.round(ratio * BAR_WIDTH * 100) / 100;
}

function classNames(...names: readonly (string | false | undefined)[]): string {
  return names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");
}

function tagsOf(card: TraceUnitCardView): readonly string[] {
  return [
    ...(card.roles.actor ? ["行動中"] : []),
    ...(card.roles.activator ? ["PS発動"] : []),
    ...(card.roles.target ? ["対象"] : []),
  ];
}

function HpBar({
  hp,
  shield,
  patternId,
}: {
  readonly hp: TraceGaugeView;
  readonly shield: number;
  readonly patternId: string;
}) {
  const before = percent(hp.before, hp.maximum);
  const after = percent(hp.after, hp.maximum);
  const low = Math.min(before, after);
  const shieldWidth =
    shield > 0
      ? Math.max(MIN_SHIELD_WIDTH, percent(Math.min(shield, hp.maximum - hp.after), hp.maximum))
      : 0;
  const shieldX = Math.min(after, BAR_WIDTH - shieldWidth);
  const change = hp.after - hp.before;
  const label = `HP ${formatNumber(hp.after)} / ${formatNumber(hp.maximum)}${change !== 0 ? `（${signed(change)}）` : ""}`;
  return (
    <svg
      className={styles.bar}
      role="img"
      aria-label={label}
      viewBox={`0 0 ${BAR_WIDTH.toString()} 8`}
      preserveAspectRatio="none"
      width="100%"
      height="8"
    >
      <defs>
        <pattern
          id={patternId}
          width="3"
          height="8"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect className={styles.shieldStripe} width="1.5" height="8" />
        </pattern>
      </defs>
      <rect className={styles.track} width={BAR_WIDTH} height="8" />
      <rect className={styles.hpFill} width={low} height="8" />
      {after < before ? (
        <rect className={styles.hpLost} x={after} width={before - after} height="8" />
      ) : null}
      {after > before ? (
        <rect className={styles.hpGained} x={before} width={after - before} height="8" />
      ) : null}
      {shieldWidth > 0 ? (
        <rect
          className={styles.shieldFill}
          x={shieldX}
          width={shieldWidth}
          height="8"
          fill={`url(#${patternId})`}
        />
      ) : null}
    </svg>
  );
}

function Pips({ label, gauge }: { readonly label: string; readonly gauge: TraceGaugeView }) {
  const change = gauge.after - gauge.before;
  const changeText =
    change < 0
      ? `（${(-change).toString()}消費）`
      : change > 0
        ? `（${change.toString()}獲得）`
        : "";
  const pips = Array.from({ length: gauge.maximum }, (_, position) => {
    if (position < gauge.after) {
      return position >= gauge.before ? "gain" : "on";
    }
    return position < gauge.before ? "spent" : "empty";
  });
  return (
    <span
      className={styles.resource}
      role="img"
      aria-label={`${label} ${gauge.after.toString()} / ${gauge.maximum.toString()}${changeText}`}
    >
      <span aria-hidden="true">{label}</span>
      <span className={styles.pips} aria-hidden="true">
        {pips.map((state, position) => (
          <span
            key={position}
            className={classNames(styles.pip, styles[`pip-${state}`])}
            data-pip={state}
          />
        ))}
      </span>
    </span>
  );
}

function ExGauge({ gauge }: { readonly gauge: TraceGaugeView }) {
  const change = gauge.after - gauge.before;
  return (
    <span
      className={styles.extra}
      role="img"
      aria-label={`EX ${gauge.after.toString()} / ${gauge.maximum.toString()}${change !== 0 ? `（${change > 0 ? "+" : "−"}${Math.abs(change).toString()}）` : ""}`}
    >
      <span aria-hidden="true">EX</span>
      <svg
        className={styles.exBar}
        aria-hidden="true"
        viewBox={`0 0 ${BAR_WIDTH.toString()} 4`}
        preserveAspectRatio="none"
        width="100%"
        height="4"
      >
        <rect className={styles.track} width={BAR_WIDTH} height="4" />
        <rect className={styles.exFill} width={percent(gauge.after, gauge.maximum)} height="4" />
      </svg>
      <span aria-hidden="true">{gauge.after}</span>
    </span>
  );
}

function chipLabel(chip: TraceChipView): string {
  return [
    CHIP_KIND_LABEL[chip.kind],
    chip.label,
    ...(chip.remaining !== undefined
      ? [chip.kind === "MARKER" ? chip.remaining : `残り${chip.remaining}`]
      : []),
    ...(chip.ineffective ? ["次点"] : []),
    ...(chip.change === "added" ? ["付与"] : chip.change === "removed" ? ["解除"] : []),
  ].join(" ");
}

function Chip({ chip }: { readonly chip: TraceChipView }) {
  const label = chipLabel(chip);
  return (
    <li
      className={classNames(
        styles.chip,
        CHIP_KIND_CLASS[chip.kind],
        chip.change === "added" && styles.chipAdded,
        chip.change === "removed" && styles.chipRemoved,
        chip.ineffective && styles.chipIneffective,
      )}
      title={label}
      aria-label={label}
    >
      <span className={styles.chipLabel} aria-hidden="true">
        {chip.label}
      </span>
      {chip.remaining !== undefined ? (
        <span className={styles.chipRemaining} aria-hidden="true">
          {chip.remaining}
        </span>
      ) : null}
    </li>
  );
}

export function UnitTraceCard({ card }: UnitTraceCardProps) {
  const patternId = svgIdOf(useId());
  const tags = tagsOf(card);
  const position = `${SIDE_LABEL[card.side]} ${ROW_LABEL[card.row]}${(card.column + 1).toString()}`;
  const label = `${card.displayName}（${position}）${[...tags, ...(card.defeated ? ["撃破"] : [])].join(" ")}`;
  return (
    <div
      role="group"
      aria-label={label}
      data-trace-unit={card.battleUnitId}
      className={classNames(
        styles.card,
        card.side === "ALLY" ? styles.ally : styles.enemy,
        card.roles.actor && styles.actor,
        card.roles.activator && styles.activator,
        card.roles.target && styles.target,
        card.defeated && styles.defeated,
      )}
    >
      {tags.length > 0 ? (
        <span className={styles.tags} aria-hidden="true">
          {tags.map((tag) => (
            <span key={tag} className={styles.tag}>
              {tag}
            </span>
          ))}
        </span>
      ) : null}
      {card.damage !== undefined ? (
        <span className={classNames(styles.delta, styles.deltaDamage)}>
          <span className={styles.deltaValue}>−{formatNumber(card.damage.total)}</span>
          {card.damage.hits > 1 ? (
            <span className={styles.deltaSub}>{card.damage.hits} HIT</span>
          ) : null}
          {card.damage.critical ? <span className={styles.deltaSub}>会心</span> : null}
          {card.damage.shieldAbsorbed > 0 ? (
            <span className={styles.deltaSub}>盾 −{formatNumber(card.damage.shieldAbsorbed)}</span>
          ) : null}
        </span>
      ) : card.heal !== undefined ? (
        <span className={classNames(styles.delta, styles.deltaHeal)}>
          <span className={styles.deltaValue}>+{formatNumber(card.heal.total)}</span>
        </span>
      ) : null}
      {card.defeated ? <span className={styles.defeatedBadge}>撃破</span> : null}
      <div className={styles.top}>
        <span className={styles.name} title={card.displayName}>
          {card.name}
        </span>
        {card.actionOrder !== undefined ? (
          <span className={styles.order}>順{card.actionOrder}</span>
        ) : null}
      </div>
      <div className={styles.hp}>
        <HpBar hp={card.hp} shield={card.shield.after} patternId={patternId} />
        <div className={styles.hpText}>
          <span>
            <b>{formatNumber(card.hp.after)}</b> / {formatNumber(card.hp.maximum)}
          </span>
          {card.shield.after > 0 ? (
            <span className={styles.shieldText}>盾 {formatNumber(card.shield.after)}</span>
          ) : null}
        </div>
      </div>
      <div className={styles.resources}>
        {card.ap !== undefined ? <Pips label="AP" gauge={card.ap} /> : null}
        {card.pp !== undefined ? <Pips label="PP" gauge={card.pp} /> : null}
        {card.extraGauge !== undefined ? <ExGauge gauge={card.extraGauge} /> : null}
      </div>
      {card.chips.length > 0 ? (
        <ul className={styles.chips} aria-label="効果">
          {card.chips.map((chip) => (
            <Chip key={chip.key} chip={chip} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
