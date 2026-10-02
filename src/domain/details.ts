import type { Db } from "../db.ts";
import type { Booking } from "./bookings.ts";

/** What an assistant needs to read a booking back to a customer without joining or converting. */
export interface BookingDetails {
  serviceName: string;
  priceCents: number;
  currency: string;
  timeZone: string;
  /** Weekday of the local start, e.g. "Tuesday". */
  weekday: string;
  /** Local wall time with its UTC offset, e.g. 2026-10-06T09:00:00-04:00. */
  localStart: string;
  localEnd: string;
  localHoldExpiresAt: string | null;
}

export type BookingWithDetails = Booking & { details: BookingDetails };

/**
 * Adds service name, price, and local times to bookings. Times are converted with the tenant's
 * time zone explicitly (Intl, not the Postgres session TimeZone), so DST is handled for the model.
 */
export async function withDetails(db: Db, tenantId: string, bookings: Booking[]): Promise<BookingWithDetails[]> {
  if (bookings.length === 0) return [];
  // IDs go in as a JSON array so the query is the same on Neon and PGlite, whose array handling differs.
  const rows = await db.query<{ id: string; serviceName: string; priceCents: number; currency: string; timeZone: string }>(
    `SELECT b.id, s.name AS "serviceName", s.price_cents AS "priceCents", s.currency, t.time_zone AS "timeZone"
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN tenants t ON t.id = b.tenant_id
     WHERE b.tenant_id = $1 AND b.id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)`,
    [tenantId, JSON.stringify(bookings.map((booking) => booking.id))],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));

  return bookings.map((booking) => {
    const row = byId.get(booking.id);
    if (!row) throw new Error(`Booking ${booking.id} vanished while adding details`);
    const { timeZone } = row;
    return {
      ...booking,
      details: {
        serviceName: row.serviceName,
        priceCents: row.priceCents,
        currency: row.currency,
        timeZone,
        weekday: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(new Date(booking.start)),
        localStart: toLocalIso(booking.start, timeZone),
        localEnd: toLocalIso(booking.end, timeZone),
        localHoldExpiresAt: booking.holdExpiresAt ? toLocalIso(booking.holdExpiresAt, timeZone) : null,
      },
    };
  });
}

/** Formats a UTC instant as local wall time plus offset in an IANA time zone. */
export function toLocalIso(instant: string, timeZone: string): string {
  const date = new Date(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const wall = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  // The offset is how far the wall clock, read as if it were UTC, sits from the real instant.
  const offsetMinutes = Math.round((Date.parse(`${wall}Z`) - date.getTime()) / 60_000);
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${wall}${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
