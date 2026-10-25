// ============================================================
// Free-text campaigns over the Evolution provider — pure rules.
//
// Sending in bulk over an unofficial WhatsApp connection is what gets
// numbers banned, so every send is paced: a random delay between
// messages, a per-minute and a per-hour cap, and an automatic pause
// when sends start failing. Nothing here touches the network or the
// database, which keeps the policy unit-testable.
// ============================================================

export interface Pacing {
  /** Shortest wait between two messages, seconds. */
  min_delay_seconds: number
  /** Longest wait between two messages, seconds. */
  max_delay_seconds: number
  /** Max messages in any rolling 60 seconds (whole account). */
  per_minute: number
  /** Max messages in any rolling hour (whole account). */
  per_hour: number
  /** Pause the campaign after this many failures in a row. */
  max_consecutive_failures: number
}

export const DEFAULT_PACING: Pacing = {
  min_delay_seconds: 8,
  max_delay_seconds: 25,
  per_minute: 4,
  per_hour: 120,
  max_consecutive_failures: 3,
}

export const LIMITS = {
  MIN_DELAY_FLOOR_SECONDS: 3,
  MAX_DELAY_CEILING_SECONDS: 3600,
  PER_MINUTE_MAX: 30,
  PER_HOUR_MAX: 1000,
  FAILURES_MAX: 10,
  TEXT_MAX: 4096,
  /** WhatsApp caps image captions at 1024 characters. */
  CAPTION_MAX: 1024,
  RECIPIENTS_MAX: 5000,
} as const

function int(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

/**
 * Merge user input over the defaults and validate it. Returns an error
 * string (the first problem found) instead of throwing.
 */
export function validatePacing(
  input: Partial<Record<keyof Pacing, unknown>> | null | undefined,
): { ok: true; pacing: Pacing } | { ok: false; error: string } {
  const src = input ?? {}
  const pick = (k: keyof Pacing): number | null | 'bad' => {
    if (src[k] === undefined || src[k] === null || src[k] === '') return DEFAULT_PACING[k]
    const n = int(src[k])
    return n === null ? 'bad' : n
  }
  const min = pick('min_delay_seconds')
  const max = pick('max_delay_seconds')
  const perMinute = pick('per_minute')
  const perHour = pick('per_hour')
  const failures = pick('max_consecutive_failures')
  if ([min, max, perMinute, perHour, failures].some((v) => v === 'bad' || v === null)) {
    return { ok: false, error: 'Pacing values must be whole numbers' }
  }
  const p: Pacing = {
    min_delay_seconds: min as number,
    max_delay_seconds: max as number,
    per_minute: perMinute as number,
    per_hour: perHour as number,
    max_consecutive_failures: failures as number,
  }
  if (p.min_delay_seconds < LIMITS.MIN_DELAY_FLOOR_SECONDS) {
    return {
      ok: false,
      error: `Minimum delay must be at least ${LIMITS.MIN_DELAY_FLOOR_SECONDS} seconds`,
    }
  }
  if (p.max_delay_seconds < p.min_delay_seconds) {
    return { ok: false, error: 'Maximum delay must be greater than or equal to the minimum' }
  }
  if (p.max_delay_seconds > LIMITS.MAX_DELAY_CEILING_SECONDS) {
    return { ok: false, error: `Maximum delay cannot exceed ${LIMITS.MAX_DELAY_CEILING_SECONDS} seconds` }
  }
  if (p.per_minute < 1 || p.per_minute > LIMITS.PER_MINUTE_MAX) {
    return { ok: false, error: `Per-minute limit must be between 1 and ${LIMITS.PER_MINUTE_MAX}` }
  }
  if (p.per_hour < 1 || p.per_hour > LIMITS.PER_HOUR_MAX) {
    return { ok: false, error: `Per-hour limit must be between 1 and ${LIMITS.PER_HOUR_MAX}` }
  }
  if (p.per_hour < p.per_minute) {
    return { ok: false, error: 'Per-hour limit must be at least the per-minute limit' }
  }
  if (p.max_consecutive_failures < 1 || p.max_consecutive_failures > LIMITS.FAILURES_MAX) {
    return { ok: false, error: `Failure threshold must be between 1 and ${LIMITS.FAILURES_MAX}` }
  }
  return { ok: true, pacing: p }
}

/** Parse a stored `broadcasts.pacing` blob, falling back to defaults. */
export function pacingFromRow(raw: unknown): Pacing {
  const r = validatePacing(raw as Partial<Record<keyof Pacing, unknown>>)
  return r.ok ? r.pacing : DEFAULT_PACING
}

/** Random wait in ms, inclusive of both ends. `rng` is injectable. */
export function randomDelayMs(pacing: Pacing, rng: () => number = Math.random): number {
  const span = pacing.max_delay_seconds - pacing.min_delay_seconds
  return Math.round((pacing.min_delay_seconds + rng() * span) * 1000)
}

/**
 * How long until another message may go out, given the send times seen
 * in the last hour (any order). 0 means "go now".
 */
export function rateLimitWaitMs(
  sentAtMs: readonly number[],
  now: number,
  pacing: Pick<Pacing, 'per_minute' | 'per_hour'>,
): number {
  const sorted = [...sentAtMs].filter((t) => t > now - 3_600_000).sort((a, b) => b - a)
  let wait = 0
  // The cap-th most recent send is the one that must age out of the window.
  const minuteBlocker = sorted[pacing.per_minute - 1]
  if (minuteBlocker !== undefined && minuteBlocker > now - 60_000) {
    wait = Math.max(wait, minuteBlocker + 60_000 - now)
  }
  const hourBlocker = sorted[pacing.per_hour - 1]
  if (hourBlocker !== undefined) {
    wait = Math.max(wait, hourBlocker + 3_600_000 - now)
  }
  return Math.max(0, wait)
}

export interface CampaignMessage {
  text: string
  link?: string | null
  imageUrl?: string | null
}

/** Reasons a campaign message is rejected before anything is created. */
export function validateCampaignMessage(
  m: CampaignMessage,
): { ok: true } | { ok: false; error: string } {
  const text = m.text?.trim() ?? ''
  const link = m.link?.trim() ?? ''
  const image = m.imageUrl?.trim() ?? ''
  if (!text && !link && !image) {
    return { ok: false, error: 'The message needs text, a link or an image' }
  }
  for (const [label, url] of [['link', link], ['image', image]] as const) {
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      return { ok: false, error: `The ${label} must be a valid http(s) URL` }
    }
  }
  const body = composeText(text, link)
  if (image && body.length > LIMITS.CAPTION_MAX) {
    return { ok: false, error: `With an image the text and link must fit in ${LIMITS.CAPTION_MAX} characters` }
  }
  if (body.length > LIMITS.TEXT_MAX) {
    return { ok: false, error: `The message cannot exceed ${LIMITS.TEXT_MAX} characters` }
  }
  return { ok: true }
}

/** Text + link on its own line. */
export function composeText(text: string, link?: string | null): string {
  const parts = [text?.trim() ?? '', link?.trim() ?? ''].filter(Boolean)
  return parts.join('\n\n')
}

/**
 * Personalise: `{{nome}}` / `{{name}}` become the contact's first name
 * (empty when unknown, with the dangling space collapsed).
 */
export function renderForContact(
  template: string,
  contact: { name?: string | null },
): string {
  const first = (contact.name ?? '').trim().split(/\s+/)[0] ?? ''
  const hasPlaceholder = /\{\{\s*(nome|name)\s*\}\}/i.test(template)
  const rendered = template.replace(/\{\{\s*(nome|name)\s*\}\}/gi, first)
  // Only tidy the gap a MISSING name leaves ("Olá , tudo bem"); never
  // touch spacing the author typed on purpose.
  if (first || !hasPlaceholder) return rendered.trim()
  return rendered
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
