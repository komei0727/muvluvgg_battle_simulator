import type { EffectDurationState } from "./applied-effect.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/** `05_ドメインモデル.md`「MarkerState」。 */
export interface MarkerState {
  readonly markerId: MarkerId;
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  readonly stackCount: number;
  readonly stackMax: number | null;
  readonly duration: EffectDurationState;
  readonly dispellable: boolean;
  readonly linkedEffectGroupId: string | null;
}
