-- Initial schema: tenants, API keys, bookable resources, services, opening hours, bookings.
-- All instants are timestamptz in UTC; local wall-clock times only appear in opening_hours
-- and are converted with the tenant's IANA time zone. Never rely on the session TimeZone.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE tenants (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      text NOT NULL UNIQUE,
  name                      text NOT NULL,
  time_zone                 text NOT NULL,
  -- Confirmed bookings can't be cancelled or rescheduled inside this window.
  cancellation_notice_hours integer NOT NULL DEFAULT 24 CHECK (cancellation_notice_hours >= 0),
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Only a SHA-256 hash of each key is stored. The raw key is shown once at creation.
CREATE TABLE api_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key_hash   text NOT NULL UNIQUE,
  scope      text NOT NULL CHECK (scope IN ('read', 'write')),
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- An instructor or room. Each resource can serve one booking at a time.
CREATE TABLE resources (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name      text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('instructor', 'room'))
);

CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  resource_id      uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  price_cents      integer NOT NULL CHECK (price_cents >= 0),
  currency         text NOT NULL DEFAULT 'usd',
  active           boolean NOT NULL DEFAULT true
);

-- Weekly hours in the tenant's local time. weekday follows extract(dow): 0 = Sunday.
CREATE TABLE opening_hours (
  resource_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens       time NOT NULL,
  closes      time NOT NULL,
  PRIMARY KEY (resource_id, weekday, opens),
  CHECK (closes > opens)
);

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  service_id      uuid NOT NULL REFERENCES services (id),
  resource_id     uuid NOT NULL REFERENCES resources (id),
  customer_name   text NOT NULL,
  customer_email  text NOT NULL,
  period          tstzrange NOT NULL CHECK (NOT isempty(period)),
  status          text NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
  hold_expires_at timestamptz,
  -- Lets a client retry "create hold" safely: the same key returns the same booking.
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
  -- The database, not application code, guarantees a resource is never double-booked.
  -- Stale holds are flipped to 'expired' before inserts so they stop blocking.
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (resource_id WITH =, period WITH &&)
    WHERE (status IN ('held', 'confirmed'))
);

CREATE INDEX bookings_tenant_email_idx ON bookings (tenant_id, lower(customer_email));
