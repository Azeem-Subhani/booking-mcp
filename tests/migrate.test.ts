import { describe, expect, it } from "vitest";

import { applyMigrations, migrationStatus } from "../src/migrate.ts";
import { freshDatabase, MIGRATIONS } from "./helpers.ts";

const fresh = async () => (await freshDatabase()).conn;

describe("migrations", () => {
  it("finds the real migration files", () => {
    expect(MIGRATIONS.map((m) => m.name)).toContain("0001_init.sql");
  });

  it("reports status without creating anything", async () => {
    const conn = await fresh();
    expect(await migrationStatus(conn, [{ name: "0001_a.sql", sql: "CREATE TABLE a (id int);" }])).toEqual([
      { name: "0001_a.sql", state: "pending" },
    ]);
    const [row] = await conn.query<{ exists: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
    );
    expect(row?.exists).toBe(false);
  });

  it("applies in name order regardless of input order, then applies nothing on a second run", async () => {
    const conn = await fresh();
    const a = { name: "0001_a.sql", sql: "CREATE TABLE a (id int);" };
    const b = { name: "0002_b.sql", sql: "CREATE TABLE b (a_id int); INSERT INTO b VALUES (1);" };

    expect(await applyMigrations(conn, [b, a])).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await applyMigrations(conn, [a, b])).toEqual([]);
    expect(await migrationStatus(conn, [a, b])).toEqual([
      { name: "0001_a.sql", state: "applied" },
      { name: "0002_b.sql", state: "applied" },
    ]);
  });

  it("rolls back a failing migration and leaves no record of it", async () => {
    const conn = await fresh();
    const good = { name: "0001_good.sql", sql: "CREATE TABLE good (id int);" };
    const bad = { name: "0002_bad.sql", sql: "CREATE TABLE half_done (id int); SELECT * FROM no_such_table;" };

    await expect(applyMigrations(conn, [good, bad])).rejects.toThrow(/no_such_table/);
    const tables = await conn.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_name IN ('good', 'half_done')`,
    );
    expect(tables.map((t) => t.name)).toEqual(["good"]);
    expect(await migrationStatus(conn, [good, bad])).toEqual([
      { name: "0001_good.sql", state: "applied" },
      { name: "0002_bad.sql", state: "pending" },
    ]);
  });

  it("refuses to run when an applied migration was edited or deleted", async () => {
    const conn = await fresh();
    const a = { name: "0001_a.sql", sql: "CREATE TABLE a (id int);" };
    const b = { name: "0002_b.sql", sql: "CREATE TABLE b (id int);" };
    await applyMigrations(conn, [a, b]);

    const edited = { ...a, sql: "CREATE TABLE a (id bigint);" };
    await expect(applyMigrations(conn, [edited, b])).rejects.toThrow("0001_a.sql (changed)");
    await expect(applyMigrations(conn, [a])).rejects.toThrow("0002_b.sql (missing)");
  });
});
