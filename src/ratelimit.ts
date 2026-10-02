import type { Db } from "./db.ts";

export type RateLimitResult = { ok: true } | { ok: false; window: "minute" | "day"; retryAfterSeconds: number };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Counts one request against the key's minute and day windows and reports whether it's allowed.
 * Increment-then-compare in a single statement, so concurrent requests can't both slip under the
 * limit. Rejected requests still count, which is fine for a fixed window. Windows are UTC, so the
 * daily cap resets at 00:00 UTC.
 */
export async function checkRateLimit(db: Db, keyId: string, now: Date): Promise<RateLimitResult> {
  const t = now.getTime();
  const minuteStart = t - (t % MINUTE_MS);
  const dayStart = t - (t % DAY_MS);

  const [row] = await db.query<{ minute_count: number; day_count: number; per_minute: number; daily: number | null }>(
    `WITH hits AS (
       INSERT INTO api_key_usage (key_id, kind, window_start, count)
       VALUES ($1, 'minute', $2, 1), ($1, 'day', $3, 1)
       ON CONFLICT (key_id, kind, window_start) DO UPDATE SET count = api_key_usage.count + 1
       RETURNING kind, count
     )
     SELECT (SELECT count FROM hits WHERE kind = 'minute') AS minute_count,
            (SELECT count FROM hits WHERE kind = 'day') AS day_count,
            k.rate_limit_per_minute AS per_minute,
            k.daily_limit AS daily
     FROM api_keys k WHERE k.id = $1`,
    [keyId, new Date(minuteStart).toISOString(), new Date(dayStart).toISOString()],
  );
  if (!row) throw new Error("Rate limit check found no API key.");

  const secondsUntil = (ms: number) => Math.max(1, Math.ceil((ms - t) / 1000));
  if (row.daily !== null && row.day_count > row.daily) {
    return { ok: false, window: "day", retryAfterSeconds: secondsUntil(dayStart + DAY_MS) };
  }
  if (row.minute_count > row.per_minute) {
    return { ok: false, window: "minute", retryAfterSeconds: secondsUntil(minuteStart + MINUTE_MS) };
  }
  return { ok: true };
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
