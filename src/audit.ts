import type { Principal } from "./auth.ts";
import type { Db } from "./db.ts";

/** Customer details are never stored in the audit log; anyone can type a real address into the demo. */
const REDACTED_FIELDS = new Set(["customerName", "customerEmail", "email"]);

export function redactInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, REDACTED_FIELDS.has(k) ? "[redacted]" : v]));
}

export interface AuditEntry {
  tool: string;
  inputs: Record<string, unknown>;
  resultCode: string;
  durationMs: number;
  at: Date;
}

export async function recordToolCall(db: Db, principal: Principal, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (tenant_id, key_id, tool, inputs, result_code, duration_ms, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      principal.tenantId,
      principal.keyId,
      entry.tool,
      JSON.stringify(redactInputs(entry.inputs)),
      entry.resultCode,
      Math.round(entry.durationMs),
      entry.at.toISOString(),
    ],
  );
}
