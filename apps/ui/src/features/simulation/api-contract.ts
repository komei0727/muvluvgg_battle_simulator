// Mirrors docs/ddd/10_API設計.md and docs/ui-design/03_API・データ連携設計.md §2, §7, §8, §13.
// The UI keeps its own type mirror rather than importing apps/api types: HTTP wire
// contracts are the source of truth, not the server's internal TypeScript types.

export interface CatalogAvailability {
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly string[];
}

export interface CatalogUnitSummary extends CatalogAvailability {
  readonly unitDefinitionId: string;
  readonly displayName: string;
  readonly characterName: string;
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
}

export interface CatalogMemorySummary extends CatalogAvailability {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
}

export interface BattleSimulationCatalogResponse {
  readonly schemaVersion: 1;
  readonly catalogRevision: string;
  readonly units: readonly CatalogUnitSummary[];
  readonly memories: readonly CatalogMemorySummary[];
}

export interface ViolationResponseBody {
  readonly path?: string;
  readonly definitionId?: string;
  readonly ruleId?: string;
  readonly message: string;
}

export interface ErrorResponseBody {
  readonly schemaVersion: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly violations: readonly ViolationResponseBody[];
    readonly diagnosticId?: string;
  };
}

export type UiApiErrorKind =
  | "VALIDATION"
  | "UNSUPPORTED_DEFINITION"
  | "RATE_LIMIT"
  | "CAPACITY"
  | "TIMEOUT"
  | "CANCELLED"
  | "SERVER"
  | "NETWORK"
  | "CORS_OR_NETWORK"
  | "RESPONSE_CONTRACT_MISMATCH";

export interface UiApiError {
  readonly kind: UiApiErrorKind;
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly diagnosticId?: string;
  readonly violations?: readonly ViolationResponseBody[];
  readonly retryAfterSeconds?: number;
}

export type CatalogApiResult =
  | {
      readonly ok: true;
      readonly response: BattleSimulationCatalogResponse;
      readonly etag?: string;
      readonly requestId?: string;
    }
  | {
      readonly ok: true;
      readonly notModified: true;
      readonly etag: string;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly error: UiApiError;
      readonly requestId?: string;
    };
