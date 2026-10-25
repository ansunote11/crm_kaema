-- ============================================================
-- 060_evolution_provider
--
-- Adds the Evolution API (Baileys) as a second WhatsApp provider.
-- Each account uses ONE provider at a time, decided by
-- whatsapp_config.provider ('meta' default | 'evolution').
--
-- Evolution credentials are per-account (not env vars):
--   - evolution_server_url   origin of the Evolution server
--   - evolution_instance     instance name
--   - evolution_api_key      AES-256-GCM-encrypted apikey (own column so
--                            the Meta code paths never read it)
--   - evolution_webhook_token_hash
--                            SHA-256 hex of the random token embedded in
--                            the inbound webhook path. Evolution does not
--                            sign payloads; the token IS the routing key
--                            and the authentication.
--   - evolution_webhook_set_at
--                            NULL = webhook not registered yet.
--
-- Meta credentials become nullable (an Evolution row has none); a CHECK
-- enforces the per-provider shape instead.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS evolution_server_url TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance TEXT,
  ADD COLUMN IF NOT EXISTS evolution_api_key TEXT,
  ADD COLUMN IF NOT EXISTS evolution_webhook_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS evolution_webhook_set_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'evolution'));

-- Meta-only credentials: an Evolution row carries none of them. The
-- UNIQUE(phone_number_id) from migration 013 survives because Postgres
-- allows many NULLs.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- Per-provider shape guard. NOT VALID would hide a bad existing row, so
-- it is validated: every pre-060 row is provider='meta' with both Meta
-- credentials (they were NOT NULL until a moment ago).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_shape_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_shape_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL)
    OR
    (provider = 'evolution'
      AND evolution_server_url IS NOT NULL
      AND evolution_instance IS NOT NULL
      AND evolution_api_key IS NOT NULL)
  );

-- One account per Evolution instance (a shared instance would leak
-- conversations across tenants).
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_instance
  ON whatsapp_config (evolution_server_url, evolution_instance)
  WHERE provider = 'evolution';

-- The token hash is the inbound routing key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_token_hash
  ON whatsapp_config (evolution_webhook_token_hash)
  WHERE evolution_webhook_token_hash IS NOT NULL;
