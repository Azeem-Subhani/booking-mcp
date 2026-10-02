import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { recordToolCall } from "./audit.ts";
import { hasScope, type Principal, type Scope } from "./auth.ts";
import type { Db } from "./db.ts";
import {
  type Booking,
  cancelBooking,
  confirmBooking,
  findBookingsByEmail,
  getBooking,
  HOLD_MINUTES,
  holdSlot,
  rescheduleBooking,
} from "./domain/bookings.ts";
import { listServices, MAX_AVAILABILITY_DAYS, searchAvailability } from "./domain/catalog.ts";
import { withDetails } from "./domain/details.ts";
import { DomainError } from "./domain/errors.ts";
import { getPolicies } from "./domain/policies.ts";

export interface McpDeps {
  db: Db;
  principal: Principal;
  now?: () => Date;
}

const INSTRUCTIONS = `Book private sessions for one business.
- Call get_policies first (also available as the booking://policies resource). Quote its rules; don't invent policies.
- All instants are ISO 8601 UTC. Show customers times in the business's time zone (timeZone in get_policies and search_availability).
- Booking takes two steps. hold_slot reserves a time for ${HOLD_MINUTES} minutes. Repeat the service, time, and price back to the customer and get a clear yes before calling confirm_booking.
- If a tool returns slot_unavailable or hold_expired, search availability again rather than retrying the same time.`;

const bookingId = z.uuid().describe("Booking ID returned by hold_slot or a lookup.");
const instant = z.iso.datetime({ offset: true }).describe("Start time, ISO 8601, e.g. 2026-03-06T14:00:00Z.");

// Input schemas are built once per isolate, not per request: a fresh server is built for every
// request (so each key only sees its tools), but the schemas themselves don't depend on the key.
const serviceId = z.uuid().describe("Service ID from list_services.");
const searchInput = z.object({
  serviceId,
  from: z.iso.date().describe("First local date to search, YYYY-MM-DD."),
  to: z.iso.date().describe("Last local date to search, YYYY-MM-DD."),
});
const bookingIdInput = z.object({ bookingId });
const emailInput = z.object({ email: z.email().describe("Customer email address.") });
const holdInput = z.object({
  serviceId,
  start: instant,
  customerName: z.string().trim().min(1).max(120),
  customerEmail: z.email().max(254),
  idempotencyKey: z.string().min(8).max(200).describe("Unique per booking attempt, e.g. a UUID you generate."),
});
const rescheduleInput = z.object({ bookingId, start: instant });

/**
 * Every tool's required scope and input schema (the same schema objects registered below). The
 * HTTP layer uses this to audit calls the SDK rejects before a tool body runs; a test checks it
 * matches what each scope's server actually lists.
 */
export const TOOLS: Record<string, { scope: Scope; input?: z.ZodType }> = {
  get_policies: { scope: "read" },
  list_services: { scope: "read" },
  search_availability: { scope: "read", input: searchInput },
  get_booking: { scope: "read", input: bookingIdInput },
  find_bookings_by_email: { scope: "write", input: emailInput },
  hold_slot: { scope: "write", input: holdInput },
  confirm_booking: { scope: "write", input: bookingIdInput },
  reschedule_booking: { scope: "write", input: rescheduleInput },
  cancel_booking: { scope: "write", input: bookingIdInput },
};

/**
 * Builds one MCP server for an authenticated API key. Write tools are only registered for
 * write-scoped keys, so a read-only assistant never sees tools it isn't allowed to call.
 */
export function buildMcpServer({ db, principal, now = () => new Date() }: McpDeps): McpServer {
  const { tenantId } = principal;
  const server = new McpServer({ name: "booking-mcp", version: "0.2.0" }, { instructions: INSTRUCTIONS });

  /** Runs a tool body, then records the call in the audit log. */
  const audited = async (tool: string, inputs: Record<string, unknown>, body: () => Promise<Record<string, unknown>>) => {
    const started = performance.now();
    const { result, code } = await run(body);
    try {
      await recordToolCall(db, principal, { tool, inputs, resultCode: code, durationMs: performance.now() - started, at: now() });
    } catch (error) {
      // The tool has already run (a booking may exist), so failing the call here would mislead the
      // client. Log loudly instead; observability alerts on this message.
      console.error("Audit log write failed", { tool, keyId: principal.keyId, error: String(error) });
    }
    return result;
  };

  /** Booking plus service name, price, and local times, so the model can read it back as-is. */
  const detailed = async (booking: Booking) => ({ booking: (await withDetails(db, tenantId, [booking]))[0] });

  server.registerResource(
    "policies",
    "booking://policies",
    { title: "Booking policies", description: "Time zone, hold length, and cancellation rules.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await getPolicies(db, tenantId), null, 2) }],
    }),
  );

  // Same payload as the resource, as a tool: some clients (Claude Desktop among them) only let the
  // user attach resources, so the model could otherwise never learn the time zone or the rules.
  server.registerTool(
    "get_policies",
    {
      title: "Get policies",
      description: "The business's time zone, hold length, and cancellation notice. Read this before quoting times or rules to a customer.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => audited("get_policies", {}, async () => ({ policies: await getPolicies(db, tenantId) })),
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "List bookable services with duration and price (in cents).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => audited("list_services", {}, async () => ({ services: await listServices(db, tenantId) })),
  );

  server.registerTool(
    "search_availability",
    {
      title: "Search availability",
      description: `Free start times for a service. Dates are local to the business (YYYY-MM-DD, inclusive), up to ${MAX_AVAILABILITY_DAYS} days per search. Returned times are UTC; timeZone is the business's IANA time zone for showing them to customers.`,
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      audited("search_availability", input, async () => {
        const slots = await searchAvailability(db, tenantId, input, now());
        // Without the zone next to the slots, the model can only show customers UTC or guess.
        const { timeZone } = await getPolicies(db, tenantId);
        return { timeZone, slots };
      }),
  );

  server.registerTool(
    "get_booking",
    {
      title: "Get booking",
      description: "Look up one booking by ID.",
      inputSchema: bookingIdInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ bookingId: id }) => audited("get_booking", { bookingId: id }, async () => detailed(await getBooking(db, tenantId, id))),
  );

  if (!hasScope(principal, "write")) return server;

  // Write-scoped from here on. Customer lookup by email sits here too: a read-only key
  // shouldn't be able to list someone's bookings from their email address.
  server.registerTool(
    "find_bookings_by_email",
    {
      title: "Find bookings by email",
      description: "A customer's 20 most recent bookings, matched case-insensitively by email.",
      inputSchema: emailInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ email }) => audited("find_bookings_by_email", { email }, async () => ({
        bookings: await withDetails(db, tenantId, await findBookingsByEmail(db, tenantId, email)),
      })),
  );

  server.registerTool(
    "hold_slot",
    {
      title: "Hold a slot",
      description: `Reserve a start time for ${HOLD_MINUTES} minutes. This does not book anything yet. If you retry after an error, reuse the same idempotencyKey so you get the same hold back instead of a second one. The booking's details carry the service name, price, and local times to read back to the customer.`,
      inputSchema: holdInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => audited("hold_slot", input, async () => detailed(await holdSlot(db, tenantId, input, now()))),
  );

  server.registerTool(
    "confirm_booking",
    {
      title: "Confirm booking",
      description: "Turn a hold into a confirmed booking. Only call this after the customer has explicitly agreed to the service, time, and price.",
      inputSchema: bookingIdInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ bookingId: id }) => audited("confirm_booking", { bookingId: id }, async () => detailed(await confirmBooking(db, tenantId, id, now()))),
  );

  server.registerTool(
    "reschedule_booking",
    {
      title: "Reschedule booking",
      description: "Move a confirmed booking to a new start time. Not allowed inside the cancellation notice window; see booking://policies.",
      inputSchema: rescheduleInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ bookingId: id, start }) =>
      audited("reschedule_booking", { bookingId: id, start }, async () => detailed(await rescheduleBooking(db, tenantId, { bookingId: id, start }, now()))),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel booking",
      description: "Cancel a booking or release a hold. Confirmed bookings follow the notice policy. Confirm with the customer first.",
      inputSchema: bookingIdInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ bookingId: id }) => audited("cancel_booking", { bookingId: id }, async () => detailed(await cancelBooking(db, tenantId, id, now()))),
  );

  return server;
}

/** Caps on caller-supplied strings stored for rejected calls. */
const MAX_AUDITED_NAME = 100;
const MAX_AUDITED_ARGS = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Audits tools/call requests the SDK rejects before any tool body runs, so they never reach
 * `audited`: an unknown tool, a tool above the key's scope, or arguments that fail the schema.
 * Only argument names are stored. The schema didn't run, so nothing was stripped, and a misspelled
 * field (say customer_email) could carry PII the redaction list wouldn't recognize.
 * This only observes; the SDK still handles the request and builds the response.
 */
export async function auditRejectedToolCalls(db: Db, principal: Principal, body: unknown, at: Date): Promise<void> {
  for (const message of Array.isArray(body) ? body : [body]) {
    if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params)) continue;
    const { name, arguments: args } = message.params;
    if (typeof name !== "string") continue; // malformed request, rejected by the SDK's protocol checks
    const code = rejectionCode(principal, name, args);
    if (!code) continue;
    const tool = name.slice(0, MAX_AUDITED_NAME);
    const argNames = isRecord(args) ? Object.keys(args).slice(0, MAX_AUDITED_ARGS) : [];
    try {
      await recordToolCall(db, principal, {
        tool,
        inputs: Object.fromEntries(argNames.map((arg) => [arg.slice(0, MAX_AUDITED_NAME), "[redacted]"])),
        resultCode: code,
        durationMs: 0,
        at,
      });
    } catch (error) {
      // Same as `audited`: never fail the request over the audit log.
      console.error("Audit log write failed", { tool, keyId: principal.keyId, error: String(error) });
    }
  }
}

function rejectionCode(principal: Principal, name: string, args: unknown): string | null {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (!tool) return "unknown_tool";
  if (!hasScope(principal, tool.scope)) return "scope_denied";
  // Same schema and the same `?? {}` default as the SDK, so both agree on what's invalid.
  if (tool.input && !tool.input.safeParse(args ?? {}).success) return "invalid_arguments";
  return null;
}

/**
 * Runs a tool body and shapes the result, plus a result code for the audit log. Expected failures
 * come back as tool errors with a stable code so the model can recover. Anything else is logged and
 * returned generically, so database details never reach the model.
 */
async function run(body: () => Promise<Record<string, unknown>>) {
  try {
    const data = await body();
    const result = { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
    return { result, code: "ok" };
  } catch (error) {
    const known = error instanceof DomainError;
    if (!known) console.error("Unhandled MCP tool error", error);
    const detail = known
      ? { code: error.code, message: error.message }
      : { code: "internal", message: "Something went wrong. Try again later." };
    const result = {
      isError: true,
      content: [{ type: "text" as const, text: `${detail.code}: ${detail.message}` }],
      structuredContent: { error: detail },
    };
    return { result, code: detail.code };
  }
}
