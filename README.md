# booking-mcp

A booking API for appointment-based businesses, built to be driven safely by AI assistants over the
Model Context Protocol. The demo tenant is a fictional fitness studio.

**Status:** milestone 2 of 5 (MCP server). Deployment to Cloudflare Workers lands in milestone 3.

## What's in milestone 1

- **Availability search** in the studio's local time zone, including the daylight-saving change.
- **Two-step booking.** A hold reserves a slot for 10 minutes, then a separate call confirms it.
- **Idempotent holds.** Retrying with the same `Idempotency-Key` returns the original hold.
- **No double-booking**, enforced by a Postgres exclusion constraint rather than application code.
- **Cancellation and reschedule policy.** Confirmed bookings can't change inside the notice window (24h).
- **Scoped API keys** (read or write) per tenant, stored as SHA-256 hashes.
- **Tenant isolation.** Every query is scoped by tenant, and tests check cross-tenant access fails.

## MCP server

Served over Streamable HTTP at `/mcp` (Cloudflare Workers) and over stdio for local hosts such as
Claude Desktop. Requests authenticate with the same API keys as the REST API.

| Tool | Scope | Annotations |
|---|---|---|
| `list_services` | read | read-only |
| `search_availability` | read | read-only |
| `get_booking` | read | read-only |
| `find_bookings_by_email` | write | read-only |
| `hold_slot` | write | idempotent with a key |
| `confirm_booking` | write | idempotent |
| `reschedule_booking` | write | destructive |
| `cancel_booking` | write | destructive, idempotent |

Read-only keys only see the read tools. Lookup by email needs a write key, so a read-only key can't
list someone's bookings from their address.

The `booking://policies` resource gives the model the business's time zone, hold length, and
cancellation notice, and the server instructions tell it to quote those rather than guess. Expected
failures come back as tool errors with a stable code (`slot_unavailable`, `hold_expired`, ...) so the
model can recover. Unexpected errors are logged and returned generically.

To run it locally over stdio, set `DATABASE_URL` and `BOOKING_API_KEY` in the host's config and launch
`node src/stdio.ts`.

## Design notes

**Why the database prevents overlaps.** Checking availability in code and then inserting leaves a gap where
two requests can both pass the check. The `bookings_no_overlap` constraint makes Postgres reject the second
insert, so the guarantee holds however many API instances are running.

**Expired holds.** A hold past its expiry no longer blocks the slot. Writes flip stale holds to `expired`
before inserting, and availability and confirm both compare against the current time directly.

**Time zones.** Opening hours are stored as local wall-clock times. All conversion happens in Postgres
with the tenant's IANA zone, so DST is handled by the database's time zone data, not hand-written offsets.

**Testing limits.** Tests run on PGlite, a single-connection in-memory Postgres. They prove overlapping
bookings are rejected and the business rules hold. They don't simulate truly concurrent requests; that
guarantee comes from the constraint itself.

## REST API

All routes need `Authorization: Bearer <api key>`.

| Method | Path | Scope |
|---|---|---|
| GET | `/api/services` | read |
| GET | `/api/services/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` | read |
| GET | `/api/bookings/:id` | read |
| GET | `/api/bookings?email=` | write |
| POST | `/api/holds` (needs `Idempotency-Key` header) | write |
| POST | `/api/bookings/:id/confirm` | write |
| POST | `/api/bookings/:id/reschedule` | write |
| POST | `/api/bookings/:id/cancel` | write |

Errors share one shape: `{ "error": { "code": "slot_unavailable", "message": "..." } }`.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run smoke   # boots the Worker in workerd and checks routing
```

## Stack

TypeScript, Hono, Zod, Postgres (Neon in production, PGlite in tests), Vitest. MCP TypeScript SDK v2, Cloudflare Workers
(Wrangler). Planned: Stripe test mode.
