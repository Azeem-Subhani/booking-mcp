# booking-mcp

Booking API plus (from milestone 2) an MCP server, for a fictional fitness studio. Portfolio project that
must stay $0 to run: Cloudflare Workers, Neon free tier, Stripe test mode only.

## Commands
- `npm test`: Vitest against in-memory Postgres (PGlite)
- `npm run typecheck`: TypeScript
- `npm run lint`: ESLint

Run all three before calling work done.

## Rules
- Code in `src/` must stay runtime-neutral (Workers, Node): Web APIs only, no `node:` imports.
- The database enforces double-booking prevention (`bookings_no_overlap`). Don't move that check into app code.
- Never depend on the Postgres session TimeZone. Convert with the tenant's `time_zone` explicitly.
- Pin dependencies to exact versions. TypeScript stays on 6.0.x until typescript-eslint supports 7.
- No secrets in the repo. Local secrets go in `.dev.vars` (gitignored).
- Demo data is fictional. Don't model it on any real client's business.
