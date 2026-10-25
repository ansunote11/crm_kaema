// ============================================================
// WhatsApp provider factory.
//
// `whatsapp_config.provider` ('meta' default | 'evolution') decides the
// backend per account. EVERY outbound send goes through
// `resolveSendProvider(config)` — no call-site may import the Meta or
// Evolution client directly. Inbound from both providers converges on
// the shared pipeline in `inbound-pipeline.ts`.
//
// Templates, broadcasts and the 24h session window are Meta-only and
// are NOT part of the SendProvider contract: call-sites check
// PROVIDER_CAPABILITIES first.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import * as meta from '@/lib/whatsapp/meta-api'
import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '@/lib/whatsapp/meta-api'
import * as evolution from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export type WhatsAppProvider = 'meta' | 'evolution'

/** Row shape the factory needs (a superset is fine). */
export interface ProviderConfigRow {
  provider?: string | null
  phone_number_id?: string | null
  access_token?: string | null
  evolution_server_url?: string | null
  evolution_instance?: string | null
  evolution_api_key?: string | null
}

export const PROVIDER_CAPABILITIES: Record<
  WhatsAppProvider,
  { templates: boolean; broadcasts: boolean; sessionWindow: boolean }
> = {
  meta: { templates: true, broadcasts: true, sessionWindow: true },
  evolution: { templates: false, broadcasts: false, sessionWindow: false },
}

/** Anything that isn't exactly 'evolution' (incl. pre-060 rows) is Meta. */
export function configProvider(
  config: { provider?: string | null } | null | undefined,
): WhatsAppProvider {
  return config?.provider === 'evolution' ? 'evolution' : 'meta'
}

export function supportsTemplates(
  config: { provider?: string | null } | null | undefined,
): boolean {
  return PROVIDER_CAPABILITIES[configProvider(config)].templates
}

export function supportsBroadcasts(
  config: { provider?: string | null } | null | undefined,
): boolean {
  return PROVIDER_CAPABILITIES[configProvider(config)].broadcasts
}

export interface SendProvider {
  kind: WhatsAppProvider
  sendText(args: {
    to: string
    text: string
    contextMessageId?: string
  }): Promise<{ messageId: string }>
  sendMedia(args: {
    to: string
    kind: MediaKind
    link: string
    caption?: string
    filename?: string
    contextMessageId?: string
  }): Promise<{ messageId: string }>
  sendReaction(args: {
    to: string
    targetMessageId: string
    emoji: string
    /** Evolution only: was the reacted-to message sent by us? */
    targetFromMe?: boolean
  }): Promise<{ messageId: string }>
  sendInteractiveButtons(args: {
    to: string
    bodyText: string
    headerText?: string
    footerText?: string
    buttons: InteractiveButton[]
    contextMessageId?: string
  }): Promise<{ messageId: string }>
  sendInteractiveList(args: {
    to: string
    bodyText: string
    buttonLabel: string
    headerText?: string
    footerText?: string
    sections: InteractiveListSection[]
    contextMessageId?: string
  }): Promise<{ messageId: string }>
  /** Best-effort "typing…". Absent for providers without an equivalent. */
  sendTypingIndicator?(args: { messageId: string }): Promise<void>
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
}

/** Decrypted Evolution credentials, or throws when the row lacks them. */
export function evolutionCredsFromConfig(
  config: ProviderConfigRow,
): evolution.EvolutionCreds {
  if (
    !config.evolution_server_url ||
    !config.evolution_instance ||
    !config.evolution_api_key
  ) {
    throw new ProviderConfigError('Evolution API is not fully configured')
  }
  return {
    serverUrl: config.evolution_server_url,
    instance: config.evolution_instance,
    apiKey: decrypt(config.evolution_api_key),
  }
}

/**
 * The single entry point for outbound. Decrypts the credentials and
 * returns a provider bound to the right backend.
 */
export function resolveSendProvider(config: ProviderConfigRow): SendProvider {
  if (configProvider(config) === 'evolution') {
    const creds = evolutionCredsFromConfig(config)
    return {
      kind: 'evolution',
      sendText: ({ to, text, contextMessageId }) =>
        evolution.sendText({ ...creds, to, text, quotedMessageId: contextMessageId }),
      sendMedia: ({ to, kind, link, caption, filename, contextMessageId }) =>
        kind === 'audio'
          ? // PTT voice note: dedicated endpoint, never sendMedia.
            evolution.sendAudio({
              ...creds,
              to,
              audio: link,
              quotedMessageId: contextMessageId,
            })
          : evolution.sendMedia({
              ...creds,
              to,
              mediatype: kind,
              media: link,
              caption,
              fileName: filename,
              quotedMessageId: contextMessageId,
            }),
      sendReaction: ({ to, targetMessageId, emoji, targetFromMe }) =>
        evolution.sendReaction({
          ...creds,
          to,
          targetMessageId,
          emoji,
          fromMe: targetFromMe ?? false,
        }),
      // No text fallback for interactives: a numbered-text fallback would
      // break Flows matching on interactive_reply_id. Errors surface.
      sendInteractiveButtons: ({ to, bodyText, headerText, footerText, buttons }) =>
        evolution.sendButtons({
          ...creds,
          to,
          title: headerText ?? '',
          description: bodyText,
          footer: footerText,
          buttons,
        }),
      sendInteractiveList: ({
        to,
        bodyText,
        buttonLabel,
        headerText,
        footerText,
        sections,
      }) =>
        evolution.sendList({
          ...creds,
          to,
          title: headerText ?? '',
          description: bodyText,
          buttonText: buttonLabel,
          footerText,
          sections,
        }),
    }
  }

  if (!config.phone_number_id || !config.access_token) {
    throw new ProviderConfigError('Meta WhatsApp is not fully configured')
  }
  const phoneNumberId = config.phone_number_id
  const accessToken = decrypt(config.access_token)
  return {
    kind: 'meta',
    sendText: (args) => meta.sendTextMessage({ phoneNumberId, accessToken, ...args }),
    sendMedia: (args) => meta.sendMediaMessage({ phoneNumberId, accessToken, ...args }),
    sendReaction: ({ to, targetMessageId, emoji }) =>
      meta.sendReactionMessage({ phoneNumberId, accessToken, to, targetMessageId, emoji }),
    sendInteractiveButtons: (args) =>
      meta.sendInteractiveButtons({ phoneNumberId, accessToken, ...args }),
    sendInteractiveList: (args) =>
      meta.sendInteractiveList({ phoneNumberId, accessToken, ...args }),
    sendTypingIndicator: ({ messageId }) =>
      meta.sendTypingIndicator({ phoneNumberId, accessToken, messageId }),
  }
}

/** Load the account's config row and resolve its provider. */
export async function loadAccountSendProvider(
  db: SupabaseClient,
  accountId: string,
  notConfiguredMessage = 'WhatsApp is not configured',
): Promise<SendProvider> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select(
      'provider, phone_number_id, access_token, evolution_server_url, evolution_instance, evolution_api_key',
    )
    .eq('account_id', accountId)
    .single()
  if (error || !config) throw new Error(notConfiguredMessage)
  return resolveSendProvider(config)
}
