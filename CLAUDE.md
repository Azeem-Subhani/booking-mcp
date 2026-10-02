# booking-mcp

Booking API plus an MCP server, for a fictional fitness studio. Portfolio project that
must stay $0 to run: Cloudflare Workers, Neon free tier, Stripe test mode only.

## Commands
- `npm test`: Vitest against in-memory Postgres (PGlite)
- `npm run test:postgres`: same suite against a real local Postgres 18 (`TEST_DATABASE_URL`, localhost only),
  one database per test in a non-UTC session time zone. CI runs both.
- `npm run typecheck`: TypeScript
- `npm run lint`: ESLint
- `npm run smoke`: boots the Worker in workerd, no database access

Run all four before calling work done.

## Rules
- Code in `src/` must stay runtime-neutral (Workers, Node): Web APIs only, no `node:` imports.
  `src/stdio.ts` is the one Node entry and declares the single global it uses.
- Write tools are only registered for write-scoped keys. Keep customer lookup by email write-scoped.
- The database enforces double-booking prevention (`bookings_no_overlap`). Don't move that check into app code.
- Never depend on the Postgres session TimeZone. Convert with the tenant's `time_zone` explicitly.
- Pin dependencies to exact versions. TypeScript stays on 6.0.x until typescript-eslint supports 7.
- No secrets in the repo. Local secrets go in `.dev.vars` (gitignored).
- Demo data is fictional. Don't model it on any real client's business.
