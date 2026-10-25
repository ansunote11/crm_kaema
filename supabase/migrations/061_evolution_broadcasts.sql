-- ============================================================
-- 061_evolution_broadcasts
--
-- Free-text campaigns for the Evolution provider (no templates).
-- They reuse `broadcasts` / `broadcast_recipients` so the list, the
-- detail page, the reply tracking and the aggregate trigger keep
-- working, and add what a PACED sender needs:
--
--   channel              'template' (Meta, default) | 'evolution_text'
--   message_text/link/image_url
--                        the message (text, optional link, optional image)
--   pacing               JSONB — min/max delay, per-minute and per-hour
--                        caps, failure threshold (see
--                        src/lib/whatsapp/evolution-broadcast-rules.ts)
--   next_send_at         when the next recipient may be sent
--   pause_reason         why a campaign is 'paused' ('manual', or the
--                        failure that tripped the automatic pause)
--   consecutive_failures failures in a row; reset on every success
--
-- and a new `paused` status. delivery_locked_at (migration 038) is
-- reused as the per-campaign send mutex.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'template',
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS message_link TEXT,
  ADD COLUMN IF NOT EXISTS message_image_url TEXT,
  ADD COLUMN IF NOT EXISTS pacing JSONB,
  ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pause_reason TEXT,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_channel_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_channel_check
  CHECK (channel IN ('template', 'evolution_text'));

-- 'paused' joins the status set (001 declared it inline, so Postgres
-- named it broadcasts_status_check).
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'failed'));

-- The runner looks for campaigns that are due.
CREATE INDEX IF NOT EXISTS idx_broadcasts_evolution_due
  ON broadcasts (next_send_at)
  WHERE channel = 'evolution_text' AND status = 'sending';

-- The per-minute / per-hour caps look at recent sends across the whole
-- account's recipients.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sent_at
  ON broadcast_recipients (sent_at)
  WHERE sent_at IS NOT NULL;
