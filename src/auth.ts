import type { Db } from "./db.ts";

export type Scope = "read" | "write";

export interface Principal {
  keyId: string;
  tenantId: string;
  scope: Scope;
}

export const KEY_PREFIX = "bk_";

/** SHA-256 hex digest via Web Crypto, so it runs unchanged in Workers and Node. */
export async function hashApiKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url-encoded. High entropy, so a plain hash (no salt) is enough. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return KEY_PREFIX + base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Stores only the hash. The returned raw key can't be recovered later. */
export async function createApiKey(
  db: Db,
  input: { tenantId: string; scope: Scope; label: string },
): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, key_hash, scope, label) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.tenantId, await hashApiKey(key), input.scope, input.label],
  );
  if (!row) throw new Error("Failed to create API key.");
  return { id: row.id, key };
}

export async function authenticate(db: Db, rawKey: string): Promise<Principal | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const [row] = await db.query<Principal>(
    `SELECT id AS "keyId", tenant_id AS "tenantId", scope
     FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [await hashApiKey(rawKey)],
  );
  return row ?? null;
}

export function hasScope(principal: Principal, required: Scope): boolean {
  return required === "read" || principal.scope === "write";
}
