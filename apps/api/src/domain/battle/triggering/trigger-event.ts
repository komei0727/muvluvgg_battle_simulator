import type { EventCategory } from "../../catalog/definitions/catalog-enums.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";

/**
 * `PassiveTriggerMatcher`が照合する任意のDomain Eventの最小形。M6時点で本番の
 * `BattleDomainEvent`(`battle/events`)へは依存しない — `payload: unknown`が
 * 任意の具体的payload型を構造的に受け付けるため、`EffectApplied`のようにM7で
 * 初めて本番発行される種別も、`eventType`ごとの分岐なしにテストで直接構築できる
 * (R-PS-01「イベント種別の固定タイミング分岐なしで候補検出できる」)。
 */
export interface TriggerCandidateEvent {
  readonly eventType: string;
  readonly category: EventCategory;
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
  readonly targetUnitIds?: readonly BattleUnitId[];
  readonly payload: Readonly<Record<string, unknown>>;
}
