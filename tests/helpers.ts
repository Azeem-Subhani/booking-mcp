import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import pg from "pg";

import type { Db } from "../src/db.ts";
import { applyMigrations, type Migration, type MigrationConn } from "../src/migrate.ts";

/** Every file in db/migrations, so new migrations reach the tests without editing this helper. */
export const MIGRATIONS: Migration[] = Object.entries(
  import.meta.glob<string>("../db/migrations/*.sql", { query: "?raw", import: "default", eager: true }),
).map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql }));

/** An empty database (no migrations) plus the two interfaces the code under test needs. */
export interface TestDatabase {
  db: Db;
  conn: MigrationConn;
  /** Another session on the same database, for concurrency tests. Real Postgres only. */
  connect?: () => Promise<Db>;
}

// Set by CI (and optionally locally) to run every test against a real Postgres server instead of
// PGlite. Each test gets its own database, created and dropped through this admin connection.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SERVER_URL = env.TEST_DATABASE_URL;
if (env.npm_lifecycle_event === "test:postgres" && !SERVER_URL) {
  // Without this, a missing variable would silently fall back to PGlite and the run would prove nothing.
  throw new Error("npm run test:postgres needs TEST_DATABASE_URL (a local Postgres server).");
}
if (SERVER_URL && !["localhost", "127.0.0.1"].includes(new URL(SERVER_URL).hostname)) {
  // The helper creates and drops databases, so it must never be pointed at Neon or anything shared.
  throw new Error("TEST_DATABASE_URL must point at localhost.");
}
export const usingServer = Boolean(SERVER_URL);

const cleanups: (() => Promise<void>)[] = [];

/** Closes connections and drops databases created during the test. Run from tests/setup.ts. */
export async function cleanupDatabases(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function freshDatabase(): Promise<TestDatabase> {
  if (!SERVER_URL) {
    const lite = await PGlite.create({ extensions: { btree_gist } });
    // Neon sessions default to UTC. PGlite's default differs, so pin it to match production.
    await lite.exec(`SET TIME ZONE 'UTC';`);
    cleanups.push(() => lite.close());
    return {
      db: { query: async <T>(text: string, params?: unknown[]) => (await lite.query<T>(text, params)).rows },
      conn: {
        exec: async (sql) => void (await lite.exec(sql)),
        query: async <T>(text: string, params?: unknown[]) => (await lite.query<T>(text, params)).rows,
      },
    };
  }

  // Create from the "postgres" maintenance database, never template1, so parallel files don't
  // collide on "template1 is being accessed by other users".
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: SERVER_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  // A non-UTC zone with DST, on purpose: tests passing here proves no SQL relies on the session
  // TimeZone (see CLAUDE.md). PGlite stays on UTC like Neon.
  await admin.query(`ALTER DATABASE ${name} SET timezone TO 'Pacific/Auckland'`);

  const url = new URL(SERVER_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  cleanups.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  // Pushed after the drop above, so cleanup (which runs in reverse) closes these sessions first.
  const connect = async (): Promise<Db> => {
    const extra = new pg.Client({ connectionString: url.toString() });
    await extra.connect();
    cleanups.push(() => extra.end());
    return { query: async <T>(text: string, params?: unknown[]) => (await extra.query<T>(text, params)).rows };
  };
  return {
    connect,
    db: { query: async <T>(text: string, params?: unknown[]) => (await client.query<T>(text, params)).rows },
    conn: {
      exec: async (sql) => void (await client.query(sql)),
      query: async <T>(text: string, params?: unknown[]) => (await client.query<T>(text, params)).rows,
    },
  };
}

export interface Fixture {
  db: Db;
  /** Another session on the same database. Only set on real Postgres. */
  connect?: () => Promise<Db>;
  tenantId: string;
  otherTenantId: string;
  serviceId: string;
  resourceId: string;
}

/**
 * Fresh migrated database per test, with two tenants so isolation can be checked.
 * Northside Studio is in America/New_York, so March 2026 tests cross the DST change
 * (clocks spring forward on Sunday 2026-03-08).
 */
export async function createFixture(): Promise<Fixture> {
  const { db, conn, connect } = await freshDatabase();
  await applyMigrations(conn, MIGRATIONS);

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

  return {
    db,
    ...(connect ? { connect } : {}),
    tenantId: tenant!.id,
    otherTenantId: other!.id,
    serviceId: service!.id,
    resourceId: resource!.id,
  };
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
