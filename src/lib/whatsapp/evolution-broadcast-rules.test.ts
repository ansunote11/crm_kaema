import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PACING,
  composeText,
  pacingFromRow,
  randomDelayMs,
  rateLimitWaitMs,
  renderForContact,
  validateCampaignMessage,
  validatePacing,
} from './evolution-broadcast-rules'

describe('validatePacing', () => {
  it('fills defaults and accepts numeric strings from a form', () => {
    expect(validatePacing(undefined)).toEqual({ ok: true, pacing: DEFAULT_PACING })
    const r = validatePacing({ min_delay_seconds: '10', max_delay_seconds: '30', per_minute: '2', per_hour: '50' })
    expect(r).toMatchObject({ ok: true, pacing: { min_delay_seconds: 10, max_delay_seconds: 30, per_minute: 2, per_hour: 50 } })
  })

  it.each([
    [{ min_delay_seconds: 1 }, 'at least'],
    [{ min_delay_seconds: 20, max_delay_seconds: 10 }, 'greater than or equal'],
    [{ max_delay_seconds: 99999 }, 'exceed'],
    [{ per_minute: 0 }, 'Per-minute'],
    [{ per_minute: 31 }, 'Per-minute'],
    [{ per_hour: 5000 }, 'Per-hour'],
    [{ per_minute: 10, per_hour: 5 }, 'at least the per-minute'],
    [{ max_consecutive_failures: 0 }, 'Failure threshold'],
    [{ per_minute: 'abc' }, 'whole numbers'],
    [{ per_minute: 1.5 }, 'whole numbers'],
  ])('rejects %j', (input, fragment) => {
    const r = validatePacing(input)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain(fragment)
  })

  it('pacingFromRow falls back to defaults on garbage', () => {
    expect(pacingFromRow(null)).toEqual(DEFAULT_PACING)
    expect(pacingFromRow({ per_minute: -4 })).toEqual(DEFAULT_PACING)
  })
})

describe('randomDelayMs', () => {
  const p = { ...DEFAULT_PACING, min_delay_seconds: 10, max_delay_seconds: 20 }
  it('stays inside [min, max] and honours the rng', () => {
    expect(randomDelayMs(p, () => 0)).toBe(10_000)
    expect(randomDelayMs(p, () => 0.5)).toBe(15_000)
    expect(randomDelayMs(p, () => 0.999999)).toBe(20_000)
  })
})

describe('rateLimitWaitMs', () => {
  const now = 1_000_000_000
  const pacing = { per_minute: 3, per_hour: 10 }

  it('is 0 under both caps', () => {
    expect(rateLimitWaitMs([now - 5_000, now - 30_000], now, pacing)).toBe(0)
    expect(rateLimitWaitMs([], now, pacing)).toBe(0)
  })

  it('waits until the oldest send in the minute window ages out', () => {
    // 3 sends in the last minute, the 3rd most recent was 40s ago -> 20s to go.
    const sends = [now - 5_000, now - 20_000, now - 40_000]
    expect(rateLimitWaitMs(sends, now, pacing)).toBe(20_000)
  })

  it('ignores a send older than a minute for the minute cap', () => {
    const sends = [now - 5_000, now - 20_000, now - 61_000]
    expect(rateLimitWaitMs(sends, now, pacing)).toBe(0)
  })

  it('applies the hourly cap and takes the longer of the two waits', () => {
    // 10 sends spread over the hour; the 10th most recent was 3500s ago -> 100s.
    const sends = Array.from({ length: 10 }, (_, i) => now - 3_500_000 + i * 300_000)
    expect(rateLimitWaitMs(sends, now, pacing)).toBe(100_000)
  })

  it('does not count sends older than an hour', () => {
    const sends = Array.from({ length: 20 }, () => now - 4_000_000)
    expect(rateLimitWaitMs(sends, now, pacing)).toBe(0)
  })

  it('accepts timestamps in any order', () => {
    const sends = [now - 40_000, now - 5_000, now - 20_000]
    expect(rateLimitWaitMs(sends, now, pacing)).toBe(20_000)
  })
})

describe('validateCampaignMessage', () => {
  it('needs something to send', () => {
    expect(validateCampaignMessage({ text: '  ' }).ok).toBe(false)
    expect(validateCampaignMessage({ text: 'oi' }).ok).toBe(true)
    expect(validateCampaignMessage({ text: '', link: 'https://x.com' }).ok).toBe(true)
    expect(validateCampaignMessage({ text: '', imageUrl: 'https://x.com/a.png' }).ok).toBe(true)
  })

  it('rejects non-http(s) links and images', () => {
    expect(validateCampaignMessage({ text: 'a', link: 'javascript:alert(1)' }).ok).toBe(false)
    expect(validateCampaignMessage({ text: 'a', link: 'site.com' }).ok).toBe(false)
    expect(validateCampaignMessage({ text: 'a', imageUrl: 'ftp://x/a.png' }).ok).toBe(false)
  })

  it('caps the caption at 1024 with an image and the text at 4096 without', () => {
    const long = 'x'.repeat(1100)
    expect(validateCampaignMessage({ text: long, imageUrl: 'https://x.com/a.png' }).ok).toBe(false)
    expect(validateCampaignMessage({ text: long }).ok).toBe(true)
    expect(validateCampaignMessage({ text: 'x'.repeat(4097) }).ok).toBe(false)
  })
})

describe('composeText / renderForContact', () => {
  it('puts the link on its own paragraph', () => {
    expect(composeText('Oi', 'https://x.com')).toBe('Oi\n\nhttps://x.com')
    expect(composeText('', 'https://x.com')).toBe('https://x.com')
    expect(composeText('Oi', null)).toBe('Oi')
  })

  it('personalises with the first name in both spellings', () => {
    const c = { name: 'Maria da Silva' }
    expect(renderForContact('Olá {{nome}}!', c)).toBe('Olá Maria!')
    expect(renderForContact('Hi {{ name }}', c)).toBe('Hi Maria')
  })

  it('tidies the gap a missing name leaves, and only then', () => {
    expect(renderForContact('Olá {{nome}}, tudo bem?', {})).toBe('Olá, tudo bem?')
    expect(renderForContact('Olá {{nome}}!', { name: '  ' })).toBe('Olá!')
    // Author spacing is untouched when there was nothing to fill.
    expect(renderForContact('a  b', {})).toBe('a  b')
  })
})
