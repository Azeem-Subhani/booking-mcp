/**
 * Forward-only migration runner. Applies db/migrations/*.sql in name order and records each in
 * schema_migrations with a SHA-256 checksum, so an edited migration is caught instead of being
 * silently skipped. Runtime-neutral: the caller supplies the files and the connection.
 */

export interface Migration {
  name: string;
  sql: string;
}

/** A single database session. `exec` must accept multi-statement SQL (simple query protocol). */
export interface MigrationConn {
  exec(sql: string): Promise<void>;
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

export type MigrationState = "applied" | "pending" | "changed" | "missing";

export interface MigrationStatus {
  name: string;
  state: MigrationState;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const byName = (a: Migration, b: Migration) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Compares the files on disk with what the database has recorded. Read-only: never creates anything. */
export async function migrationStatus(conn: MigrationConn, migrations: Migration[]): Promise<MigrationStatus[]> {
  const [table] = await conn.query<{ exists: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
  );
  const rows = table?.exists
    ? await conn.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM schema_migrations`)
    : [];
  const recorded = new Map(rows.map((r) => [r.name, r.checksum]));

  const status: MigrationStatus[] = [];
  for (const m of [...migrations].sort(byName)) {
    const checksum = recorded.get(m.name);
    recorded.delete(m.name);
    if (checksum === undefined) status.push({ name: m.name, state: "pending" });
    else status.push({ name: m.name, state: checksum === (await sha256(m.sql)) ? "applied" : "changed" });
  }
  // Recorded in the database but no longer on disk.
  for (const name of recorded.keys()) status.push({ name, state: "missing" });
  return status;
}

/**
 * Applies pending migrations in order, each in its own transaction with its schema_migrations row,
 * so a failure leaves no partial schema and no record. Refuses to run if any applied migration was
 * edited or deleted. Returns the names it applied.
 *
 * There's no advisory lock: if two runners race, the primary key on schema_migrations.name makes the
 * second insert fail and its transaction roll back.
 */
export async function applyMigrations(conn: MigrationConn, migrations: Migration[]): Promise<string[]> {
  await conn.exec(CREATE_TABLE);
  const status = await migrationStatus(conn, migrations);
  const drifted = status.filter((s) => s.state === "changed" || s.state === "missing");
  if (drifted.length > 0) {
    throw new Error(`Applied migrations differ from disk: ${drifted.map((s) => `${s.name} (${s.state})`).join(", ")}`);
  }

  const pending = new Set(status.filter((s) => s.state === "pending").map((s) => s.name));
  const applied: string[] = [];
  for (const m of [...migrations].sort(byName)) {
    if (!pending.has(m.name)) continue;
    await conn.exec("BEGIN");
    try {
      await conn.exec(m.sql);
      await conn.query(`INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, [m.name, await sha256(m.sql)]);
      await conn.exec("COMMIT");
    } catch (error) {
      await conn.exec("ROLLBACK");
      throw error;
    }
    applied.push(m.name);
  }
  return applied;
}
