import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

import initSql from "../db/migrations/0001_init.sql?raw";
import type { Db } from "../src/db";

export interface Fixture {
  db: Db;
  tenantId: string;
  otherTenantId: string;
  serviceId: string;
  resourceId: string;
}

/**
 * Fresh in-memory Postgres per test file, with two tenants so isolation can be checked.
 * Northside Studio is in America/New_York, so March 2026 tests cross the DST change
 * (clocks spring forward on Sunday 2026-03-08).
 */
export async function createFixture(): Promise<Fixture> {
  const pg = await PGlite.create({ extensions: { btree_gist } });
  // Neon sessions default to UTC. PGlite's default differs, so pin it to match production.
  await pg.exec(`SET TIME ZONE 'UTC';`);
  await pg.exec(initSql);
  const db: Db = { query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows };

  const [tenant] = await db.query<{ id: string }>(
    `INSERT INTO tenants (slug, name, time_zone, cancellation_notice_hours)
     VALUES ('northside', 'Northside Studio', 'America/New_York', 24) RETURNING id`,
  );
  const [other] = await db.query<{ id: string }>(
    `INSERT INTO tenants (slug, name, time_zone) VALUES ('elsewhere', 'Elsewhere Gym', 'Europe/London') RETURNING id`,
  );
  const [resource] = await db.query<{ id: string }>(
    `INSERT INTO resources (tenant_id, name, kind) VALUES ($1, 'Maya (instructor)', 'instructor') RETURNING id`,
    [tenant!.id],
  );
  const [service] = await db.query<{ id: string }>(
    `INSERT INTO services (tenant_id, resource_id, name, duration_minutes, price_cents)
     VALUES ($1, $2, 'Private yoga', 60, 7500) RETURNING id`,
    [tenant!.id, resource!.id],
  );
  // Mon–Fri 09:00–12:00 local time.
  await db.query(
    `INSERT INTO opening_hours (resource_id, weekday, opens, closes)
     SELECT $1, d, '09:00', '12:00' FROM generate_series(1, 5) d`,
    [resource!.id],
  );

  return { db, tenantId: tenant!.id, otherTenantId: other!.id, serviceId: service!.id, resourceId: resource!.id };
}

/** Monday 2026-03-02, 07:00 in New York. */
export const NOW = new Date("2026-03-02T12:00:00Z");

export const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

let keyCounter = 0;
export const customer = (overrides: Partial<{ customerName: string; customerEmail: string }> = {}) => ({
  customerName: "Sam Rivera",
  customerEmail: "sam@example.com",
  idempotencyKey: `test-key-${++keyCounter}`,
  ...overrides,
});
