import { beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/api";
import { createApiKey } from "../src/auth";
import { createFixture, NOW, type Fixture } from "./helpers";

let f: Fixture;
let api: ReturnType<typeof createApi>;
let readKey: string;
let writeKey: string;

beforeEach(async () => {
  f = await createFixture();
  api = createApi({ db: f.db, now: () => NOW });
  readKey = (await createApiKey(f.db, { tenantId: f.tenantId, scope: "read", label: "test read" })).key;
  writeKey = (await createApiKey(f.db, { tenantId: f.tenantId, scope: "write", label: "test write" })).key;
});

function call(path: string, init: { key?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.key) headers.Authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return api.request(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe("auth", () => {
  it("rejects missing and unknown keys", async () => {
    expect((await call("/services")).status).toBe(401);
    expect((await call("/services", { key: "bk_not-a-real-key" })).status).toBe(401);
  });

  it("rejects revoked keys", async () => {
    await f.db.query(`UPDATE api_keys SET revoked_at = now()`);
    expect((await call("/services", { key: readKey })).status).toBe(401);
  });

  it("stores only a hash of each key", async () => {
    const rows = await f.db.query<{ key_hash: string }>(`SELECT key_hash FROM api_keys`);
    expect(rows.map((row) => row.key_hash)).not.toContain(readKey);
  });

  it("blocks writes with a read-only key", async () => {
    const res = await call("/holds", { key: readKey, method: "POST", body: {}, headers: { "Idempotency-Key": "abcdefgh" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("validation", () => {
  it("requires an Idempotency-Key header on holds", async () => {
    const res = await call("/holds", { key: writeKey, method: "POST", body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("rejects malformed bodies and ids", async () => {
    const badBody = await call("/holds", {
      key: writeKey,
      method: "POST",
      body: { serviceId: f.serviceId, start: "tomorrow", customerName: "Sam", customerEmail: "sam@example.com" },
      headers: { "Idempotency-Key": "abcdefgh" },
    });
    expect(badBody.status).toBe(400);
    expect((await call("/bookings/not-a-uuid", { key: readKey })).status).toBe(400);
  });
});

describe("booking flow over HTTP", () => {
  it("searches, holds, confirms, and cancels", async () => {
    const services = await (await call("/services", { key: readKey })).json();
    expect(services.services[0]).toMatchObject({ name: "Private yoga", durationMinutes: 60, priceCents: 7500 });

    const availability = await (
      await call(`/services/${f.serviceId}/availability?from=2026-03-06&to=2026-03-06`, { key: readKey })
    ).json();
    const start = availability.slots[0].start;

    const holdRes = await call("/holds", {
      key: writeKey,
      method: "POST",
      body: { serviceId: f.serviceId, start, customerName: "Sam Rivera", customerEmail: "sam@example.com" },
      headers: { "Idempotency-Key": "flow-test-0001" },
    });
    expect(holdRes.status).toBe(201);
    const { booking } = await holdRes.json();

    const conflict = await call("/holds", {
      key: writeKey,
      method: "POST",
      body: { serviceId: f.serviceId, start, customerName: "Kai", customerEmail: "kai@example.com" },
      headers: { "Idempotency-Key": "flow-test-0002" },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "slot_unavailable" } });

    const confirmed = await (await call(`/bookings/${booking.id}/confirm`, { key: writeKey, method: "POST" })).json();
    expect(confirmed.booking.status).toBe("confirmed");

    const cancelled = await (await call(`/bookings/${booking.id}/cancel`, { key: writeKey, method: "POST" })).json();
    expect(cancelled.booking.status).toBe("cancelled");
  });

  it("returns 404 for an unknown booking", async () => {
    const res = await call("/bookings/00000000-0000-4000-8000-000000000000", { key: readKey });
    expect(res.status).toBe(404);
  });
});
