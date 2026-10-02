import { PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode, type Db } from "../db.ts";
import { getService } from "./catalog.ts";
import { DomainError } from "./errors.ts";
import { BOOKING_COLUMNS, fitsOpeningHours } from "./sql.ts";

export type BookingStatus = "held" | "confirmed" | "cancelled" | "expired";

export interface Booking {
  id: string;
  serviceId: string;
  resourceId: string;
  customerName: string;
  customerEmail: string;
  start: string;
  end: string;
  status: BookingStatus;
  holdExpiresAt: string | null;
}

/** How long a hold reserves a slot before it must be confirmed. */
export const HOLD_MINUTES = 10;

export async function getBooking(db: Db, tenantId: string, bookingId: string): Promise<Booking> {
  const [booking] = await db.query<Booking>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b WHERE b.tenant_id = $1 AND b.id = $2`,
    [tenantId, bookingId],
  );
  if (!booking) throw new DomainError("not_found", "Booking not found.");
  return booking;
}

export async function findBookingsByEmail(db: Db, tenantId: string, email: string): Promise<Booking[]> {
  return db.query<Booking>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b
     WHERE b.tenant_id = $1 AND lower(b.customer_email) = lower($2)
     ORDER BY lower(b.period) DESC
     LIMIT 20`,
    [tenantId, email],
  );
}

/** Flip stale holds to 'expired' so the overlap constraint stops counting them. */
async function expireStaleHolds(db: Db, resourceId: string, now: Date) {
  await db.query(
    `UPDATE bookings SET status = 'expired', updated_at = $2
     WHERE resource_id = $1 AND status = 'held' AND hold_expires_at <= $2`,
    [resourceId, now.toISOString()],
  );
}

/**
 * Step one of booking: reserve a slot for HOLD_MINUTES. Retrying with the same
 * idempotency key returns the original hold instead of creating a second one.
 */
export async function holdSlot(
  db: Db,
  tenantId: string,
  input: { serviceId: string; start: string; customerName: string; customerEmail: string; idempotencyKey: string },
  now: Date,
): Promise<Booking> {
  const existing = await findByIdempotencyKey(db, tenantId, input.idempotencyKey);
  if (existing) return assertSameRequest(existing, input);

  const service = await getService(db, tenantId, input.serviceId);
  await expireStaleHolds(db, service.resourceId, now);

  try {
    const [booking] = await db.query<Booking>(
      `INSERT INTO bookings AS b (tenant_id, service_id, resource_id, customer_name, customer_email,
                                  period, status, hold_expires_at, idempotency_key, created_at, updated_at)
       SELECT s.tenant_id, s.id, s.resource_id, $3, $4,
              tstzrange($5::timestamptz, $5::timestamptz + make_interval(mins => s.duration_minutes)),
              'held', $6::timestamptz + make_interval(mins => $8), $7, $6, $6
       FROM services s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.tenant_id = $1 AND s.id = $2
         AND $5::timestamptz > $6::timestamptz
         AND ${fitsOpeningHours({ start: "$5::timestamptz", minutes: "s.duration_minutes", resourceId: "s.resource_id", timeZone: "t.time_zone" })}
       RETURNING ${BOOKING_COLUMNS}`,
      [
        tenantId,
        input.serviceId,
        input.customerName,
        input.customerEmail,
        input.start,
        now.toISOString(),
        input.idempotencyKey,
        HOLD_MINUTES,
      ],
    );
    if (!booking) {
      throw new DomainError("slot_unavailable", "That time is in the past or outside opening hours.");
    }
    return booking;
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === PG_EXCLUSION_VIOLATION) {
      throw new DomainError("slot_unavailable", "That time is already booked or held.");
    }
    if (code === PG_UNIQUE_VIOLATION) {
      // A concurrent retry with the same key won the race; return its booking.
      const raced = await findByIdempotencyKey(db, tenantId, input.idempotencyKey);
      if (raced) return assertSameRequest(raced, input);
    }
    throw error;
  }
}

async function findByIdempotencyKey(db: Db, tenantId: string, key: string): Promise<Booking | undefined> {
  const [booking] = await db.query<Booking>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b WHERE b.tenant_id = $1 AND b.idempotency_key = $2`,
    [tenantId, key],
  );
  return booking;
}

function assertSameRequest(booking: Booking, input: { serviceId: string; start: string }): Booking {
  if (booking.serviceId !== input.serviceId || Date.parse(booking.start) !== Date.parse(input.start)) {
    throw new DomainError("invalid_input", "This idempotency key was already used for a different request.");
  }
  return booking;
}

/** Step two: turn an unexpired hold into a confirmed booking. Confirming twice is a no-op. */
export async function confirmBooking(db: Db, tenantId: string, bookingId: string, now: Date): Promise<Booking> {
  const [confirmed] = await db.query<Booking>(
    `UPDATE bookings AS b SET status = 'confirmed', hold_expires_at = NULL, updated_at = $3
     WHERE b.tenant_id = $1 AND b.id = $2 AND b.status = 'held' AND b.hold_expires_at > $3
     RETURNING ${BOOKING_COLUMNS}`,
    [tenantId, bookingId, now.toISOString()],
  );
  if (confirmed) return confirmed;

  const booking = await getBooking(db, tenantId, bookingId);
  if (booking.status === "confirmed") return booking;
  if (booking.status === "held" || booking.status === "expired") {
    throw new DomainError("hold_expired", "The hold expired. Search availability and hold the slot again.");
  }
  throw new DomainError("invalid_state", "A cancelled booking can't be confirmed.");
}

/**
 * Holds can always be released. Confirmed bookings follow the tenant's notice policy.
 * Cancelling twice is a no-op.
 */
export async function cancelBooking(db: Db, tenantId: string, bookingId: string, now: Date): Promise<Booking> {
  const [cancelled] = await db.query<Booking>(
    `UPDATE bookings AS b SET status = 'cancelled', hold_expires_at = NULL, updated_at = $3
     FROM tenants t
     WHERE t.id = b.tenant_id AND b.tenant_id = $1 AND b.id = $2
       AND (b.status = 'held'
            OR (b.status = 'confirmed'
                AND lower(b.period) - $3::timestamptz >= make_interval(hours => t.cancellation_notice_hours)))
     RETURNING ${BOOKING_COLUMNS}`,
    [tenantId, bookingId, now.toISOString()],
  );
  if (cancelled) return cancelled;

  const booking = await getBooking(db, tenantId, bookingId);
  if (booking.status === "cancelled") return booking;
  if (booking.status === "expired") throw new DomainError("invalid_state", "This hold already expired.");
  throw new DomainError("policy_violation", await noticeMessage(db, tenantId, "cancelled"));
}

/** Move a confirmed booking to a new start time, subject to the same notice policy. */
export async function rescheduleBooking(
  db: Db,
  tenantId: string,
  input: { bookingId: string; start: string },
  now: Date,
): Promise<Booking> {
  const current = await getBooking(db, tenantId, input.bookingId);
  if (current.status !== "confirmed") {
    throw new DomainError("invalid_state", "Only confirmed bookings can be rescheduled.");
  }
  await expireStaleHolds(db, current.resourceId, now);

  let rescheduled: Booking | undefined;
  try {
    [rescheduled] = await db.query<Booking>(
      `UPDATE bookings AS b
       SET period = tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => s.duration_minutes)),
           updated_at = $4
       FROM services s, tenants t
       WHERE s.id = b.service_id AND t.id = b.tenant_id
         AND b.tenant_id = $1 AND b.id = $2 AND b.status = 'confirmed'
         AND lower(b.period) - $4::timestamptz >= make_interval(hours => t.cancellation_notice_hours)
         AND $3::timestamptz > $4::timestamptz
         AND ${fitsOpeningHours({ start: "$3::timestamptz", minutes: "s.duration_minutes", resourceId: "b.resource_id", timeZone: "t.time_zone" })}
       RETURNING ${BOOKING_COLUMNS}`,
      [tenantId, input.bookingId, input.start, now.toISOString()],
    );
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) {
      throw new DomainError("slot_unavailable", "The new time is already booked or held.");
    }
    throw error;
  }
  if (rescheduled) return rescheduled;

  const [tooLate] = await db.query<{ tooLate: boolean }>(
    `SELECT lower(b.period) - $3::timestamptz < make_interval(hours => t.cancellation_notice_hours) AS "tooLate"
     FROM bookings b JOIN tenants t ON t.id = b.tenant_id
     WHERE b.tenant_id = $1 AND b.id = $2`,
    [tenantId, input.bookingId, now.toISOString()],
  );
  if (tooLate?.tooLate) throw new DomainError("policy_violation", await noticeMessage(db, tenantId, "rescheduled"));
  throw new DomainError("slot_unavailable", "The new time is in the past or outside opening hours.");
}

async function noticeMessage(db: Db, tenantId: string, verb: string): Promise<string> {
  const [tenant] = await db.query<{ hours: number }>(
    `SELECT cancellation_notice_hours AS hours FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return `Confirmed bookings can't be ${verb} less than ${tenant?.hours ?? 0} hours before they start.`;
}
