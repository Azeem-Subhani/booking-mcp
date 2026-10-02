// Bundles and starts the real Worker in workerd (the Cloudflare runtime) and checks it boots
// and routes. It sends no API key, so it never touches the database. Run with: npm run smoke
import { unstable_startWorker } from "wrangler";

const worker = await unstable_startWorker({ config: "wrangler.jsonc", dev: { server: { port: 0 }, inspector: false } });
let failed = false;
const expect = (label: string, actual: number, wanted: number) => {
  const ok = actual === wanted;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (wanted ${wanted})`}`);
};

try {
  await worker.ready;
  const base = await worker.url;
  const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
  expect("POST /mcp without a key", (await fetch(new URL("/mcp", base), post)).status, 401);
  expect("GET /api/services without a key", (await fetch(new URL("/api/services", base))).status, 401);
  expect("GET /unknown", (await fetch(new URL("/unknown", base))).status, 404);
} finally {
  await worker.dispose();
}
if (failed) throw new Error("Smoke test failed.");
