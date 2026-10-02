// Seeds the demo tenant on the Neon database in DATABASE_URL and creates the demo API keys.
//   npm run seed
// Raw keys are appended to .dev.vars as DEMO_READ_KEY / DEMO_WRITE_KEY and never printed.
// Safe to re-run: the tenant is only seeded once, a key is only created if .dev.vars doesn't
// already hold a valid one, and each key's rate limits are (re)applied. Needs migration 0002.
import { authenticate, createApiKey, type Scope } from "../src/auth.ts";
import { neonDb } from "../src/db.ts";
import { seedDemoTenant } from "../src/seed.ts";

// The Node APIs this script needs, declared locally so no Node types leak into src/.
interface NodeFs {
  readFileSync(path: URL | string, encoding: "utf8"): string;
  appendFileSync(path: string, data: string): void;
}
declare const process: {
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  loadEnvFile(path: string): void;
  getBuiltinModule(id: "node:fs"): NodeFs;
};

const VARS_FILE = ".dev.vars";
// The public demo key is shared, so it also gets a daily cap (resets at 00:00 UTC).
const KEYS: { name: string; scope: Scope; label: string; perMinute: number; daily: number | null }[] = [
  { name: "DEMO_READ_KEY", scope: "read", label: "Public demo (read)", perMinute: 30, daily: 1000 },
  { name: "DEMO_WRITE_KEY", scope: "write", label: "Owner testing (write)", perMinute: 60, daily: null },
];

const fs = process.getBuiltinModule("node:fs");
process.loadEnvFile(VARS_FILE);
const url = process.env.DATABASE_URL;

if (!url) {
  console.error(`DATABASE_URL is not set in ${VARS_FILE}.`);
  process.exitCode = 1;
} else {
  try {
    const db = neonDb(url);
    const seedSql = fs.readFileSync(new URL("../db/seed.sql", import.meta.url), "utf8");
    const { tenantId, created } = await seedDemoTenant(db, seedSql);
    console.log(created ? "Seeded demo tenant." : "Demo tenant already exists, not re-seeded.");

    for (const spec of KEYS) {
      const current = process.env[spec.name];
      const principal = current ? await authenticate(db, current) : null;
      let keyId: string;
      if (principal?.tenantId === tenantId && principal.scope === spec.scope) {
        keyId = principal.keyId;
        console.log(`${spec.name}: already valid, kept.`);
      } else {
        const { id, key } = await createApiKey(db, { tenantId, scope: spec.scope, label: spec.label });
        // A later line wins when the file is loaded, so a stale value above is harmless.
        const text = fs.readFileSync(VARS_FILE, "utf8");
        fs.appendFileSync(VARS_FILE, `${text === "" || text.endsWith("\n") ? "" : "\n"}${spec.name}=${key}\n`);
        console.log(`${spec.name}: created ${spec.scope} key ${id}, written to ${VARS_FILE}.`);
        keyId = id;
      }
      // Re-applied every run, so changing the limits above and re-running updates existing keys.
      await db.query(`UPDATE api_keys SET rate_limit_per_minute = $2, daily_limit = $3 WHERE id = $1`, [
        keyId,
        spec.perMinute,
        spec.daily,
      ]);
      console.log(`${spec.name}: limits ${spec.perMinute}/min, ${spec.daily ?? "no"} daily cap.`);
    }
  } catch (error) {
    // Message only: the error object can carry connection config.
    console.error(`Seed failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
