'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pause, Play, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { Broadcast } from '@/types';
import { pacingFromRow } from '@/lib/whatsapp/evolution-broadcast-rules';
import { Button } from '@/components/ui/button';

interface Props {
  broadcast: Broadcast;
  failedCount: number;
  /** Reload the campaign + recipients. */
  onChanged: () => void;
}

type Tick = { state: string; nextInMs: number; reason?: string };

/**
 * Operator panel for a free-text (Evolution) campaign: shows the message
 * and limits, lets the user pause / resume / retry failures, and — while
 * the page is open — keeps the paced sender moving. The server also
 * drives the campaign by itself on a long-lived host, so closing the tab
 * does not stop it there; this loop just makes it work everywhere.
 */
export function EvolutionCampaignPanel({ broadcast, failedCount, onChanged }: Props) {
  const t = useTranslations('EvolutionBroadcast.panel');
  const [busy, setBusy] = useState<string | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const running = broadcast.status === 'sending';
  const pacing = pacingFromRow(broadcast.pacing);

  // Drive the sender while the page is open.
  useEffect(() => {
    if (!running) {
      setNextAt(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function loop() {
      if (cancelled) return;
      let wait = 5_000;
      try {
        const res = await fetch(`/api/whatsapp/broadcast/${broadcast.id}/tick`, { method: 'POST' });
        if (res.ok) {
          const r = (await res.json()) as Tick;
          if (r.state === 'sent' || r.state === 'failed' || r.state === 'paused' || r.state === 'done') {
            onChangedRef.current();
          }
          if (r.state === 'paused' || r.state === 'done' || r.state === 'inactive') return;
          wait = Math.min(Math.max(r.nextInMs, 1_000), 30_000);
        }
      } catch {
        // Transient network error: try again shortly.
      }
      if (cancelled) return;
      setNextAt(Date.now() + wait);
      timer = setTimeout(loop, wait);
    }
    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, broadcast.id]);

  // Countdown label.
  useEffect(() => {
    if (!nextAt) return;
    const i = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(i);
  }, [nextAt]);

  async function control(action: 'pause' | 'resume' | 'retry_failed') {
    setBusy(action);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcast.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('actionFailed'));
        return;
      }
      onChanged();
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setBusy(null);
    }
  }

  const paused = broadcast.status === 'paused';
  const manual = broadcast.pause_reason === 'manual';
  const secondsLeft = nextAt ? Math.max(0, Math.round((nextAt - now) / 1000)) : null;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium text-foreground">{t('title')}</p>
          <p className="text-muted-foreground">
            {t('limits', {
              perMinute: pacing.per_minute,
              perHour: pacing.per_hour,
              min: pacing.min_delay_seconds,
              max: pacing.max_delay_seconds,
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {running && (
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => control('pause')}>
              {busy === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
              {t('pause')}
            </Button>
          )}
          {paused && (
            <Button size="sm" disabled={busy !== null} onClick={() => control('resume')}>
              {busy === 'resume' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t('resume')}
            </Button>
          )}
          {failedCount > 0 && broadcast.status !== 'sending' && (
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => control('retry_failed')}>
              {busy === 'retry_failed' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              {t('retryFailed', { count: failedCount })}
            </Button>
          )}
        </div>
      </div>

      {paused && (
        <p className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-orange-200">
          {manual ? t('pausedManual') : t('pausedAuto', { reason: broadcast.pause_reason ?? '' })}
        </p>
      )}
      {running && secondsLeft !== null && (
        <p className="text-sm text-muted-foreground">{t('nextIn', { seconds: secondsLeft })}</p>
      )}

      <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-sm">
        {[broadcast.message_text, broadcast.message_link].filter(Boolean).join('\n\n')}
        {broadcast.message_image_url && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={broadcast.message_image_url} alt="" className="mt-2 max-h-40 rounded" />
          </>
        )}
      </div>
    </div>
  );
}
