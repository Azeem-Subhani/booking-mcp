// Shared SQL fragments. Timestamps leave the database as ISO-8601 UTC strings so results
// look the same on every driver (Neon returns strings, PGlite returns Date objects).

export const iso = (expr: string) => `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export const BOOKING_COLUMNS = `
  b.id,
  b.service_id      AS "serviceId",
  b.resource_id     AS "resourceId",
  b.customer_name   AS "customerName",
  b.customer_email  AS "customerEmail",
  ${iso("lower(b.period)")} AS "start",
  ${iso("upper(b.period)")} AS "end",
  b.status,
  ${iso("b.hold_expires_at")} AS "holdExpiresAt"`;

/**
 * True when [start, start + duration) sits inside one of the resource's opening-hour
 * windows, evaluated in the tenant's local time so DST changes are handled by Postgres.
 */
export function fitsOpeningHours(opts: { start: string; minutes: string; resourceId: string; timeZone: string }) {
  const localStart = `((${opts.start}) AT TIME ZONE ${opts.timeZone})`;
  const localEnd = `((${opts.start}) + make_interval(mins => ${opts.minutes})) AT TIME ZONE ${opts.timeZone}`;
  return `EXISTS (
    SELECT 1 FROM opening_hours oh
    WHERE oh.resource_id = ${opts.resourceId}
      AND oh.weekday = extract(dow FROM ${localStart})
      AND ${localStart}::time >= oh.opens
      AND ${localEnd} <= ${localStart}::date + oh.closes
  )`;
}
