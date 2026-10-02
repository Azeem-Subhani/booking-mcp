// Local MCP server over stdio, for Claude Desktop, Cursor, and similar hosts.
// Reads DATABASE_URL and BOOKING_API_KEY from the environment the host launches it with.
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { authenticate } from "./auth.ts";
import { neonDb } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";

// The only Node global this entry needs; declared here so src/ stays free of Node types.
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.BOOKING_API_KEY;
if (!databaseUrl || !apiKey) {
  // stdout carries the MCP protocol, so diagnostics go to stderr.
  console.error("Set DATABASE_URL and BOOKING_API_KEY.");
  process.exit(1);
}

const db = neonDb(databaseUrl);
const principal = await authenticate(db, apiKey);
if (!principal) {
  console.error("BOOKING_API_KEY is invalid or revoked.");
  process.exit(1);
}

serveStdio(() => buildMcpServer({ db, principal }));
