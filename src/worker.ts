import { createMcpHandler } from "@modelcontextprotocol/server";

import { createApi } from "./api.ts";
import { neonDb, type Db } from "./db.ts";
import { auditRejectedToolCalls, buildMcpServer } from "./mcp.ts";
import { authorizeRequest, rateLimitedResponse } from "./ratelimit.ts";
import { resetSandbox } from "./reset.ts";

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
  const auth = header.startsWith("Bearer ") ? await authorizeRequest(db, header.slice(7), now ? now() : new Date()) : null;
  if (!auth) return unauthorized();
  if (!auth.limit.ok) return rateLimitedResponse(auth.limit);
  const { principal } = auth;
  // Calls the SDK rejects before a tool runs never reach the audit wrapper in mcp.ts, so check a
  // copy of the body here. Unparseable bodies are left for the SDK to reject.
  if (request.method === "POST") {
    const body = await request.clone().json().catch(() => null);
    await auditRejectedToolCalls(db, principal, body, now ? now() : new Date());
  }
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

  /** Cron Trigger (see wrangler.jsonc): nightly sandbox reset. Throwing marks the run as failed. */
  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    const result = await resetSandbox(neonDb(env.DATABASE_URL), new Date(controller.scheduledTime));
    console.log("Sandbox reset", result);
  },
};
