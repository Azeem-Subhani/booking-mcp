import { describe, expect, it } from "vitest";

import { toLocalIso } from "../src/domain/details.ts";

describe("toLocalIso", () => {
  it("uses the offset in effect at that instant, across the November DST change", () => {
    // 1:30 AM happens twice in New York on 2026-11-01; the offset tells them apart.
    expect(toLocalIso("2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-01T01:30:00-04:00");
    expect(toLocalIso("2026-11-01T06:30:00Z", "America/New_York")).toBe("2026-11-01T01:30:00-05:00");
  });

  it("handles UTC and half-hour offsets", () => {
    expect(toLocalIso("2026-03-06T14:00:00Z", "UTC")).toBe("2026-03-06T14:00:00+00:00");
    expect(toLocalIso("2026-03-06T14:00:00Z", "Asia/Kolkata")).toBe("2026-03-06T19:30:00+05:30");
  });

  it("rolls the date when the local day differs from the UTC day", () => {
    expect(toLocalIso("2026-03-07T02:00:00Z", "America/New_York")).toBe("2026-03-06T21:00:00-05:00");
  });
});
