import { beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/api.ts";
import { createApiKey } from "../src/auth.ts";
import { handleMcp } from "../src/worker.ts";
import { createFixture, NOW, type Fixture } from "./helpers.ts";

let f: Fixture;
let key: { id: string; key: string };

beforeEach(async () => {
  f = await createFixture();
  key = await createApiKey(f.db, { tenantId: f.tenantId, scope: "read", label: "limited" });
});

const setLimits = (perMinute: number, daily: number | null, id = key.id) =>
  f.db.query(`UPDATE api_keys SET rate_limit_per_minute = $2, daily_limit = $3 WHERE id = $1`, [id, perMinute, daily]);

/** REST call at a given instant. NOW is 12:00:00 UTC, on a minute boundary. */
const rest = (at: Date, rawKey = key.key) =>
  createApi({ db: f.db, now: () => at }).request("/api/services", { headers: { Authorization: `Bearer ${rawKey}` } });

const plus = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the per-minute limit is used, then resets next minute", async () => {
    await setLimits(2, null);
    expect((await rest(NOW)).status).toBe(200);
    expect((await rest(plus(10))).status).toBe(200);

    const limited = await rest(plus(20));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("40");
    expect(await limited.json()).toEqual({ error: { code: "rate_limited", message: expect.stringMatching(/Too many/) } });

    expect((await rest(plus(60))).status).toBe(200);
  });

  it("enforces the daily cap across minutes until 00:00 UTC", async () => {
    await setLimits(100, 2);
    expect((await rest(NOW)).status).toBe(200);
    expect((await rest(plus(120))).status).toBe(200);

    const limited = await rest(plus(240));
    expect(limited.status).toBe(429);
    // 12:04 UTC to midnight is 11h56m.
    expect(limited.headers.get("Retry-After")).toBe(String(11 * 3600 + 56 * 60));
    expect(((await limited.json()) as { error: { message: string } }).error.message).toMatch(/00:00 UTC/);

    expect((await rest(plus(12 * 3600))).status).toBe(200);
  });

  it("counts each key separately", async () => {
    const other = await createApiKey(f.db, { tenantId: f.tenantId, scope: "read", label: "other" });
    await setLimits(1, null);
    expect((await rest(NOW)).status).toBe(200);
    expect((await rest(NOW)).status).toBe(429);
    expect((await rest(NOW, other.key)).status).toBe(200);
  });

  it("applies to the MCP endpoint before any MCP handling", async () => {
    await setLimits(1, null);
    const post = () =>
      handleMcp(
        new Request("http://booking.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${key.key}` } }),
        f.db,
        () => NOW,
      );
    expect((await post()).status).not.toBe(429);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });

  it("does not count requests with an invalid key", async () => {
    await setLimits(1, null);
    expect((await rest(NOW, "bk_not-a-real-key")).status).toBe(401);
    expect((await rest(NOW)).status).toBe(200);
  });
});
