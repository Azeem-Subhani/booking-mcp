import { beforeEach, describe, expect, it } from "vitest";

import { holdSlot, confirmBooking } from "../src/domain/bookings";
import { listServices, searchAvailability } from "../src/domain/catalog";
import { createFixture, customer, minutesAfter, NOW, type Fixture } from "./helpers";

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

const starts = (slots: { start: string }[]) => slots.map((slot) => slot.start);

describe("listServices", () => {
  it("returns only the tenant's own services", async () => {
    expect(await listServices(f.db, f.tenantId)).toHaveLength(1);
    expect(await listServices(f.db, f.otherTenantId)).toHaveLength(0);
  });
});

describe("searchAvailability", () => {
  it("lists 60-minute slots on a 30-minute grid inside opening hours (EST, before DST)", async () => {
    // Friday 2026-03-06, New York is UTC-5. 09:00–12:00 local = 14:00–17:00Z.
    const slots = await searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-06", to: "2026-03-06" }, NOW);
    expect(starts(slots)).toEqual([
      "2026-03-06T14:00:00Z",
      "2026-03-06T14:30:00Z",
      "2026-03-06T15:00:00Z",
      "2026-03-06T15:30:00Z",
      "2026-03-06T16:00:00Z",
    ]);
    expect(slots[0]?.end).toBe("2026-03-06T15:00:00Z");
  });

  it("shifts UTC times by an hour after clocks spring forward", async () => {
    // Monday 2026-03-09, New York is UTC-4. 09:00 local = 13:00Z.
    const slots = await searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-09", to: "2026-03-09" }, NOW);
    expect(starts(slots)[0]).toBe("2026-03-09T13:00:00Z");
    expect(starts(slots).at(-1)).toBe("2026-03-09T15:00:00Z");
  });

  it("returns nothing on closed days", async () => {
    const weekend = await searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-07", to: "2026-03-08" }, NOW);
    expect(weekend).toEqual([]);
  });

  it("hides slots that have already started", async () => {
    const now = new Date("2026-03-06T15:10:00Z");
    const slots = await searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-06", to: "2026-03-06" }, now);
    expect(starts(slots)).toEqual(["2026-03-06T15:30:00Z", "2026-03-06T16:00:00Z"]);
  });

  it("hides slots overlapping a confirmed booking or a live hold", async () => {
    const held = await holdSlot(f.db, f.tenantId, { serviceId: f.serviceId, start: "2026-03-06T14:00:00Z", ...customer() }, NOW);
    await confirmBooking(f.db, f.tenantId, held.id, NOW);
    await holdSlot(f.db, f.tenantId, { serviceId: f.serviceId, start: "2026-03-06T16:00:00Z", ...customer() }, NOW);

    const slots = await searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-06", to: "2026-03-06" }, NOW);
    // 14:00 and 14:30 overlap the confirmed 14:00–15:00; 15:30 and 16:00 overlap the 16:00–17:00 hold.
    expect(starts(slots)).toEqual(["2026-03-06T15:00:00Z"]);
  });

  it("shows a slot again once its hold has expired", async () => {
    await holdSlot(f.db, f.tenantId, { serviceId: f.serviceId, start: "2026-03-06T14:00:00Z", ...customer() }, NOW);
    const later = minutesAfter(NOW, 11);
    const slots = await searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-06", to: "2026-03-06" }, later);
    expect(starts(slots)).toContain("2026-03-06T14:00:00Z");
  });

  it("rejects reversed or oversized ranges", async () => {
    await expect(
      searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-06", to: "2026-03-05" }, NOW),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      searchAvailability(f.db, f.tenantId, { serviceId: f.serviceId, from: "2026-03-01", to: "2026-03-15" }, NOW),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("treats another tenant's service as not found", async () => {
    await expect(
      searchAvailability(f.db, f.otherTenantId, { serviceId: f.serviceId, from: "2026-03-06", to: "2026-03-06" }, NOW),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
