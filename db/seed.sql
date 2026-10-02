-- Demo data for the public sandbox. Fictional business, no real customers.
-- API keys are not seeded here; create them with createApiKey() so only hashes are stored.

WITH tenant AS (
  INSERT INTO tenants (slug, name, time_zone, cancellation_notice_hours)
  VALUES ('northside', 'Northside Studio', 'America/New_York', 24)
  RETURNING id
),
maya AS (
  INSERT INTO resources (tenant_id, name, kind) SELECT id, 'Maya Chen (yoga)', 'instructor' FROM tenant RETURNING id, tenant_id
),
dev AS (
  INSERT INTO resources (tenant_id, name, kind) SELECT id, 'Dev Patel (strength)', 'instructor' FROM tenant RETURNING id, tenant_id
),
svc AS (
  INSERT INTO services (tenant_id, resource_id, name, description, duration_minutes, price_cents)
  SELECT tenant_id, id, 'Private yoga', 'One-on-one session tailored to your level.', 60, 7500 FROM maya
  UNION ALL
  SELECT tenant_id, id, 'Mobility check-in', 'A short assessment and stretch plan.', 30, 4000 FROM maya
  UNION ALL
  SELECT tenant_id, id, 'Personal training', 'Strength session with a coach.', 60, 9000 FROM dev
  RETURNING id
)
INSERT INTO opening_hours (resource_id, weekday, opens, closes)
SELECT id, d, '07:00'::time, '12:00'::time FROM maya, generate_series(1, 5) d
UNION ALL
SELECT id, d, '14:00'::time, '19:00'::time FROM dev, generate_series(1, 6) d;
