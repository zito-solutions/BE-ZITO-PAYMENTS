-- TASK-387: callback assinado por projeto e fila de entregas com retry (so acrescenta)
-- O segredo usa gen_random_uuid() (nucleo do Postgres) em vez de pgcrypto/gen_random_bytes,
-- que no Supabase mora no schema extensions e pode nao estar no search_path da migracao.
ALTER TABLE payments.projects
  ADD COLUMN IF NOT EXISTS callback_secret TEXT DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

UPDATE payments.projects
  SET callback_secret = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE callback_secret IS NULL;

ALTER TABLE payments.projects ALTER COLUMN callback_secret SET NOT NULL;

CREATE TABLE IF NOT EXISTS payments.callback_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL UNIQUE REFERENCES payments.payment_events(id),
  project_id       UUID NOT NULL REFERENCES payments.projects(id),
  status           TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'delivered' | 'failed'
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code INT,
  last_error       TEXT,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_callback_deliveries_fila
  ON payments.callback_deliveries (status, next_attempt_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON payments.callback_deliveries TO service_role;
