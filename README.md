# booking-mcp

A booking API for appointment-based businesses, built to be driven safely by AI assistants over the
Model Context Protocol. The demo tenant is a fictional fitness studio.

**Status:** milestone 1 of 5 (booking domain and REST API). The MCP server lands in milestone 2.

## What's in milestone 1

- **Availability search** in the studio's local time zone, including the daylight-saving change.
- **Two-step booking.** A hold reserves a slot for 10 minutes, then a separate call confirms it.
- **Idempotent holds.** Retrying with the same `Idempotency-Key` returns the original hold.
- **No double-booking**, enforced by a Postgres exclusion constraint rather than application code.
- **Cancellation and reschedule policy.** Confirmed bookings can't change inside the notice window (24h).
- **Scoped API keys** (read or write) per tenant, stored as SHA-256 hashes.
- **Tenant isolation.** Every query is scoped by tenant, and tests check cross-tenant access fails.

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
| GET | `/api/bookings?email=` | read |
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
```

## Stack

TypeScript, Hono, Zod, Postgres (Neon in production, PGlite in tests), Vitest. Planned: MCP TypeScript SDK v2,
Cloudflare Workers, Stripe test mode.
