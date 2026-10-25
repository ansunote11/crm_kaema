'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_KEY = '••••••••••••••••';

type LinkState = {
  connected: boolean;
  connectionState?: string;
  webhookRegistered?: boolean;
  message?: string;
};

interface Props {
  /** Saved row, when the account is already on Evolution. */
  config: WhatsAppConfigType | null;
  canEdit: boolean;
  /** Reload the parent after a save / reset. */
  onChanged: () => void;
}

/**
 * Evolution API connection form. Credentials are per-account: the apikey
 * is stored encrypted server-side and never returned, so the field shows
 * a mask and a blank save keeps the stored key.
 */
export function EvolutionConfigPanel({ config, canEdit, onChanged }: Props) {
  const t = useTranslations('Settings.whatsapp');
  const saved = config?.provider === 'evolution';

  const [serverUrl, setServerUrl] = useState(config?.evolution_server_url ?? '');
  const [instance, setInstance] = useState(config?.evolution_instance ?? '');
  const [apiKey, setApiKey] = useState(saved ? MASKED_KEY : '');
  const [keyEdited, setKeyEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [link, setLink] = useState<LinkState | null>(null);

  const checkLink = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const p = await res.json();
      setLink({
        connected: !!p.connected,
        connectionState: p.connection_state,
        webhookRegistered: p.webhook_registered,
        message: p.message,
      });
    } catch {
      setLink({ connected: false });
    }
  }, []);

  useEffect(() => {
    if (saved) checkLink();
  }, [saved, checkLink]);

  async function handleSave() {
    if (!serverUrl.trim() || !instance.trim() || (!keyEdited && !saved) || (keyEdited && !apiKey.trim())) {
      toast.error(t('evolutionRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'evolution',
          evolution_server_url: serverUrl.trim(),
          evolution_instance: instance.trim(),
          // Blank = keep the stored key (the server never returns it).
          evolution_api_key: keyEdited ? apiKey.trim() : '',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('saveFailed'), { duration: 10000 });
        return;
      }
      if (data.webhook_error) {
        toast.warning(t('evolutionWebhookFailed', { error: data.webhook_error }), {
          duration: 12000,
        });
      } else if (data.connection_state === 'open') {
        toast.success(t('evolutionSaved'));
      } else {
        toast.info(t('evolutionSavedNotOpen'), { duration: 10000 });
      }
      setKeyEdited(false);
      setApiKey(MASKED_KEY);
      onChanged();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirm(t('resetConfirm'))) return;
    setResetting(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('resetFailed'));
        return;
      }
      toast.success(t('resetDone'));
      setServerUrl('');
      setInstance('');
      setApiKey('');
      setKeyEdited(false);
      setLink(null);
      onChanged();
    } catch {
      toast.error(t('resetFailed'));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-6">
      {saved && link && (
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {link.connected ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {link.connected ? t('evolutionConnected') : t('evolutionNotConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {link.webhookRegistered ? t('evolutionWebhookOk') : t('evolutionWebhookMissing')}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('evolutionTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('evolutionDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('evolutionServerUrl')}</Label>
            <Input
              placeholder={t('evolutionServerUrlPlaceholder')}
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              disabled={!canEdit}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('evolutionInstance')}</Label>
            <Input
              placeholder={t('evolutionInstancePlaceholder')}
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
              disabled={!canEdit}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('evolutionApiKey')}</Label>
            <Input
              type="password"
              placeholder={t('evolutionApiKeyPlaceholder')}
              value={apiKey}
              onFocus={() => {
                if (!keyEdited && apiKey === MASKED_KEY) setApiKey('');
              }}
              onChange={(e) => {
                setKeyEdited(true);
                setApiKey(e.target.value);
              }}
              disabled={!canEdit}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            {saved && !keyEdited && (
              <p className="text-xs text-muted-foreground">{t('evolutionApiKeySaved')}</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('evolutionCapabilities')}</p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button
          onClick={handleSave}
          disabled={saving || !canEdit}
          className="bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t('saving')}
            </>
          ) : (
            t('evolutionSave')
          )}
        </Button>
        {saved && (
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={resetting || !canEdit}
            className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
          >
            {resetting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('resetting')}
              </>
            ) : (
              <>
                <RotateCcw className="size-4" />
                {t('resetConfig')}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
