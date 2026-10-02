import { Hono, type Context } from "hono";
import { z } from "zod";

import { hasScope, type Principal, type Scope } from "./auth.ts";
import type { Db } from "./db.ts";
import { authorizeRequest, rateLimitedResponse } from "./ratelimit.ts";
import {
  cancelBooking,
  confirmBooking,
  findBookingsByEmail,
  getBooking,
  holdSlot,
  rescheduleBooking,
} from "./domain/bookings.ts";
import { listServices, searchAvailability } from "./domain/catalog.ts";
import { DomainError, type DomainErrorCode } from "./domain/errors.ts";

export interface ApiDeps {
  db: Db;
  /** Injected so tests can control time. */
  now?: () => Date;
}

type Env = { Variables: { principal: Principal } };

const STATUS_BY_CODE: Record<DomainErrorCode, 400 | 404 | 409 | 410 | 422> = {
  invalid_input: 400,
  not_found: 404,
  slot_unavailable: 409,
  invalid_state: 409,
  hold_expired: 410,
  policy_violation: 422,
};

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const holdBody = z.object({
  serviceId: id,
  start: instant,
  customerName: z.string().trim().min(1).max(120),
  customerEmail: z.email().max(254),
});
const rescheduleBody = z.object({ start: instant });
const availabilityQuery = z.object({ from: z.iso.date(), to: z.iso.date() });
const idempotencyKey = z.string().min(8).max(200);

export function createApi({ db, now = () => new Date() }: ApiDeps) {
  const app = new Hono<Env>().basePath("/api");

  app.onError((error, c) => {
    if (error instanceof ForbiddenError) {
      return c.json({ error: { code: "forbidden", message: "This API key is read-only." } }, 403);
    }
    if (error instanceof DomainError) {
      return c.json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
    }
    // Unexpected failures are logged server-side; clients get no internals.
    console.error("Unhandled API error", error);
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });

  app.use("*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const auth = header.startsWith("Bearer ") ? await authorizeRequest(db, header.slice(7), now()) : null;
    if (!auth) {
      return c.json({ error: { code: "unauthorized", message: "Missing or invalid API key." } }, 401);
    }
    if (!auth.limit.ok) return rateLimitedResponse(auth.limit);
    c.set("principal", auth.principal);
    await next();
  });

  const tenant = (c: Context<Env>, scope: Scope) => {
    const principal = c.get("principal");
    if (!hasScope(principal, scope)) throw new ForbiddenError();
    return principal.tenantId;
  };

  app.get("/services", async (c) => c.json({ services: await listServices(db, tenant(c, "read")) }));

  app.get("/services/:serviceId/availability", async (c) => {
    const serviceId = parse(id, c.req.param("serviceId"));
    const query = parse(availabilityQuery, c.req.query());
    const slots = await searchAvailability(db, tenant(c, "read"), { serviceId, ...query }, now());
    return c.json({ slots });
  });

  // Write scope: a read-only key shouldn't list someone's bookings from their email address.
  app.get("/bookings", async (c) => {
    const tenantId = tenant(c, "write");
    const email = parse(z.email(), c.req.query("email"));
    return c.json({ bookings: await findBookingsByEmail(db, tenantId, email) });
  });

  app.get("/bookings/:bookingId", async (c) => {
    const bookingId = parse(id, c.req.param("bookingId"));
    return c.json({ booking: await getBooking(db, tenant(c, "read"), bookingId) });
  });

  app.post("/holds", async (c) => {
    const tenantId = tenant(c, "write");
    const key = parse(idempotencyKey, c.req.header("Idempotency-Key"), "Idempotency-Key header");
    const body = parse(holdBody, await readJson(c));
    const booking = await holdSlot(db, tenantId, { ...body, idempotencyKey: key }, now());
    return c.json({ booking }, 201);
  });

  app.post("/bookings/:bookingId/confirm", async (c) => {
    const tenantId = tenant(c, "write");
    const bookingId = parse(id, c.req.param("bookingId"));
    return c.json({ booking: await confirmBooking(db, tenantId, bookingId, now()) });
  });

  app.post("/bookings/:bookingId/reschedule", async (c) => {
    const tenantId = tenant(c, "write");
    const bookingId = parse(id, c.req.param("bookingId"));
    const { start } = parse(rescheduleBody, await readJson(c));
    return c.json({ booking: await rescheduleBooking(db, tenantId, { bookingId, start }, now()) });
  });

  app.post("/bookings/:bookingId/cancel", async (c) => {
    const tenantId = tenant(c, "write");
    const bookingId = parse(id, c.req.param("bookingId"));
    return c.json({ booking: await cancelBooking(db, tenantId, bookingId, now()) });
  });

  return app;
}

class ForbiddenError extends Error {}

function parse<T>(schema: z.ZodType<T>, value: unknown, label?: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = label ?? (issue?.path.length ? issue.path.join(".") : "input");
  throw new DomainError("invalid_input", `Invalid ${where}: ${issue?.message ?? "bad value"}.`);
}

async function readJson(c: Context<Env>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("invalid_input", "Request body must be valid JSON.");
  }
}
