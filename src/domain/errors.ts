export type DomainErrorCode =
  | "not_found"
  | "slot_unavailable"
  | "hold_expired"
  | "invalid_state"
  | "policy_violation"
  | "invalid_input";

/** An expected failure with a stable code that API and MCP layers can map and explain. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
