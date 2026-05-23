// Transport: HTTP long-poll instead of WebSocket.
// WKWebView's WS receive path saturates after ~7-9 inbound binary frames at the
// OS level; reconnecting does not clear it. HTTP long-poll (GET /poll with
// Access-Control-Allow-Origin: *) is reliable for ~10-18 captures per session
// (still saturates eventually — root cause unknown, requires app restart).
import { nextTick } from 'vue'
import type { BunMessage, RenderJob, WebviewMessage } from '../../../shared/capture-wire'
import type { LayoutResult } from '../../../shared/rpc-types'

const BASE_URL = 'http://127.0.0.1:9876'
type OutboundMessage = WebviewMessage

// With 5 attempts and no backoff growth, ~2.5 s of trying before giving up.
// Long enough to ride out a slow dev startup; short enough not to spam in production.
const MAX_INITIAL_FAILED_ATTEMPTS = 5
const BACKOFF_MS = 500

export function startCaptureWorker(deps: {
  setLayout: (layout: LayoutResult) => void
  setFilename: (filename: string) => void
  capturePreviewPages: () => Array<{ svg: string; widthPx: number; heightPx: number }>
}): () => void {
  // No DEV gate — the capture server runs on every channel. In production the
  // poll will simply fail to connect; the bounded retry below gives up quietly
  // after MAX_INITIAL_FAILED_ATTEMPTS so there is no log spam.

  let active = true
  const abortController = new AbortController()

  // Track whether a poll has ever succeeded so we can distinguish
  // "production / server not installed" (never connected) from
  // "transient error in dev session" (has connected before).
  let hasEverConnected = false
  let failedAttempts = 0

  function send(msg: OutboundMessage): void {
    // Do NOT add `headers: { 'Content-Type': 'application/json' }` — it
    // promotes this request from a CORS "simple request" to one requiring an
    // OPTIONS preflight, which the bun server doesn't handle (would silently
    // 404). Plain text/plain (default for `body: string`) is enough; bun
    // parses with JSON.parse(String(raw)) regardless.
    fetch(`${BASE_URL}/result`, {
      method: 'POST',
      body: JSON.stringify(msg),
    }).catch((e) => {
      console.warn('[capture-worker] POST /result failed:', String(e))
    })
  }

  async function handleRender(msg: RenderJob): Promise<void> {
    const { jobId, layout, filename } = msg

    try {
      if (filename !== undefined) {
        deps.setFilename(filename)
      }
      deps.setLayout(layout)

      // Vue's reactive DOM update is microtask-async; SVG elements aren't
      // queryable until the next tick after the reactive set.
      await nextTick()

      const pages = deps.capturePreviewPages()
      send({ type: 'result', jobId, pages })
    } catch (err) {
      send({ type: 'error', jobId, error: String(err) })
    }
  }

  async function loop(): Promise<void> {
    while (active) {
      try {
        const resp = await fetch(`${BASE_URL}/poll`, {
          signal: abortController.signal,
        })

        if (!resp.ok) {
          // 503 / unexpected status — wait briefly then retry.
          console.warn('[capture-worker] GET /poll returned', resp.status, '— retrying')
          await sleep(BACKOFF_MS)
          continue
        }

        // A successful response means the server is reachable.
        hasEverConnected = true
        failedAttempts = 0

        const msg = (await resp.json()) as unknown

        if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
          console.warn('[capture-worker] malformed poll response (no type field):', msg)
          continue
        }

        const typed = msg as BunMessage

        if (typed.type === 'idle') {
          // Keepalive — server long-blocked for up to POLL_IDLE_TIMEOUT_MS
          // (500ms) before returning. Fire the next poll immediately;
          // no CPU spin risk because each iteration awaits a real network round-trip.
          continue
        }

        if (typed.type === 'render') {
          await handleRender(typed)
          continue
        }

        // Forward-compatibility: unknown types are silently skipped at warn level.
        console.warn('[capture-worker] unrecognised message type:', typed.type)
      } catch (err) {
        if (abortController.signal.aborted) return

        // Network error (connection refused, etc.).
        if (!hasEverConnected) {
          failedAttempts++
          console.log(
            '[capture-worker] poll failed (attempt',
            failedAttempts,
            'of',
            MAX_INITIAL_FAILED_ATTEMPTS,
            ')',
          )
          if (failedAttempts >= MAX_INITIAL_FAILED_ATTEMPTS) {
            console.log(
              '[capture-worker] giving up — capture server not running (this is expected in production)',
            )
            return
          }
        } else {
          console.warn('[capture-worker] poll error — retrying:', String(err))
        }

        await sleep(BACKOFF_MS)
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  void loop()

  return function stop(): void {
    active = false
    abortController.abort()
  }
}
