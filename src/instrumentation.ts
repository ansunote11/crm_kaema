// Runs once when the Next.js server starts.
//
// On a long-lived server (a VPS, a container, `next start`) this keeps
// free-text Evolution campaigns moving even when nobody has the page
// open. Serverless hosts freeze the process between requests, so there
// the cron endpoint (/api/broadcasts/evolution-cron) does the same job.
// Set EVOLUTION_BROADCAST_RUNNER=off to disable it.

const TICK_INTERVAL_MS = 5_000
const BUDGET_MS = 4_000

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.EVOLUTION_BROADCAST_RUNNER === 'off') return
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return

  // Dev hot-reload re-runs register(); keep a single timer.
  const g = globalThis as { __evolutionBroadcastRunner?: boolean }
  if (g.__evolutionBroadcastRunner) return
  g.__evolutionBroadcastRunner = true

  let running = false
  setInterval(async () => {
    if (running) return
    running = true
    try {
      const [{ supabaseAdmin }, { runDueBroadcasts }] = await Promise.all([
        import('@/lib/flows/admin-client'),
        import('@/lib/whatsapp/evolution-broadcast'),
      ])
      await runDueBroadcasts(supabaseAdmin(), BUDGET_MS)
    } catch (err) {
      console.error('[evolution-broadcast runner]', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }, TICK_INTERVAL_MS).unref?.()
}
