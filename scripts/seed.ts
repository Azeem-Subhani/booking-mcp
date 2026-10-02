// Seeds the demo tenant on the Neon database in DATABASE_URL and creates the demo API keys.
//   npm run seed
// Raw keys are appended to .dev.vars as DEMO_READ_KEY / DEMO_WRITE_KEY and never printed.
// Safe to re-run: the tenant is only seeded once, and a key is only created if .dev.vars
// doesn't already hold a valid one.
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
const KEYS: { name: string; scope: Scope; label: string }[] = [
  { name: "DEMO_READ_KEY", scope: "read", label: "Public demo (read)" },
  { name: "DEMO_WRITE_KEY", scope: "write", label: "Owner testing (write)" },
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
      if (principal?.tenantId === tenantId && principal.scope === spec.scope) {
        console.log(`${spec.name}: already valid, kept.`);
        continue;
      }
      const { id, key } = await createApiKey(db, { tenantId, scope: spec.scope, label: spec.label });
      // A later line wins when the file is loaded, so a stale value above is harmless.
      const text = fs.readFileSync(VARS_FILE, "utf8");
      fs.appendFileSync(VARS_FILE, `${text === "" || text.endsWith("\n") ? "" : "\n"}${spec.name}=${key}\n`);
      console.log(`${spec.name}: created ${spec.scope} key ${id}, written to ${VARS_FILE}.`);
    }
  } catch (error) {
    // Message only: the error object can carry connection config.
    console.error(`Seed failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
