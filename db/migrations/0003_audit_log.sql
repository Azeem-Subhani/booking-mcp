-- One row per MCP tool call: who called which tool with what (PII redacted), and the outcome.
-- Keys are revoked, never deleted, so the foreign keys don't cascade: the trail outlives the key.
-- Rows older than 30 days are pruned by the nightly reset.

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  key_id      uuid NOT NULL REFERENCES api_keys (id),
  tool        text NOT NULL,
  inputs      jsonb NOT NULL,
  -- 'ok', a domain error code (e.g. slot_unavailable), or 'internal'.
  result_code text NOT NULL,
  duration_ms integer NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at);
