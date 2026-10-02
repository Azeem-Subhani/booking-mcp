import { beforeEach, describe, expect, it } from "vitest";

import { createApiKey } from "../src/auth.ts";
import { holdSlot } from "../src/domain/bookings.ts";
import { authorizeRequest } from "../src/ratelimit.ts";
import { resetSandbox } from "../src/reset.ts";
import { createFixture, customer, NOW, type Fixture } from "./helpers.ts";

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

const count = async (sql: string, params: unknown[] = []) =>
  (await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params))[0]!.n;

describe("nightly sandbox reset", () => {
  it("deletes only the demo tenant's bookings", async () => {
    await holdSlot(f.db, f.tenantId, { serviceId: f.serviceId, start: "2026-03-06T14:00:00Z", ...customer() }, NOW);
    // The other tenant needs no catalog for this check; a raw row is enough.
    await f.db.query(
      `INSERT INTO bookings (tenant_id, service_id, resource_id, customer_name, customer_email, period, status, idempotency_key)
       VALUES ($1, $2, $3, 'Kim', 'kim@example.com', tstzrange('2026-03-06T16:00Z', '2026-03-06T17:00Z'), 'confirmed', 'other-1')`,
      [f.otherTenantId, f.serviceId, f.resourceId],
    );

    expect(await resetSandbox(f.db, NOW)).toMatchObject({ bookings: 1 });
    expect(await count(`bookings WHERE tenant_id = $1`, [f.tenantId])).toBe(0);
    expect(await count(`bookings WHERE tenant_id = $1`, [f.otherTenantId])).toBe(1);
  });

  it("prunes rate-limit counters older than yesterday and keeps the rest", async () => {
    const { key } = await createApiKey(f.db, { tenantId: f.tenantId, scope: "read", label: "k" });
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    for (const at of [daysAgo(2), daysAgo(1), NOW]) await authorizeRequest(f.db, key, at);
    // Each request writes a minute row and a day row.
    expect(await count(`api_key_usage`)).toBe(6);

    expect(await resetSandbox(f.db, NOW)).toMatchObject({ usageRows: 2 });
    // NOW is 2026-03-02T12:00Z, so yesterday starts at 2026-03-01T00:00Z.
    expect(await count(`api_key_usage WHERE window_start < $1`, ["2026-03-01T00:00:00Z"])).toBe(0);
    expect(await count(`api_key_usage`)).toBe(4);
  });

  it("drops audit rows older than 30 days", async () => {
    const { id } = await createApiKey(f.db, { tenantId: f.tenantId, scope: "read", label: "k" });
    for (const days of [31, 29]) {
      await f.db.query(
        `INSERT INTO audit_log (tenant_id, key_id, tool, inputs, result_code, duration_ms, created_at)
         VALUES ($1, $2, 'list_services', '{}', 'ok', 1, $3)`,
        [f.tenantId, id, new Date(NOW.getTime() - days * 86_400_000).toISOString()],
      );
    }
    expect(await resetSandbox(f.db, NOW)).toMatchObject({ auditRows: 1 });
    expect(await count(`audit_log`)).toBe(1);
  });
});
