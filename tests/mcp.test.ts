import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiKey } from "../src/auth.ts";
import type { Db } from "../src/db.ts";
import { handleMcp } from "../src/worker.ts";
import { createFixture, NOW, type Fixture } from "./helpers.ts";

let f: Fixture;
let readKey: string;
let writeKey: string;
const clients: Client[] = [];

beforeEach(async () => {
  f = await createFixture();
  readKey = (await createApiKey(f.db, { tenantId: f.tenantId, scope: "read", label: "mcp read" })).key;
  writeKey = (await createApiKey(f.db, { tenantId: f.tenantId, scope: "write", label: "mcp write" })).key;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** The official MCP client, wired straight to the Worker's MCP handler (no network). */
async function connect(key: string, db: Db = f.db) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://booking.test/mcp"), {
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set("Authorization", `Bearer ${key}`);
      return handleMcp(request, db, () => NOW);
    },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

describe("auth and scopes", () => {
  it("rejects requests without a valid key", async () => {
    const res = await handleMcp(new Request("http://booking.test/mcp", { method: "POST" }), f.db);
    expect(res.status).toBe(401);
    await expect(connect("bk_wrong")).rejects.toThrow();
  });

  it("shows read-only keys only the read tools", async () => {
    const { tools } = await (await connect(readKey)).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_booking", "list_services", "search_availability"]);
  });

  it("shows write keys every tool, with safety annotations", async () => {
    const { tools } = await (await connect(writeKey)).listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([
      "cancel_booking",
      "confirm_booking",
      "find_bookings_by_email",
      "get_booking",
      "hold_slot",
      "list_services",
      "reschedule_booking",
      "search_availability",
    ]);
    expect(byName.cancel_booking?.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.hold_slot?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.list_services?.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("policies resource", () => {
  it("returns the tenant's rules", async () => {
    const client = await connect(readKey);
    const result = await client.readResource({ uri: "booking://policies" });
    const first = result.contents[0] as { text: string };
    expect(JSON.parse(first.text)).toEqual({
      business: "Northside Studio",
      timeZone: "America/New_York",
      holdMinutes: 10,
      cancellationNoticeHours: 24,
      slotStepMinutes: 30,
    });
  });
});

describe("booking flow over MCP", () => {
  it("lists, searches, holds, confirms, reschedules, and cancels", async () => {
    const client = await connect(writeKey);

    const services = await call(client, "list_services");
    const [service] = services.structuredContent?.services as { id: string }[];
    expect(service?.id).toBe(f.serviceId);

    const search = await call(client, "search_availability", { serviceId: f.serviceId, from: "2026-03-06", to: "2026-03-06" });
    const [slot] = search.structuredContent?.slots as { start: string }[];
    expect(slot?.start).toBe("2026-03-06T14:00:00Z");

    const holdArgs = {
      serviceId: f.serviceId,
      start: slot!.start,
      customerName: "Sam Rivera",
      customerEmail: "sam@example.com",
      idempotencyKey: "mcp-flow-0001",
    };
    const held = await call(client, "hold_slot", holdArgs);
    const booking = held.structuredContent?.booking as { id: string; status: string };
    expect(booking.status).toBe("held");

    // A retry with the same key returns the same hold.
    const retried = await call(client, "hold_slot", holdArgs);
    expect((retried.structuredContent?.booking as { id: string }).id).toBe(booking.id);

    const confirmed = await call(client, "confirm_booking", { bookingId: booking.id });
    expect(confirmed.structuredContent?.booking).toMatchObject({ status: "confirmed" });

    const moved = await call(client, "reschedule_booking", { bookingId: booking.id, start: "2026-03-06T15:00:00Z" });
    expect(moved.structuredContent?.booking).toMatchObject({ start: "2026-03-06T15:00:00Z" });

    const found = await call(client, "find_bookings_by_email", { email: "SAM@example.com" });
    expect(found.structuredContent?.bookings).toHaveLength(1);

    const cancelled = await call(client, "cancel_booking", { bookingId: booking.id });
    expect(cancelled.structuredContent?.booking).toMatchObject({ status: "cancelled" });
  });
});

describe("errors", () => {
  it("returns domain errors as tool errors with a stable code", async () => {
    const client = await connect(writeKey);
    const args = { serviceId: f.serviceId, start: "2026-03-06T14:00:00Z", customerName: "Sam", customerEmail: "sam@example.com" };
    await call(client, "hold_slot", { ...args, idempotencyKey: "mcp-error-0001" });
    const clash = await call(client, "hold_slot", { ...args, idempotencyKey: "mcp-error-0002" });
    expect(clash.isError).toBe(true);
    expect(clash.structuredContent).toMatchObject({ error: { code: "slot_unavailable" } });
  });

  it("rejects invalid arguments before the tool runs", async () => {
    const client = await connect(readKey);
    const result = await call(client, "get_booking", { bookingId: "not-a-uuid" });
    expect(result.isError).toBe(true);
  });

  it("doesn't leak another tenant's bookings", async () => {
    const otherKey = (await createApiKey(f.db, { tenantId: f.otherTenantId, scope: "write", label: "other" })).key;
    const mine = await call(await connect(writeKey), "hold_slot", {
      serviceId: f.serviceId,
      start: "2026-03-06T14:00:00Z",
      customerName: "Sam",
      customerEmail: "sam@example.com",
      idempotencyKey: "mcp-tenant-0001",
    });
    const id = (mine.structuredContent?.booking as { id: string }).id;
    const peek = await call(await connect(otherKey), "get_booking", { bookingId: id });
    expect(peek.structuredContent).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("audit log", () => {
  type AuditRow = { tool: string; inputs: Record<string, unknown>; result_code: string; key_id: string };
  const auditRows = () =>
    f.db.query<AuditRow>(`SELECT tool, inputs, result_code, key_id::text FROM audit_log ORDER BY id`);

  it("records every tool call with the key, outcome, and redacted inputs", async () => {
    const [keyRow] = await f.db.query<{ id: string }>(`SELECT id FROM api_keys WHERE label = 'mcp write'`);
    const client = await connect(writeKey);
    await call(client, "list_services");
    await call(client, "hold_slot", {
      serviceId: f.serviceId,
      start: "2026-03-06T14:00:00Z",
      customerName: "Sam Rivera",
      customerEmail: "sam@example.com",
      idempotencyKey: "mcp-audit-0001",
    });
    await call(client, "find_bookings_by_email", { email: "sam@example.com" });
    await call(client, "confirm_booking", { bookingId: "00000000-0000-4000-8000-000000000000" });

    const rows = await auditRows();
    expect(rows.map((r) => [r.tool, r.result_code])).toEqual([
      ["list_services", "ok"],
      ["hold_slot", "ok"],
      ["find_bookings_by_email", "ok"],
      ["confirm_booking", "not_found"],
    ]);
    expect(rows.every((r) => r.key_id === keyRow!.id)).toBe(true);
    expect(rows[1]!.inputs).toMatchObject({
      customerName: "[redacted]",
      customerEmail: "[redacted]",
      idempotencyKey: "mcp-audit-0001",
    });
    expect(JSON.stringify(rows)).not.toMatch(/sam@example\.com|Sam Rivera/i);
  });

  it("still returns the tool result if the audit write fails", async () => {
    const failingAudit: Db = {
      query: (text, params) =>
        text.includes("INSERT INTO audit_log") ? Promise.reject(new Error("audit down")) : f.db.query(text, params),
    };
    const client = await connect(readKey, failingAudit);
    const result = await call(client, "list_services");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.services).toHaveLength(1);
  });
});
