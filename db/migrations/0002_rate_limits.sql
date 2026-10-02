-- Per-key rate limits: a per-minute limit on every key, plus an optional daily cap (used for the
-- public demo key). Counters are fixed windows keyed by their UTC start time, which the app passes
-- in, so nothing depends on the session TimeZone. Old rows are pruned by the nightly reset.

ALTER TABLE api_keys
  ADD COLUMN rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute > 0),
  ADD COLUMN daily_limit           integer CHECK (daily_limit > 0);

CREATE TABLE api_key_usage (
  key_id       uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  -- A day window and the first minute window of that day share a start time, so kind is in the key.
  kind         text NOT NULL CHECK (kind IN ('minute', 'day')),
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key_id, kind, window_start)
);
