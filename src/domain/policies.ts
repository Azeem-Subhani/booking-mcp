import type { Db } from "../db.ts";
import { HOLD_MINUTES } from "./bookings.ts";
import { SLOT_STEP_MINUTES } from "./catalog.ts";
import { DomainError } from "./errors.ts";

export interface Policies {
  business: string;
  timeZone: string;
  holdMinutes: number;
  cancellationNoticeHours: number;
  slotStepMinutes: number;
}

/** The rules an assistant needs to quote to customers instead of guessing. */
export async function getPolicies(db: Db, tenantId: string): Promise<Policies> {
  const [tenant] = await db.query<{ name: string; timeZone: string; noticeHours: number }>(
    `SELECT name, time_zone AS "timeZone", cancellation_notice_hours AS "noticeHours" FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!tenant) throw new DomainError("not_found", "Tenant not found.");
  return {
    business: tenant.name,
    timeZone: tenant.timeZone,
    holdMinutes: HOLD_MINUTES,
    cancellationNoticeHours: tenant.noticeHours,
    slotStepMinutes: SLOT_STEP_MINUTES,
  };
}
