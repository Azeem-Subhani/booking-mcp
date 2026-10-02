import type { Db } from "../db.ts";
import { DomainError } from "./errors.ts";
import { iso } from "./sql.ts";

export interface Service {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  resourceId: string;
}

export interface Slot {
  start: string;
  end: string;
}

/** Slots start on this grid inside each opening window. */
export const SLOT_STEP_MINUTES = 30;
/** Caps how much work one availability request can ask the database for. */
export const MAX_AVAILABILITY_DAYS = 14;

const SERVICE_COLUMNS = `
  s.id, s.name, s.description,
  s.duration_minutes AS "durationMinutes",
  s.price_cents      AS "priceCents",
  s.currency,
  s.resource_id      AS "resourceId"`;

export async function listServices(db: Db, tenantId: string): Promise<Service[]> {
  return db.query<Service>(
    `SELECT ${SERVICE_COLUMNS} FROM services s WHERE s.tenant_id = $1 AND s.active ORDER BY s.name`,
    [tenantId],
  );
}

export async function getService(db: Db, tenantId: string, serviceId: string): Promise<Service> {
  const [service] = await db.query<Service>(
    `SELECT ${SERVICE_COLUMNS} FROM services s WHERE s.tenant_id = $1 AND s.id = $2 AND s.active`,
    [tenantId, serviceId],
  );
  if (!service) throw new DomainError("not_found", "Service not found.");
  return service;
}

/**
 * Free slots for a service between two local dates (inclusive, in the tenant's time zone).
 * A slot is free when it is in the future, inside opening hours, and overlaps no confirmed
 * booking or unexpired hold on the same resource.
 */
export async function searchAvailability(
  db: Db,
  tenantId: string,
  input: { serviceId: string; from: string; to: string },
  now: Date,
): Promise<Slot[]> {
  const days = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) {
    throw new DomainError("invalid_input", "`to` must be on or after `from` (YYYY-MM-DD).");
  }
  if (days >= MAX_AVAILABILITY_DAYS) {
    throw new DomainError("invalid_input", `Search at most ${MAX_AVAILABILITY_DAYS} days at a time.`);
  }
  await getService(db, tenantId, input.serviceId);

  return db.query<Slot>(
    `WITH svc AS (
       SELECT s.resource_id, s.duration_minutes, t.time_zone
       FROM services s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.tenant_id = $1 AND s.id = $2
     ),
     windows AS (
       SELECT svc.resource_id, svc.duration_minutes,
              (d.day + oh.opens)  AT TIME ZONE svc.time_zone AS w_start,
              (d.day + oh.closes) AT TIME ZONE svc.time_zone AS w_end
       FROM svc
       CROSS JOIN LATERAL (
         -- Plain timestamps (no time zone) so the session TimeZone can't shift the dates.
         SELECT g::date AS day
         FROM generate_series($3::date::timestamp, $4::date::timestamp, interval '1 day') g
       ) d
       JOIN opening_hours oh
         ON oh.resource_id = svc.resource_id AND oh.weekday = extract(dow FROM d.day)
     ),
     slots AS (
       SELECT w.resource_id,
              gs AS slot_start,
              gs + make_interval(mins => w.duration_minutes) AS slot_end
       FROM windows w,
       LATERAL generate_series(
         w.w_start,
         w.w_end - make_interval(mins => w.duration_minutes),
         make_interval(mins => $6)
       ) gs
     )
     SELECT ${iso("s.slot_start")} AS "start", ${iso("s.slot_end")} AS "end"
     FROM slots s
     WHERE s.slot_start > $5::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.resource_id = s.resource_id
           AND b.period && tstzrange(s.slot_start, s.slot_end)
           AND (b.status = 'confirmed' OR (b.status = 'held' AND b.hold_expires_at > $5::timestamptz))
       )
     ORDER BY s.slot_start`,
    [tenantId, input.serviceId, input.from, input.to, now.toISOString(), SLOT_STEP_MINUTES],
  );
}
