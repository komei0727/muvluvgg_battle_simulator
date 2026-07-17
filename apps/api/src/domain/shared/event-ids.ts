import type { Brand } from "./brand.js";
import { DomainValidationError } from "./errors.js";

function requireNonEmpty(brandName: string, path: string, value: string): void {
  if (value.length === 0) {
    throw new DomainValidationError(path, `${brandName} must not be empty`);
  }
}

/** `08_ドメインイベント.md`「イベントID」: `${battleId}:${sequence}` 形式で`EventRecorder`が採番する。 */
export type DomainEventId = Brand<string, "DomainEventId">;
export function createDomainEventId(value: string, path = "domainEventId"): DomainEventId {
  requireNonEmpty("DomainEventId", path, value);
  return value as DomainEventId;
}

/** `08_ドメインイベント.md`「resolutionScopeId」: ユニット行動ではActionIdと対応する。`EventRecorder`が採番する。 */
export type ActionId = Brand<string, "ActionId">;
export function createActionId(value: string, path = "actionId"): ActionId {
  requireNonEmpty("ActionId", path, value);
  return value as ActionId;
}

/** `08_ドメインイベント.md`「同じSkillUseIdに属するイベントを関連づける」。`EventRecorder`が採番する。 */
export type SkillUseId = Brand<string, "SkillUseId">;
export function createSkillUseId(value: string, path = "skillUseId"): SkillUseId {
  requireNonEmpty("SkillUseId", path, value);
  return value as SkillUseId;
}

/** `08_ドメインイベント.md`「resolutionScopeId」: PS発動済み集合と候補スタックを共有する解決スコープ。`EventRecorder`が採番する。 */
export type ResolutionScopeId = Brand<string, "ResolutionScopeId">;
export function createResolutionScopeId(
  value: string,
  path = "resolutionScopeId",
): ResolutionScopeId {
  requireNonEmpty("ResolutionScopeId", path, value);
  return value as ResolutionScopeId;
}
