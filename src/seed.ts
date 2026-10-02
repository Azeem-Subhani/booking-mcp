import type { Db } from "./db.ts";

export const DEMO_TENANT_SLUG = "northside";

/**
 * Loads db/seed.sql (passed in as text) unless the demo tenant already exists.
 * Returns the tenant id and whether this call created it.
 */
export async function seedDemoTenant(db: Db, seedSql: string): Promise<{ tenantId: string; created: boolean }> {
  const find = () => db.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [DEMO_TENANT_SLUG]);
  const [existing] = await find();
  if (existing) return { tenantId: existing.id, created: false };

  // seed.sql is a single statement (one CTE chain), so it runs atomically on any driver.
  await db.query(seedSql);
  const [tenant] = await find();
  if (!tenant) throw new Error(`Seed did not create the "${DEMO_TENANT_SLUG}" tenant.`);
  return { tenantId: tenant.id, created: true };
}
