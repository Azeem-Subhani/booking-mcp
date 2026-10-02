import { createMcpHandler } from "@modelcontextprotocol/server";

import { createApi } from "./api.ts";
import { authenticate } from "./auth.ts";
import { neonDb, type Db } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";

export interface Env {
  DATABASE_URL: string;
}

const unauthorized = () =>
  Response.json(
    { error: { code: "unauthorized", message: "Missing or invalid API key." } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );

/** Serves the MCP endpoint for one request. Exported for tests, which pass a PGlite-backed Db. */
export async function handleMcp(request: Request, db: Db, now?: () => Date) {
  const header = request.headers.get("Authorization") ?? "";
  const principal = header.startsWith("Bearer ") ? await authenticate(db, header.slice(7)) : null;
  if (!principal) return unauthorized();
  // Stateless serving: a fresh handler per request, scoped to this key's tenant and permissions.
  const handler = createMcpHandler(() => buildMcpServer({ db, principal, ...(now ? { now } : {}) }));
  return handler.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const db = neonDb(env.DATABASE_URL);
    if (pathname === "/mcp") return handleMcp(request, db);
    if (pathname.startsWith("/api/")) return createApi({ db }).fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
