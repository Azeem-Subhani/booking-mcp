import { beforeEach, describe, expect, it } from "vitest";

import {
  cancelBooking,
  confirmBooking,
  findBookingsByEmail,
  getBooking,
  HOLD_MINUTES,
  holdSlot,
  rescheduleBooking,
} from "../src/domain/bookings";
import { createFixture, customer, minutesAfter, NOW, type Fixture } from "./helpers";

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

const FRI_9AM = "2026-03-06T14:00:00Z"; // 09:00 New York (EST)
const hold = (start: string, extra = customer(), now = NOW) =>
  holdSlot(f.db, f.tenantId, { serviceId: f.serviceId, start, ...extra }, now);

describe("holdSlot", () => {
  it("creates a hold that expires after HOLD_MINUTES", async () => {
    const booking = await hold(FRI_9AM);
    expect(booking).toMatchObject({
      status: "held",
      start: FRI_9AM,
      end: "2026-03-06T15:00:00Z",
      holdExpiresAt: minutesAfter(NOW, HOLD_MINUTES).toISOString().replace(".000", ""),
    });
  });

  it("rejects an overlapping hold on the same resource", async () => {
    await hold(FRI_9AM);
    await expect(hold("2026-03-06T14:30:00Z")).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("allows back-to-back bookings", async () => {
    await hold(FRI_9AM);
    await expect(hold("2026-03-06T15:00:00Z")).resolves.toMatchObject({ status: "held" });
  });

  it("returns the same hold when retried with the same idempotency key", async () => {
    const request = customer();
    const first = await hold(FRI_9AM, request);
    const retry = await hold(FRI_9AM, request);
    expect(retry.id).toBe(first.id);
  });

  it("rejects an idempotency key reused for a different time", async () => {
    const request = customer();
    await hold(FRI_9AM, request);
    await expect(hold("2026-03-06T15:00:00Z", request)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects times outside opening hours, on closed days, or in the past", async () => {
    await expect(hold("2026-03-06T16:30:00Z")).rejects.toMatchObject({ code: "slot_unavailable" }); // ends 12:30 local
    await expect(hold("2026-03-07T15:00:00Z")).rejects.toMatchObject({ code: "slot_unavailable" }); // Saturday
    await expect(hold("2026-03-02T11:00:00Z")).rejects.toMatchObject({ code: "slot_unavailable" }); // before NOW
  });

  it("lets a new customer take a slot once the earlier hold has expired", async () => {
    const stale = await hold(FRI_9AM);
    const fresh = await hold(FRI_9AM, customer({ customerEmail: "kai@example.com" }), minutesAfter(NOW, HOLD_MINUTES + 1));
    expect(fresh.id).not.toBe(stale.id);
    expect((await getBooking(f.db, f.tenantId, stale.id)).status).toBe("expired");
  });

  it("can't book another tenant's service", async () => {
    await expect(
      holdSlot(f.db, f.otherTenantId, { serviceId: f.serviceId, start: FRI_9AM, ...customer() }, NOW),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("confirmBooking", () => {
  it("confirms a live hold and is safe to repeat", async () => {
    const held = await hold(FRI_9AM);
    const confirmed = await confirmBooking(f.db, f.tenantId, held.id, minutesAfter(NOW, 5));
    expect(confirmed).toMatchObject({ status: "confirmed", holdExpiresAt: null });
    await expect(confirmBooking(f.db, f.tenantId, held.id, minutesAfter(NOW, 6))).resolves.toMatchObject({
      status: "confirmed",
    });
  });

  it("refuses a hold that has expired, even before cleanup has run", async () => {
    const held = await hold(FRI_9AM);
    await expect(confirmBooking(f.db, f.tenantId, held.id, minutesAfter(NOW, HOLD_MINUTES))).rejects.toMatchObject({
      code: "hold_expired",
    });
  });

  it("refuses a cancelled booking", async () => {
    const held = await hold(FRI_9AM);
    await cancelBooking(f.db, f.tenantId, held.id, NOW);
    await expect(confirmBooking(f.db, f.tenantId, held.id, NOW)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("hides bookings from other tenants", async () => {
    const held = await hold(FRI_9AM);
    await expect(confirmBooking(f.db, f.otherTenantId, held.id, NOW)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("cancelBooking", () => {
  it("releases a hold at any time", async () => {
    const held = await hold(FRI_9AM);
    await expect(cancelBooking(f.db, f.tenantId, held.id, NOW)).resolves.toMatchObject({ status: "cancelled" });
    await expect(hold(FRI_9AM)).resolves.toMatchObject({ status: "held" });
  });

  it("cancels a confirmed booking with enough notice, and is safe to repeat", async () => {
    const held = await hold(FRI_9AM);
    await confirmBooking(f.db, f.tenantId, held.id, NOW);
    await expect(cancelBooking(f.db, f.tenantId, held.id, NOW)).resolves.toMatchObject({ status: "cancelled" });
    await expect(cancelBooking(f.db, f.tenantId, held.id, NOW)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("enforces the 24-hour notice policy on confirmed bookings", async () => {
    const held = await hold(FRI_9AM);
    await confirmBooking(f.db, f.tenantId, held.id, NOW);
    const lateNotice = new Date("2026-03-05T15:00:00Z"); // 23 hours before start
    await expect(cancelBooking(f.db, f.tenantId, held.id, lateNotice)).rejects.toMatchObject({
      code: "policy_violation",
    });
  });
});

describe("rescheduleBooking", () => {
  const confirmedAt9 = async () => {
    const held = await hold(FRI_9AM);
    return confirmBooking(f.db, f.tenantId, held.id, NOW);
  };

  it("moves a booking to a time that overlaps its own old slot", async () => {
    const booking = await confirmedAt9();
    const moved = await rescheduleBooking(f.db, f.tenantId, { bookingId: booking.id, start: "2026-03-06T14:30:00Z" }, NOW);
    expect(moved).toMatchObject({ id: booking.id, start: "2026-03-06T14:30:00Z", end: "2026-03-06T15:30:00Z" });
  });

  it("rejects a time taken by someone else", async () => {
    const booking = await confirmedAt9();
    await hold("2026-03-06T15:00:00Z", customer({ customerEmail: "kai@example.com" }));
    await expect(
      rescheduleBooking(f.db, f.tenantId, { bookingId: booking.id, start: "2026-03-06T15:30:00Z" }, NOW),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("rejects times outside opening hours", async () => {
    const booking = await confirmedAt9();
    await expect(
      rescheduleBooking(f.db, f.tenantId, { bookingId: booking.id, start: "2026-03-07T15:00:00Z" }, NOW),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("enforces the notice policy and only moves confirmed bookings", async () => {
    const booking = await confirmedAt9();
    await expect(
      rescheduleBooking(
        f.db,
        f.tenantId,
        { bookingId: booking.id, start: "2026-03-09T13:00:00Z" },
        new Date("2026-03-06T10:00:00Z"),
      ),
    ).rejects.toMatchObject({ code: "policy_violation" });

    const held = await hold("2026-03-06T16:00:00Z");
    await expect(
      rescheduleBooking(f.db, f.tenantId, { bookingId: held.id, start: "2026-03-09T13:00:00Z" }, NOW),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("findBookingsByEmail", () => {
  it("matches case-insensitively within the tenant", async () => {
    await hold(FRI_9AM, customer({ customerEmail: "Sam@Example.com" }));
    expect(await findBookingsByEmail(f.db, f.tenantId, "sam@example.com")).toHaveLength(1);
    expect(await findBookingsByEmail(f.db, f.otherTenantId, "sam@example.com")).toHaveLength(0);
  });
});
