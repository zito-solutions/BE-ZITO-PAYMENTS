-- TASK-396: contas conectadas do Mercado Pago (OAuth da lojista) e states do OAuth (so acrescenta)
CREATE TABLE IF NOT EXISTS payments.connected_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES payments.projects(id),
  account_ref      TEXT NOT NULL,
  gateway          TEXT NOT NULL DEFAULT 'mercadopago',
  status           TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'expired')),
  mp_user_id       TEXT,
  access_token     TEXT, -- cifrado (AES-256-CBC, ENCRYPTION_KEY)
  refresh_token    TEXT, -- cifrado
  public_key       TEXT,
  expires_at       TIMESTAMPTZ,
  connected_at     TIMESTAMPTZ,
  disconnected_at  TIMESTAMPTZ,
  last_refresh_at  TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, account_ref)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_mp_user ON payments.connected_accounts (mp_user_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_renovar ON payments.connected_accounts (status, expires_at);

CREATE TABLE IF NOT EXISTS payments.oauth_states (
  state        TEXT PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES payments.projects(id),
  account_ref  TEXT NOT NULL,
  return_url   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON payments.connected_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON payments.oauth_states TO service_role;
