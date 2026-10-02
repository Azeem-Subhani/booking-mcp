import type { Db } from "./db.ts";
import { DEMO_TENANT_SLUG } from "./seed.ts";

const DAY_MS = 86_400_000;
const AUDIT_RETENTION_DAYS = 30;

/**
 * Nightly sandbox reset: deletes every booking in the demo tenant, prunes rate-limit counters
 * older than yesterday (UTC) so today's windows keep counting, and drops audit rows past the
 * retention window. Seed data (services, hours, keys) is never modified by the API, so it's left
 * alone. One statement, so it's atomic.
 */
export async function resetSandbox(
  db: Db,
  now: Date,
): Promise<{ bookings: number; usageRows: number; auditRows: number }> {
  const t = now.getTime();
  const yesterdayStart = new Date(t - (t % DAY_MS) - DAY_MS).toISOString();
  const auditCutoff = new Date(t - AUDIT_RETENTION_DAYS * DAY_MS).toISOString();
  const [row] = await db.query<{ bookings: number; usage_rows: number; audit_rows: number }>(
    `WITH b AS (
       DELETE FROM bookings WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1) RETURNING 1
     ),
     u AS (
       DELETE FROM api_key_usage WHERE window_start < $2 RETURNING 1
     ),
     a AS (
       DELETE FROM audit_log WHERE created_at < $3 RETURNING 1
     )
     SELECT (SELECT count(*) FROM b)::int AS bookings,
            (SELECT count(*) FROM u)::int AS usage_rows,
            (SELECT count(*) FROM a)::int AS audit_rows`,
    [DEMO_TENANT_SLUG, yesterdayStart, auditCutoff],
  );
  return { bookings: row?.bookings ?? 0, usageRows: row?.usage_rows ?? 0, auditRows: row?.audit_rows ?? 0 };
}
