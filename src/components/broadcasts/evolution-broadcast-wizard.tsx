'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, Check, ImagePlus, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { countAudience, type AudienceConfig } from '@/lib/broadcast-audience';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import {
  DEFAULT_PACING,
  LIMITS,
  composeText,
  validateCampaignMessage,
  validatePacing,
  type Pacing,
} from '@/lib/whatsapp/evolution-broadcast-rules';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Step = 0 | 1 | 2;
const STEP_KEYS = ['message', 'audience', 'send'] as const;

/**
 * Free-text campaign for accounts on the Evolution provider: text, an
 * optional link and an optional image, sent one by one at a human pace.
 * Templates do not exist on this provider, so the template wizard is not
 * used.
 */
export function EvolutionBroadcastWizard() {
  const t = useTranslations('EvolutionBroadcast');
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [pacing, setPacing] = useState<Record<keyof Pacing, string>>({
    min_delay_seconds: String(DEFAULT_PACING.min_delay_seconds),
    max_delay_seconds: String(DEFAULT_PACING.max_delay_seconds),
    per_minute: String(DEFAULT_PACING.per_minute),
    per_hour: String(DEFAULT_PACING.per_hour),
    max_consecutive_failures: String(DEFAULT_PACING.max_consecutive_failures),
  });
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  // The audience step counts internally; repeat the count for the summary.
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    countAudience(createClient(), audience)
      .then((n) => !cancelled && setRecipientCount(n))
      .catch(() => !cancelled && setRecipientCount(null));
    return () => {
      cancelled = true;
    };
  }, [step, audience]);

  const messageCheck = validateCampaignMessage({ text, link, imageUrl });
  const pacingCheck = validatePacing(pacing);
  const preview = composeText(text, link);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('imageOnly'));
      return;
    }
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t('imageTooLarge'));
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      setImageUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('imageUploadFailed'));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function handleStart() {
    if (!messageCheck.ok || !pacingCheck.ok) return;
    setStarting(true);
    try {
      const res = await fetch('/api/whatsapp/broadcast/evolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          message_text: text,
          message_link: link,
          message_image_url: imageUrl,
          audience,
          pacing: pacingCheck.pacing,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('startFailed'));
        return;
      }
      toast.success(t('started', { count: data.total_recipients }));
      router.push(`/broadcasts/${data.broadcast_id}`);
    } catch {
      toast.error(t('startFailed'));
    } finally {
      setStarting(false);
    }
  }

  const avgDelay = pacingCheck.ok
    ? (pacingCheck.pacing.min_delay_seconds + pacingCheck.pacing.max_delay_seconds) / 2
    : null;
  // The slowest of the three limits decides the real pace.
  const secondsPerMessage = pacingCheck.ok && avgDelay !== null
    ? Math.max(avgDelay, 60 / pacingCheck.pacing.per_minute, 3600 / pacingCheck.pacing.per_hour)
    : null;
  const estimateMinutes =
    recipientCount && secondsPerMessage ? Math.ceil((recipientCount * secondsPerMessage) / 60) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex items-center gap-3">
        {STEP_KEYS.map((key, index) => (
          <div key={key} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
                index < step
                  ? 'bg-primary text-primary-foreground'
                  : index === step
                    ? 'border-2 border-primary bg-primary/10 text-primary'
                    : 'border border-border bg-muted text-muted-foreground'
              }`}
            >
              {index < step ? <Check className="h-4 w-4" /> : index + 1}
            </div>
            <span className="hidden text-sm font-medium sm:block">{t(`steps.${key}`)}</span>
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label>{t('name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </div>

          <div className="space-y-2">
            <Label>{t('text')}</Label>
            <Textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('textPlaceholder')}
              maxLength={LIMITS.TEXT_MAX}
            />
            <p className="text-xs text-muted-foreground">{t('textHint')}</p>
          </div>

          <div className="space-y-2">
            <Label>{t('link')}</Label>
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
          </div>

          <div className="space-y-2">
            <Label>{t('image')}</Label>
            {imageUrl ? (
              <div className="flex items-center gap-3 rounded-md border border-border p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt="" className="h-16 w-16 rounded object-cover" />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{imageUrl}</span>
                <Button type="button" variant="ghost" size="icon" onClick={() => setImageUrl('')} aria-label={t('imageRemove')}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                />
                <Button type="button" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                  {uploading ? t('imageUploading') : t('imageUpload')}
                </Button>
                <Input
                  className="min-w-[14rem] flex-1"
                  placeholder={t('imageUrlPlaceholder')}
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                />
              </div>
            )}
          </div>

          {preview && (
            <div className="space-y-1">
              <Label>{t('preview')}</Label>
              <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-sm">
                {preview}
              </div>
            </div>
          )}

          {!messageCheck.ok && (text || link || imageUrl) && (
            <p className="text-sm text-red-400">{messageCheck.error}</p>
          )}

          <div className="flex justify-end">
            <Button disabled={!name.trim() || !messageCheck.ok} onClick={() => setStep(1)}>
              {t('next')}
            </Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <Step2SelectAudience
          audience={audience}
          onUpdate={setAudience}
          onNext={() => setStep(2)}
          onBack={() => setStep(0)}
        />
      )}

      {step === 2 && (
        <div className="space-y-5">
          <Alert className="border-amber-600/40 bg-amber-950/30">
            <AlertTriangle className="size-4 text-amber-400" />
            <AlertDescription className="text-amber-100/90">{t('riskNote')}</AlertDescription>
          </Alert>

          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('pacingTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('pacingHint')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ['min_delay_seconds', 'minDelay'],
                ['max_delay_seconds', 'maxDelay'],
                ['per_minute', 'perMinute'],
                ['per_hour', 'perHour'],
                ['max_consecutive_failures', 'maxFailures'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-2">
                <Label>{t(label)}</Label>
                <Input
                  inputMode="numeric"
                  value={pacing[key]}
                  onChange={(e) => setPacing((p) => ({ ...p, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          {!pacingCheck.ok && <p className="text-sm text-red-400">{pacingCheck.error}</p>}

          <div className="rounded-lg border border-border p-4 text-sm">
            <p className="font-medium text-foreground">{name}</p>
            {recipientCount !== null && (
              <p className="text-muted-foreground">{t('summaryRecipients', { count: recipientCount })}</p>
            )}
            {estimateMinutes !== null && (
              <p className="text-muted-foreground">{t('summaryEstimate', { minutes: estimateMinutes })}</p>
            )}
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)} disabled={starting}>
              {t('back')}
            </Button>
            <Button onClick={handleStart} disabled={starting || !pacingCheck.ok || !messageCheck.ok}>
              {starting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('starting')}
                </>
              ) : (
                t('start')
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
