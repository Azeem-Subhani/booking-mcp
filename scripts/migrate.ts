// Migration CLI for the Neon database in DATABASE_URL (read from .dev.vars, never printed).
//   npm run migrate            show applied and pending migrations (read-only)
//   npm run migrate -- apply   apply pending migrations
import { Client } from "@neondatabase/serverless";

import { applyMigrations, migrationStatus, type Migration, type MigrationConn } from "../src/migrate.ts";

// The Node APIs this script needs, declared locally so no Node types leak into src/.
interface NodeFs {
  readdirSync(path: URL): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
}
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  loadEnvFile(path: string): void;
  getBuiltinModule(id: "node:fs"): NodeFs;
};

const mode = process.argv[2] ?? "status";
if (mode !== "status" && mode !== "apply") {
  console.error(`Unknown mode "${mode}". Use "status" or "apply".`);
  process.exitCode = 1;
} else {
  await main(mode);
}

async function main(mode: "status" | "apply") {
  // An explicit DATABASE_URL in the environment wins; otherwise use .dev.vars.
  if (!process.env.DATABASE_URL) process.loadEnvFile(".dev.vars");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set in the environment or .dev.vars.");
    process.exitCode = 1;
    return;
  }

  const fs = process.getBuiltinModule("node:fs");
  const dir = new URL("../db/migrations/", import.meta.url);
  const migrations: Migration[] = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: fs.readFileSync(new URL(name, dir), "utf8") }));

  // WebSocket session (Node 24 has a global WebSocket). Unlike the HTTP driver, it accepts
  // multi-statement SQL and keeps BEGIN/COMMIT on one connection.
  const client = new Client(url);
  try {
    await client.connect();
    const conn: MigrationConn = {
      exec: async (sql) => void (await client.query(sql)),
      query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
    };

    if (mode === "apply") {
      const applied = await applyMigrations(conn, migrations);
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Nothing to apply.");
    }
    for (const s of await migrationStatus(conn, migrations)) console.log(`${s.state.padEnd(8)} ${s.name}`);
  } catch (error) {
    // Print only the message, scrubbed of connection details. The error object can carry config.
    console.error(`Migration failed: ${redact(error, url)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

function redact(error: unknown, url: string): string {
  let message = describe(error);
  const code = typeof error === "object" && error !== null && "code" in error ? ` [${String(error.code)}]` : "";
  try {
    const { username, password, hostname } = new URL(url);
    for (const secret of [url, password, username, hostname]) {
      if (secret) message = message.replaceAll(secret, "***");
    }
  } catch {
    message = message.replaceAll(url, "***");
  }
  return message + code;
}

// Connection failures arrive as a WebSocket ErrorEvent, not an Error, often with the cause nested.
function describe(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const { message, error: inner } = error as { message?: unknown; error?: unknown };
  if (typeof message === "string" && message) return message;
  if (inner !== undefined && inner !== error) return describe(inner);
  return "Could not connect to the database.";
}
