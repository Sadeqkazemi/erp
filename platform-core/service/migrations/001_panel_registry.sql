CREATE TABLE panel_registry (
  tenant_id text NOT NULL,
  panel_key text NOT NULL,
  name_fa text NOT NULL,
  name_en text NOT NULL,
  panel_group text NOT NULL CHECK(panel_group IN ('management','operations','employees')),
  owner_service text NOT NULL,
  required_scopes text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY (tenant_id,panel_key),
  CHECK (panel_key <> 'site-admin' OR panel_group = 'employees')
);
CREATE TABLE panel_command_receipts (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  panel_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,idempotency_key)
);
CREATE TABLE panel_audit (
  event_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  panel_key text NOT NULL,
  actor_subject text NOT NULL,
  action text NOT NULL CHECK(action='panel.registered'),
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_panel_audit_tenant_time ON panel_audit(tenant_id,occurred_at DESC);
