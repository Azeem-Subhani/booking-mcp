import { describe, expect, it } from "vitest";

import seedSql from "../db/seed.sql?raw";
import { applyMigrations } from "../src/migrate.ts";
import { seedDemoTenant } from "../src/seed.ts";
import { freshDatabase, MIGRATIONS } from "./helpers.ts";

describe("demo seed", () => {
  it("loads the demo tenant once and is a no-op on re-run", async () => {
    const { db, conn } = await freshDatabase();
    await applyMigrations(conn, MIGRATIONS);

    const first = await seedDemoTenant(db, seedSql);
    expect(first.created).toBe(true);
    const second = await seedDemoTenant(db, seedSql);
    expect(second).toEqual({ tenantId: first.tenantId, created: false });

    const [counts] = await db.query<{ tenants: number; resources: number; services: number; hours: number }>(
      `SELECT (SELECT count(*)::int FROM tenants) AS tenants,
              (SELECT count(*)::int FROM resources) AS resources,
              (SELECT count(*)::int FROM services) AS services,
              (SELECT count(*)::int FROM opening_hours) AS hours`,
    );
    // Maya: Mon–Fri. Dev: Mon–Sat.
    expect(counts).toEqual({ tenants: 1, resources: 2, services: 3, hours: 11 });
  });
});
