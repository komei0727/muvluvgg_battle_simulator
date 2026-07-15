/**
 * Raised when data crossing the DTO/Domain boundary (Catalog definitions,
 * branded IDs) violates a Domain invariant. `path` locates the offending
 * field using dot/bracket notation relative to the DTO root being converted.
 */
export class DomainValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "DomainValidationError";
    this.path = path;
  }
}
