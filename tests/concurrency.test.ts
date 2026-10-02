// Concurrency guarantees that need two real database sessions, so these run only against Postgres
// (npm run test:postgres, and the test-postgres CI job). PGlite is single-session.
//
// Each test is deterministic rather than a timing race: session A opens a transaction and holds a
// slot without committing; session B then tries the same thing and must wait on A's lock. Once A
// commits, B's outcome shows what the database enforced.
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../src/db.ts";
import { holdSlot } from "../src/domain/bookings.ts";
import { createFixture, customer, NOW, usingServer, type Fixture } from "./helpers.ts";

const FRI_9AM = "2026-03-06T14:00:00Z";

let f: Fixture;
let a: Db;
let b: Db;

beforeEach(async () => {
  if (!usingServer) return;
  f = await createFixture();
  a = await f.connect!();
  b = await f.connect!();
});

/** Resolves once some session is waiting on a lock, so we know B really is blocked behind A. */
async function untilSomeoneWaitsOnALock() {
  for (let i = 0; i < 100; i++) {
    const [row] = await f.db.query<{ waiting: number }>(`SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`);
    if (row!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Session B never blocked on session A's lock.");
}

const hold = (db: Db, extra: Partial<ReturnType<typeof customer>> = {}) =>
  holdSlot(db, f.tenantId, { serviceId: f.serviceId, start: FRI_9AM, ...customer(), ...extra }, NOW);

/**
 * Captures a pending call's outcome immediately. Session B's call can settle as soon as A commits,
 * before the test resumes after `await a.query("COMMIT")`; a rejection with no handler attached yet
 * is reported as unhandled and fails the run.
 */
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe.skipIf(!usingServer)("concurrent sessions (real Postgres)", () => {
  it("lets exactly one of two concurrent holds on the same slot through", async () => {
    await a.query("BEGIN");
    const first = await hold(a, { customerEmail: "first@example.com" });
    expect(first.status).toBe("held");

    // B finds nothing committed, so only the exclusion constraint can stop it.
    const second = settle(hold(b, { customerEmail: "second@example.com" }));
    await untilSomeoneWaitsOnALock();
    await a.query("COMMIT");

    expect(await second).toMatchObject({ ok: false, error: { code: "slot_unavailable" } });
    const rows = await f.db.query<{ customer_email: string }>(
      `SELECT customer_email FROM bookings WHERE status IN ('held', 'confirmed')`,
    );
    expect(rows.map((r) => r.customer_email)).toEqual(["first@example.com"]);
  });

  it("lets the second hold through if the first transaction rolls back", async () => {
    await a.query("BEGIN");
    await hold(a, { customerEmail: "first@example.com" });

    const second = settle(hold(b, { customerEmail: "second@example.com" }));
    await untilSomeoneWaitsOnALock();
    await a.query("ROLLBACK");

    expect(await second).toMatchObject({ ok: true, value: { status: "held", customerEmail: "second@example.com" } });
  });

  it("returns the same hold to a concurrent retry with the same idempotency key", async () => {
    const attempt = customer();
    await a.query("BEGIN");
    const first = await hold(a, attempt);

    // Same key: B blocks on the unique index, then takes the "a concurrent retry won" path.
    const retry = settle(hold(b, attempt));
    await untilSomeoneWaitsOnALock();
    await a.query("COMMIT");

    expect(await retry).toMatchObject({ ok: true, value: { id: first.id } });
    const [row] = await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings`);
    expect(row!.n).toBe(1);
  });
});
