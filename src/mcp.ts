import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { hasScope, type Principal } from "./auth.ts";
import type { Db } from "./db.ts";
import {
  cancelBooking,
  confirmBooking,
  findBookingsByEmail,
  getBooking,
  HOLD_MINUTES,
  holdSlot,
  rescheduleBooking,
} from "./domain/bookings.ts";
import { listServices, MAX_AVAILABILITY_DAYS, searchAvailability } from "./domain/catalog.ts";
import { DomainError } from "./domain/errors.ts";
import { getPolicies } from "./domain/policies.ts";

export interface McpDeps {
  db: Db;
  principal: Principal;
  now?: () => Date;
}

const INSTRUCTIONS = `Book private sessions for one business.
- Read booking://policies first. Quote its rules; don't invent policies.
- All instants are ISO 8601 UTC. Show customers times in the business's time zone.
- Booking takes two steps. hold_slot reserves a time for ${HOLD_MINUTES} minutes. Repeat the service, time, and price back to the customer and get a clear yes before calling confirm_booking.
- If a tool returns slot_unavailable or hold_expired, search availability again rather than retrying the same time.`;

const bookingId = z.uuid().describe("Booking ID returned by hold_slot or a lookup.");
const instant = z.iso.datetime({ offset: true }).describe("Start time, ISO 8601, e.g. 2026-03-06T14:00:00Z.");

/**
 * Builds one MCP server for an authenticated API key. Write tools are only registered for
 * write-scoped keys, so a read-only assistant never sees tools it isn't allowed to call.
 */
export function buildMcpServer({ db, principal, now = () => new Date() }: McpDeps): McpServer {
  const { tenantId } = principal;
  const server = new McpServer({ name: "booking-mcp", version: "0.2.0" }, { instructions: INSTRUCTIONS });

  server.registerResource(
    "policies",
    "booking://policies",
    { title: "Booking policies", description: "Time zone, hold length, and cancellation rules.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await getPolicies(db, tenantId), null, 2) }],
    }),
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "List bookable services with duration and price (in cents).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run(async () => ({ services: await listServices(db, tenantId) })),
  );

  server.registerTool(
    "search_availability",
    {
      title: "Search availability",
      description: `Free start times for a service. Dates are local to the business (YYYY-MM-DD, inclusive), up to ${MAX_AVAILABILITY_DAYS} days per search. Returned times are UTC.`,
      inputSchema: z.object({
        serviceId: z.uuid().describe("Service ID from list_services."),
        from: z.iso.date().describe("First local date to search, YYYY-MM-DD."),
        to: z.iso.date().describe("Last local date to search, YYYY-MM-DD."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => run(async () => ({ slots: await searchAvailability(db, tenantId, input, now()) })),
  );

  server.registerTool(
    "get_booking",
    {
      title: "Get booking",
      description: "Look up one booking by ID.",
      inputSchema: z.object({ bookingId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ bookingId: id }) => run(async () => ({ booking: await getBooking(db, tenantId, id) })),
  );

  if (!hasScope(principal, "write")) return server;

  // Write-scoped from here on. Customer lookup by email sits here too: a read-only key
  // shouldn't be able to list someone's bookings from their email address.
  server.registerTool(
    "find_bookings_by_email",
    {
      title: "Find bookings by email",
      description: "A customer's 20 most recent bookings, matched case-insensitively by email.",
      inputSchema: z.object({ email: z.email().describe("Customer email address.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ email }) => run(async () => ({ bookings: await findBookingsByEmail(db, tenantId, email) })),
  );

  server.registerTool(
    "hold_slot",
    {
      title: "Hold a slot",
      description: `Reserve a start time for ${HOLD_MINUTES} minutes. This does not book anything yet. If you retry after an error, reuse the same idempotencyKey so you get the same hold back instead of a second one.`,
      inputSchema: z.object({
        serviceId: z.uuid().describe("Service ID from list_services."),
        start: instant,
        customerName: z.string().trim().min(1).max(120),
        customerEmail: z.email().max(254),
        idempotencyKey: z.string().min(8).max(200).describe("Unique per booking attempt, e.g. a UUID you generate."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => run(async () => ({ booking: await holdSlot(db, tenantId, input, now()) })),
  );

  server.registerTool(
    "confirm_booking",
    {
      title: "Confirm booking",
      description: "Turn a hold into a confirmed booking. Only call this after the customer has explicitly agreed to the service, time, and price.",
      inputSchema: z.object({ bookingId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ bookingId: id }) => run(async () => ({ booking: await confirmBooking(db, tenantId, id, now()) })),
  );

  server.registerTool(
    "reschedule_booking",
    {
      title: "Reschedule booking",
      description: "Move a confirmed booking to a new start time. Not allowed inside the cancellation notice window; see booking://policies.",
      inputSchema: z.object({ bookingId, start: instant }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ bookingId: id, start }) =>
      run(async () => ({ booking: await rescheduleBooking(db, tenantId, { bookingId: id, start }, now()) })),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel booking",
      description: "Cancel a booking or release a hold. Confirmed bookings follow the notice policy. Confirm with the customer first.",
      inputSchema: z.object({ bookingId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ bookingId: id }) => run(async () => ({ booking: await cancelBooking(db, tenantId, id, now()) })),
  );

  return server;
}

/**
 * Runs a tool body and shapes the result. Expected failures come back as tool errors with
 * a stable code so the model can recover. Anything else is logged and returned generically,
 * so database details never reach the model.
 */
async function run(body: () => Promise<Record<string, unknown>>) {
  try {
    const data = await body();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (error) {
    const known = error instanceof DomainError;
    if (!known) console.error("Unhandled MCP tool error", error);
    const detail = known
      ? { code: error.code, message: error.message }
      : { code: "internal", message: "Something went wrong. Try again later." };
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${detail.code}: ${detail.message}` }],
      structuredContent: { error: detail },
    };
  }
}
