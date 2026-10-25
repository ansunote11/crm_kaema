'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';

export type ClientProvider = 'meta' | 'evolution';

/**
 * Which WhatsApp provider the signed-in account uses. Drives which
 * features the UI offers: templates and template campaigns are Meta-only,
 * the free-text campaign is Evolution-only.
 *
 * `provider` stays `null` while loading (and for accounts with no config
 * yet) so callers can avoid flashing the wrong UI.
 */
export function useWhatsAppProvider(): {
  provider: ClientProvider | null;
  loading: boolean;
} {
  const { accountId } = useAuth();
  const [provider, setProvider] = useState<ClientProvider | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', accountId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setProvider(
          data ? (data.provider === 'evolution' ? 'evolution' : 'meta') : null,
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { provider, loading };
}
