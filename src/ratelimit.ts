import { hashApiKey, KEY_PREFIX, type Principal } from "./auth.ts";
import type { Db } from "./db.ts";

export type RateLimitResult = { ok: true } | { ok: false; window: "minute" | "day"; retryAfterSeconds: number };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Authenticates a raw API key and counts the request against its minute and day windows, in one
 * statement (one Neon round trip per request instead of two). Returns null for an unknown or
 * revoked key, and nothing is counted then.
 *
 * Increment-then-compare in a single statement, so concurrent requests can't both slip under the
 * limit. Rejected requests still count, which is fine for a fixed window. Windows are UTC, so the
 * daily cap resets at 00:00 UTC.
 */
export async function authorizeRequest(
  db: Db,
  rawKey: string,
  now: Date,
): Promise<{ principal: Principal; limit: RateLimitResult } | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const t = now.getTime();
  const minuteStart = t - (t % MINUTE_MS);
  const dayStart = t - (t % DAY_MS);

  const [row] = await db.query<
    Principal & { minute_count: number; day_count: number; per_minute: number; daily: number | null }
  >(
    `WITH k AS (
       SELECT id, tenant_id, scope, rate_limit_per_minute, daily_limit
       FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL
     ),
     hits AS (
       INSERT INTO api_key_usage (key_id, kind, window_start, count)
       SELECT k.id, w.kind, w.start, 1
       FROM k CROSS JOIN (VALUES ('minute', $2::timestamptz), ('day', $3::timestamptz)) AS w (kind, start)
       ON CONFLICT (key_id, kind, window_start) DO UPDATE SET count = api_key_usage.count + 1
       RETURNING kind, count
     )
     SELECT k.id AS "keyId", k.tenant_id AS "tenantId", k.scope,
            k.rate_limit_per_minute AS per_minute, k.daily_limit AS daily,
            (SELECT count FROM hits WHERE kind = 'minute') AS minute_count,
            (SELECT count FROM hits WHERE kind = 'day') AS day_count
     FROM k`,
    [await hashApiKey(rawKey), new Date(minuteStart).toISOString(), new Date(dayStart).toISOString()],
  );
  if (!row) return null;

  const principal: Principal = { keyId: row.keyId, tenantId: row.tenantId, scope: row.scope };
  const secondsUntil = (ms: number) => Math.max(1, Math.ceil((ms - t) / 1000));
  if (row.daily !== null && row.day_count > row.daily) {
    return { principal, limit: { ok: false, window: "day", retryAfterSeconds: secondsUntil(dayStart + DAY_MS) } };
  }
  if (row.minute_count > row.per_minute) {
    return { principal, limit: { ok: false, window: "minute", retryAfterSeconds: secondsUntil(minuteStart + MINUTE_MS) } };
  }
  return { principal, limit: { ok: true } };
}

/** The 429 both REST and MCP return, in the shared error shape. */
export function rateLimitedResponse(result: Extract<RateLimitResult, { ok: false }>): Response {
  const message =
    result.window === "day"
      ? "Daily request limit reached for this API key. It resets at 00:00 UTC."
      : "Too many requests for this API key. Slow down and retry shortly.";
  return Response.json(
    { error: { code: "rate_limited", message } },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}
