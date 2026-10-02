import { neon } from "@neondatabase/serverless";

/**
 * The only database surface the domain code depends on. Keeping it this small lets the
 * same code run on Neon in production and on PGlite (in-memory Postgres) in tests.
 */
export interface Db {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

/** Neon over HTTP. Works in Cloudflare Workers with no Node APIs. */
export function neonDb(connectionString: string): Db {
  const sql = neon(connectionString);
  return {
    query: async <T>(text: string, params: unknown[] = []) => (await sql.query(text, params)) as T[],
  };
}

/** Postgres error codes the domain layer translates into user-facing errors. */
export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_UNIQUE_VIOLATION = "23505";

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
