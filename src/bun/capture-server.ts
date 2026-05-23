/**
 * Capture server: lightweight HTTP listener for triggering live-preview
 * captures from an external process (curl, eval pipeline).
 *
 * Only started in the "dev" channel (see index.ts). Not shipped in production.
 *
 * Transport: HTTP long-poll (GET /poll + POST /result).
 * The webview opens GET /poll on mount; bun responds with a `RenderJob` when
 * one is ready (Access-Control-Allow-Origin: *), or `{type:"idle"}` after
 * POLL_IDLE_TIMEOUT_MS so the webview retries. The webview POSTs results to
 * /result (POSTs are simple requests in WebKit, no CORS header needed).
 *
 * This sidesteps two WKWebView restrictions:
 *   1. WKWebView's WebSocket receive path saturates at ~7-9 inbound binary
 *      frames per process; reconnecting does not clear it.
 *   2. Streaming response bodies (SSE, ReadableStream reader) fail with
 *      `TypeError: Load failed` from `views://mainview` even with a CORS header.
 *
 * Captures are reliable for ~10-18 per app session (varies run-to-run) — the
 * webview's fetch loop eventually stops registering polls and never recovers
 * without an app restart. Cause unknown; tried `mainWindow.focus()` before
 * dispatch as a workaround — no measurable effect, removed. For larger
 * batches, restart the app between bursts.
 *
 * Bun-side compilation (via the getLayout callback) means the webview makes
 * zero Electrobun RPC calls during a capture, avoiding the named-pipe
 * cold-start gating problem.
 *
 * Usage:
 *   curl -s -X POST "http://127.0.0.1:9876/capture?name=my-fixture"
 *
 * Query parameters:
 *   name    - Required. Alphanumeric + hyphens/underscores. Names the output files.
 *   bg      - Optional. "white" (default) or "transparent". Controls the PNG canvas
 *             background. Default "white" matches the eval golden colour space
 *             (Ghostscript png16m device outputs RGB-on-white). Use "transparent"
 *             for ad-hoc compositing where you need a clear background layer.
 *             Any other value returns 400.
 *   source  - Optional. If set, loads `evals/fixtures/<source>.tab`, compiles it
 *             bun-side via the getLayout callback, and sends the LayoutResult to the
 *             webview. Same regex as `name` — alphanumeric + hyphens/underscores.
 *             Returns 400 for invalid values; 502 if reading or compilation fails.
 *             Absent means the webview renders whatever LayoutResult is current in
 *             its own state (the webview must have a layout ready — behaviour depends
 *             on what the editor last compiled).
 *
 * Writes per-page SVG and PNG files to os.tmpdir()/tabbo-captures/ (e.g. /tmp/tabbo-captures/ on macOS):
 *   my-fixture-p1.svg, my-fixture-p1.png, my-fixture-p2.svg, ...
 *
 * Filenames match the evals/goldens/<fixture>-p{N}.png convention so
 * manual diffs pair by name.
 *
 * Example (white background, default):
 *   curl -s -X POST "http://127.0.0.1:9876/capture?name=my-fixture"
 *
 * Example (transparent background):
 *   curl -s -X POST "http://127.0.0.1:9876/capture?name=my-fixture&bg=transparent"
 *
 * Example (load fixture then capture with white background):
 *   curl -s -X POST "http://127.0.0.1:9876/capture?name=simple&source=simple&bg=white"
 */

import { writeFileSync, readdirSync, readFileSync } from "fs";
import { join, basename, extname } from "path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { toErrorMessage } from "./error-utils";
import type { LayoutResult } from "../shared/rpc-types";
import type { IdleMessage, RenderJob, WebviewMessage } from "../shared/capture-wire";

// Scale 96-CSS-px to 150 DPI output (matches eval goldens).
const DPI_SCALE = 150 / 96;

const CAPTURE_PORT = 9876;

// import.meta.dir resolves to Contents/Resources/app/bun/ even in dev. The
// build.copy mapping in electrobun.config.ts puts engine/fonts at
// ../resources/fonts/ relative to that, with WOFF2 files in the woff2/
// subdirectory. Source-tree override for tests: engine/fonts/woff2/.
const WOFF2_FONTS_DIR = join(import.meta.dir, "../resources/fonts/woff2");

// build.copy mapping in electrobun.config.ts puts body fonts at
// ../resources/body-fonts/ relative to import.meta.dir. Source-tree override
// for tests: assets/fonts/.
const BODY_FONTS_DIR = join(import.meta.dir, "../resources/body-fonts");

/**
 * Register every *.woff2 in the given directory with Skia so that lute
 * glyphs in captured SVGs rasterise with the correct typeface.
 *
 * Uses GlobalFonts.register(buffer, family) rather than registerFromPath().
 * registerFromPath() succeeds in isolation (GlobalFonts.has() returns true)
 * but Skia's SVG renderer does not pick up the font during loadImage() — the
 * buffer-based register() path correctly informs the SVG renderer's font
 * resolver. Rejected: inline @font-face data URIs in the SVG — Skia's SVG
 * rasteriser does not process CSS @font-face declarations.
 *
 * Called once at module load (with the built-app path). Exported so tests can
 * call it with the source-tree path to exercise the real registration code path.
 */
export function registerLuteFonts(dir: string = WOFF2_FONTS_DIR): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (err) {
		const message = toErrorMessage(err);
		console.warn(
			`[capture] WOFF2 fonts dir not found – captured PNGs will use fallback glyphs. ${message}`,
		);
		return;
	}

	let count = 0;
	for (const entry of entries) {
		if (extname(entry) !== ".woff2") continue;
		const family = basename(entry, ".woff2");
		const fontPath = join(dir, entry);
		try {
			const bytes = readFileSync(fontPath);
			const key = GlobalFonts.register(bytes, family);
			if (key === null) {
				console.warn(
					`[capture] Font registration returned null for ${entry} — corrupt or unsupported format`,
				);
				continue;
			}
			count++;
		} catch (err) {
			const message = toErrorMessage(err);
			console.error(`[capture] Failed to register font ${entry}: ${message}`);
		}
	}

	console.log(`[capture] Registered ${count} lute fonts with Skia`);
}

/**
 * Register the body-text font with Skia under the family name that the SVG
 * renderer requests (`'TabboBody'`).
 *
 * Uses GlobalFonts.register(buffer, family) — same reasoning as
 * registerLuteFonts: registerFromPath() does not inform Skia's SVG renderer
 * code path. Family name is fixed rather than derived from the filename because
 * there is only one expected file and the SVG asks for an exact name.
 *
 * Warns (does not throw) if the file is absent so a missing body font degrades
 * gracefully — lute glyphs still render; body text falls back to Skia's
 * default.
 *
 * Exported so tests can call it with the source-tree path override (same
 * pattern as registerLuteFonts).
 */
export function registerBodyFonts(dir: string = BODY_FONTS_DIR): void {
	const fontPath = join(dir, "Tinos-Regular.woff2");
	let bytes: Buffer;
	try {
		bytes = readFileSync(fontPath);
	} catch (err) {
		const message = toErrorMessage(err);
		console.warn(
			`[capture] Body font not found — body text in captured PNGs will use Skia's fallback. ${message}`,
		);
		return;
	}

	const key = GlobalFonts.register(bytes, "TabboBody");
	if (key === null) {
		console.warn(
			"[capture] Body font registration returned null — corrupt or unsupported format",
		);
		return;
	}

	console.log("[capture] Registered body font 'TabboBody' with Skia");
}

// Register at module load so fonts are available before any capture request.
registerLuteFonts();
registerBodyFonts();

/**
 * Alphanumeric, hyphens and underscores only. Rejects anything that could
 * be used for path traversal or shell injection.
 */
export function isSafeName(name: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(name);
}

type PageFiles = { svg: string; png: string };

type BgMode = "white" | "transparent";

/**
 * Rasterise one SVG page to PNG at 150 DPI and write both files to disk.
 * Returns the absolute paths written.
 *
 * bg defaults to "white" so callers that omit it (including existing tests)
 * get the golden-matching white background automatically.
 */
export async function writePage(
	capturesDir: string,
	name: string,
	pageIndex: number,
	svgString: string,
	widthPx: number,
	heightPx: number,
	bg: BgMode = "white",
): Promise<PageFiles> {
	// 1-based page numbering to match goldens convention.
	const stem = `${name}-p${pageIndex + 1}`;

	const svgPath = join(capturesDir, `${stem}.svg`);
	writeFileSync(svgPath, svgString, "utf-8");

	const outW = Math.round(widthPx * DPI_SCALE);
	const outH = Math.round(heightPx * DPI_SCALE);

	// Stamp the target pixel dimensions onto the SVG root's width/height before
	// handing the buffer to Skia. This makes the rasteriser produce a native
	// high-res bitmap rather than upscaling a 96-DPI version, which would blur
	// thin staff lines and small glyphs.
	//
	// The viewBox (if present) is left untouched — it already maps the coordinate
	// system to the new width/height automatically. Only the outer <svg ...>
	// tag's width/height attributes are replaced.
	const highResSvg = svgString
		.replace(/(<svg[^>]*)\bwidth="[^"]*"/, `$1width="${outW}"`)
		.replace(/(<svg[^>]*)\bheight="[^"]*"/, `$1height="${outH}"`);

	// @napi-rs/canvas accepts SVG via Buffer: passes through createImage() which
	// sets Image.src = buffer; the native binding detects SVG by content.
	const img = await loadImage(Buffer.from(highResSvg, "utf-8"));
	const canvas = createCanvas(outW, outH);
	const ctx = canvas.getContext("2d");

	if (bg === "white") {
		// Fill white before compositing the SVG so the output matches the
		// Ghostscript png16m colour space used by eval goldens (RGB-on-white).
		// Default alpha on a fresh canvas is 0 (transparent).
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, outW, outH);
	}

	ctx.drawImage(img, 0, 0);
	const pngBuffer = await canvas.encode("png");

	const pngPath = join(capturesDir, `${stem}.png`);
	writeFileSync(pngPath, pngBuffer);

	return { svg: svgPath, png: pngPath };
}

// Eval fixtures are bundled via `build.copy` (`evals/fixtures` → `resources/fixtures`)
// so the same relative path works in dev and production. Capture-server is gated to
// the dev channel, but using the bundled path means the resolver doesn't depend on
// process.cwd() (which is `Contents/MacOS/`, not the project root, when Electrobun
// spawns the bun process).
const FIXTURES_DIR = join(import.meta.dir, "../resources/fixtures");

/**
 * Resolve the path to an evals fixture file.
 *
 * Exported so tests can exercise the helper in isolation. Tests run from the
 * source tree where `import.meta.dir` is `src/bun/`, so they get the wrong path
 * by default — the test passes a `dir` override (or asserts only on the suffix).
 */
export function resolveFixturePath(source: string, dir: string = FIXTURES_DIR): string {
	return join(dir, `${source}.tab`);
}

// ---------------------------------------------------------------------------
// Long-poll state
// ---------------------------------------------------------------------------

// Wire types (RenderJob, WebviewMessage) are defined in src/shared/capture-wire.ts
// and imported above. Both bun and the webview import from the shared file to
// keep the message shapes in sync.

// Pending job state keyed by jobId.
type PendingJob = {
	resolve: (pages: Array<{ svg: string; widthPx: number; heightPx: number }>) => void;
	reject: (reason: Error) => void;
};

// Active long-poll request from the webview. Single-slot (single webview assumption).
type PendingPoll = {
	resolve: (job: RenderJob) => void;
	timer: ReturnType<typeof setTimeout>;
};

let pendingPoll: PendingPoll | null = null;
// Tracks first-ever /poll arrival for a one-shot startup log; subsequent idle
// polls stay silent to avoid stdout noise.
let firstPollSeen = false;

// Callers (POST /capture handlers) waiting for the webview to open a /poll.
let pollWaiters: Array<() => void> = [];

// Jobs awaiting a result from the webview (POST /result).
const pendingJobs = new Map<string, PendingJob>();

// How long GET /poll holds open before responding with { type: "idle" }.
// Counter-intuitive choice: a SHORT idle timeout outperforms a long one despite
// "long-poll" in the architectural name. WKWebView accumulates state per
// cross-origin fetch session that eventually wedges the loop (~15-18 captures);
// holding /poll open for the full ~8s window WKWebView allows means each
// /capture has to wait until the parked poll naturally ends, AND every fetch
// chews up most of the per-fetch budget, accelerating saturation. With 500ms
// idle: /capture waits at most ~500ms for the next poll to register, fetches
// resolve fast and start fresh, and ~15-18 captures complete per app session.
// Empirically validated 2026-04-29.
const POLL_IDLE_TIMEOUT_MS = 500;

// How long POST /capture waits for the webview to open a /poll request.
// Longer than the poll cycle so the capture can survive multiple idle cycles.
const CAPTURE_WAIT_FOR_POLL_MS = 30_000;

// Per-job render timeout — generous because large fixtures can take seconds.
const JOB_RENDER_TIMEOUT_MS = 30_000;

// Monotonic counter for job IDs. Simpler than UUID for a single-client dev tool.
let jobCounter = 0;

function nextJobId(): string {
	return String(++jobCounter);
}

/**
 * Wait until the webview has opened a GET /poll request, or timeout.
 * Returns immediately if a poll is already pending.
 */
function waitForPoll(): Promise<void> {
	if (pendingPoll !== null) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			// Remove our waiter so it doesn't fire after the timeout.
			pollWaiters = pollWaiters.filter((r) => r !== onPoll);
			reject(new Error("Webview has not opened a /poll request — is the app running?"));
		}, CAPTURE_WAIT_FOR_POLL_MS);

		const onPoll = () => {
			clearTimeout(timer);
			resolve();
		};
		pollWaiters.push(onPoll);
	});
}

/**
 * Send a render job to the webview via the pending long-poll and wait for
 * the result from POST /result.
 *
 * Awaits waitForPoll() internally so each queued dispatch waits for its OWN
 * fresh /poll. Callers in dispatchSerialised's chain that took an outer
 * waitForPoll snapshot would see a single poll consumed by the first job
 * and 502 the rest — handle the wait per-job here.
 */
async function dispatchJob(job: RenderJob): Promise<Array<{ svg: string; widthPx: number; heightPx: number }>> {
	await waitForPoll();
	return new Promise((resolve, reject) => {
		if (pendingPoll === null) {
			reject(new Error("No active /poll request — webview disconnected?"));
			return;
		}

		const timer = setTimeout(() => {
			if (pendingJobs.has(job.jobId)) {
				pendingJobs.delete(job.jobId);
				reject(new Error(`Job ${job.jobId} timed out after ${JOB_RENDER_TIMEOUT_MS} ms`));
			}
		}, JOB_RENDER_TIMEOUT_MS);

		pendingJobs.set(job.jobId, {
			resolve: (pages) => {
				clearTimeout(timer);
				resolve(pages);
			},
			reject: (reason) => {
				clearTimeout(timer);
				reject(reason);
			},
		});

		// Claim and clear pendingPoll before resolving it so the next /poll
		// request is not confused with this one.
		const poll = pendingPoll;
		clearTimeout(poll.timer);
		pendingPoll = null;

		poll.resolve(job);
	});
}

/**
 * Serialise concurrent dispatch calls to avoid two jobs clobbering each
 * other's editor state in the webview.
 *
 * The webview's useCaptureWorker handles one job at a time: it sets
 * tabContent and currentFilename before rendering. Two concurrent dispatches
 * would interleave those writes. This chain makes all dispatches FIFO without
 * returning 409 to callers (which would break an eval pipeline that sends
 * parallel requests expecting deterministic ordering, not failures).
 */
let serialiseJobs: Promise<unknown> = Promise.resolve();

function dispatchSerialised(job: RenderJob): Promise<Array<{ svg: string; widthPx: number; heightPx: number }>> {
	const prev = serialiseJobs;
	let resolveSlot!: () => void;
	// Create a new slot that successor calls will chain onto.
	const slot = new Promise<void>((r) => { resolveSlot = r; });
	serialiseJobs = slot;

	return prev.then(() => dispatchJob(job)).finally(() => resolveSlot());
}

/**
 * Reject all pending jobs with the given error and clear the map.
 */
function rejectAllPending(reason: string): void {
	for (const [, job] of pendingJobs) {
		job.reject(new Error(reason));
	}
	pendingJobs.clear();
}

/**
 * Start the capture HTTP server. Binds to 127.0.0.1:9876.
 *
 * Throws if the port is already in use — most likely an orphan Tabbo/bun
 * process from a previous session. The caller (index.ts) should let this
 * propagate so the startup failure is unmissable.
 *
 * No CSRF protection / origin allowlist. Accepted: any process on the
 * loopback interface (including a malicious page in any browser visiting
 * the dev machine via a form-encoded POST) can trigger a capture, which
 * writes SVG/PNG bytes to a sanitised name in the captures tmp dir. Worst
 * case is disk-write spam in a dir the OS reaps. The server is dev-only
 * (gated by `channel === "dev"` in index.ts), loopback-only, the name is
 * regex-validated, and the write target is bounded. No tokens or origin
 * checks are warranted for this threat model.
 *
 * @param capturesDir - Directory to write SVG/PNG captures into.
 * @param getLayout   - Callback to compile .tab source into a LayoutResult.
 *                      Matches the EngineWorker.getLayout signature. Kept as a
 *                      callback (not a direct import) to decouple capture-server
 *                      from engine-worker internals and to make the injection seam
 *                      testable without pulling in worker side effects.
 */
export function startCaptureServer(
	capturesDir: string,
	getLayout: (content: string) => Promise<LayoutResult>,
): ReturnType<typeof Bun.serve> {
	try {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: CAPTURE_PORT,
			// Disable bun's default 10s idle timeout. dispatchSerialised queues
			// concurrent /capture requests FIFO, so a single /capture can legitimately
			// wait several render cycles (each ~3s) before its turn. The 10s default
			// would kill queued requests prematurely. Per-request safety still comes
			// from JOB_RENDER_TIMEOUT_MS (30s) and CAPTURE_WAIT_FOR_POLL_MS (30s).
			idleTimeout: 0,

			async fetch(req) {
				const url = new URL(req.url);
				// GET /poll fires every ~500ms during idle — skip the per-request
				// log to keep stdout readable. The /poll handler logs once on
				// first webview connection and again when a waiting /capture is
				// unblocked, preserving visibility where it actually matters.
				if (!(req.method === "GET" && url.pathname === "/poll")) {
					const ts = Math.round(performance.now() / 100) / 10;
					console.log(`[capture] t=${ts}s ${req.method} ${url.pathname} origin=${req.headers.get("origin") ?? "none"}`);
				}

				// ---------------------------------------------------------------
				// GET /poll — webview long-polls for the next render job.
				// ---------------------------------------------------------------
				if (req.method === "GET" && url.pathname === "/poll") {
					// If a previous poll is still open (e.g. webview reconnected),
					// close it cleanly and cancel any job that was about to be sent.
					// We do NOT also reject in-flight jobs in `pendingJobs` here — the
					// webview's normal cycle is "send /result, fire next /poll", and
					// those two arrive at bun in undefined order; rejecting in-flight
					// jobs on every fresh /poll would incorrectly cancel the just-completed
					// capture. Mid-render disconnects are caught by JOB_RENDER_TIMEOUT_MS
					// (30s) instead — slower than ideal, but correct.
					if (pendingPoll !== null) {
						console.log("[capture] Replacing stale /poll — cancelling previous");
						clearTimeout(pendingPoll.timer);
						pendingPoll = null;
						rejectAllPending("Webview reconnected — previous render jobs cancelled");
					}

					// Unblock any POST /capture handlers that were waiting for a poll.
					const waiters = pollWaiters;
					pollWaiters = [];
					for (const notify of waiters) {
						notify();
					}

					// Log only on (a) the first poll after startup so it's clear the
					// webview connected, and (b) when a poll wakes a waiting /capture
					// — both useful for debugging. Routine 500ms idle polls stay silent.
					if (!firstPollSeen) {
						firstPollSeen = true;
						console.log("[capture] Webview /poll registered (first)");
					} else if (waiters.length > 0) {
						console.log(`[capture] Webview /poll woke ${waiters.length} waiter(s)`);
					}

					// Long-block until a job arrives or the idle timeout fires.
					const job = await new Promise<RenderJob | null>((resolve) => {
						const timer = setTimeout(() => {
							pendingPoll = null;
							resolve(null);
						}, POLL_IDLE_TIMEOUT_MS);

						pendingPoll = { resolve, timer };
					});

					if (job === null) {
						// No job before timeout — send idle so the webview retries.
						// `Connection: close` forces a fresh TCP connection for the
						// next /poll instead of reusing the keep-alive pool. We carried
						// this over from the api-specialist's implementation; suspected
						// to help with the ~10-18 saturation ceiling but not measured
						// in isolation. Worth retesting if the saturation cause is
						// pinned down.
						const idle: IdleMessage = { type: "idle" };
						return new Response(
							JSON.stringify(idle),
							{
								status: 200,
								headers: {
									"Content-Type": "application/json",
									"Access-Control-Allow-Origin": "*",
									"Connection": "close",
								},
							},
						);
					}

					return new Response(
						JSON.stringify(job),
						{
							status: 200,
							headers: {
								"Content-Type": "application/json",
								"Access-Control-Allow-Origin": "*",
							},
						},
					);
				}

				// ---------------------------------------------------------------
				// POST /result — webview posts render result for a completed job.
				// ---------------------------------------------------------------
				if (req.method === "POST" && url.pathname === "/result") {
					let msg: WebviewMessage;
					try {
						msg = (await req.json()) as WebviewMessage;
					} catch (err) {
						const message = toErrorMessage(err);
						console.warn(`[capture] /result parse error: ${message}`);
						return new Response(
							JSON.stringify({ ok: false, error: "Invalid JSON" }),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						);
					}

					if (msg.type !== "result" && msg.type !== "error") {
						console.warn("[capture] /result: unexpected message type:", (msg as { type: string }).type);
						return new Response(
							JSON.stringify({ ok: false, error: "Unknown message type" }),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						);
					}

					const job = pendingJobs.get(msg.jobId);
					if (!job) {
						// Could be a late reply for a timed-out job — ignore.
						console.warn("[capture] /result: unknown jobId:", msg.jobId);
						return new Response(
							JSON.stringify({ ok: false, error: "Unknown jobId" }),
							{ status: 404, headers: { "Content-Type": "application/json" } },
						);
					}

					pendingJobs.delete(msg.jobId);

					if (msg.type === "result") {
						// Validate pages shape before forwarding to writePage.
						// A malformed page (e.g. `{}`) would produce NaN widths and a
						// 500 further down the call stack — reject here with a clean error.
						if (
							!Array.isArray(msg.pages) ||
							!msg.pages.every(
								(p) =>
									typeof (p as { svg?: unknown })?.svg === "string" &&
									typeof (p as { widthPx?: unknown })?.widthPx === "number" &&
									typeof (p as { heightPx?: unknown })?.heightPx === "number",
							)
						) {
							job.reject(new Error("Webview returned malformed pages array"));
						} else {
							job.resolve(msg.pages);
						}
					} else {
						job.reject(new Error(msg.error));
					}

					return new Response(
						JSON.stringify({ ok: true }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				// ---------------------------------------------------------------
				// POST /capture — external trigger (curl, eval pipeline).
				// ---------------------------------------------------------------
				if (req.method !== "POST" || url.pathname !== "/capture") {
					return new Response(
						JSON.stringify({ ok: false, error: "POST /capture?name=<name>" }),
						{ status: 404, headers: { "Content-Type": "application/json" } },
					);
				}

				const name = url.searchParams.get("name") ?? "";
				if (!isSafeName(name)) {
					return new Response(
						JSON.stringify({
							ok: false,
							error:
								"name must be alphanumeric with hyphens/underscores only",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}

				const bgParam = url.searchParams.get("bg") ?? "white";
				if (bgParam !== "white" && bgParam !== "transparent") {
					return new Response(
						JSON.stringify({
							ok: false,
							error: 'bg must be "white" or "transparent"',
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				const bg = bgParam as BgMode;

				// Read and compile the fixture BEFORE claiming a poll so the job
				// is ready for instant dispatch. Compilation is done by the long-lived
				// engine worker (< 100ms), but doing it before waitForPoll() ensures
				// zero compilation latency on the poll's idle timer — the job is
				// dispatched the moment a poll is available.
				const sourceParam = url.searchParams.get("source");
				if (sourceParam === null) {
					return new Response(
						JSON.stringify({
							ok: false,
							error:
								"source is required — bun compiles bun-side and there is no current-editor fallback",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}

				if (!isSafeName(sourceParam)) {
					return new Response(
						JSON.stringify({
							ok: false,
							error:
								"source must be alphanumeric with hyphens/underscores only",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}

				const fixturePath = resolveFixturePath(sourceParam);
				let content: string;
				try {
					content = await Bun.file(fixturePath).text();
				} catch (err) {
					const message = toErrorMessage(err);
					console.error(
						`[capture] Failed to read fixture ${fixturePath}: ${message}`,
					);
					return new Response(
						JSON.stringify({
							ok: false,
							error: `Could not read fixture "${sourceParam}.tab": ${message}`,
						}),
						{ status: 502, headers: { "Content-Type": "application/json" } },
					);
				}

				let layout: LayoutResult;
				try {
					layout = await getLayout(content);
				} catch (err) {
					const message = toErrorMessage(err);
					console.error(`[capture] Engine compilation failed: ${message}`);
					return new Response(
						JSON.stringify({ ok: false, error: `Compilation failed: ${message}` }),
						{ status: 502, headers: { "Content-Type": "application/json" } },
					);
				}

				if (layout.errors.length > 0 && layout.pages.length === 0) {
					const firstError = layout.errors[0].message;
					console.error(`[capture] Engine returned errors: ${firstError}`);
					return new Response(
						JSON.stringify({ ok: false, error: `Compilation error: ${firstError}` }),
						{ status: 502, headers: { "Content-Type": "application/json" } },
					);
				}

				const jobId = nextJobId();

				const job: RenderJob = {
					type: "render",
					jobId,
					layout,
					filename: `${sourceParam}.tab`,
				};

				// dispatchJob (called via dispatchSerialised) awaits its own /poll
				// per-job, so concurrent /capture handlers each block on a fresh
				// poll instead of racing for one captured snapshot. A failure here
				// is either CAPTURE_WAIT_FOR_POLL_MS timeout (webview not running →
				// 503) or render-side error (502).
				let pages: Array<{ svg: string; widthPx: number; heightPx: number }>;
				try {
					pages = await dispatchSerialised(job);
				} catch (err) {
					const message = toErrorMessage(err);
					const isPollTimeout = message.includes("not opened a /poll request");
					console.error(`[capture] ${isPollTimeout ? message : `Render job failed: ${message}`}`);
					return new Response(
						JSON.stringify({ ok: false, error: isPollTimeout ? message : `Render failed: ${message}` }),
						{ status: isPollTimeout ? 503 : 502, headers: { "Content-Type": "application/json" } },
					);
				}

				if (pages.length === 0) {
					return new Response(
						JSON.stringify({ ok: false, error: "no pages rendered" }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				const files: PageFiles[] = [];
				for (let i = 0; i < pages.length; i++) {
					const { svg, widthPx, heightPx } = pages[i];
					try {
						const written = await writePage(
							capturesDir,
							name,
							i,
							svg,
							widthPx,
							heightPx,
							bg,
						);
						files.push(written);
					} catch (err) {
						const message = toErrorMessage(err);
						console.error(
							`[capture] Failed to write page ${i + 1}: ${message}`,
						);
						return new Response(
							JSON.stringify({
								ok: false,
								error: `Failed to write page ${i + 1}: ${message}`,
							}),
							{
								status: 500,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				}

				return new Response(
					JSON.stringify({ ok: true, files }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		});

		console.log(
			`[capture] Listening on http://127.0.0.1:${CAPTURE_PORT}/capture`,
		);
		return server;
	} catch (err) {
		// Rejected: auto-bumping to the next free port (Electrobun's main socket
		// does this). It would mean the capture URL drifts unpredictably and
		// external callers would need to discover the chosen port from a
		// sidecar file or log scrape. Failing loud is the lesser footgun for a
		// dev tool with one expected user.
		const message = toErrorMessage(err);
		throw new Error(
			`[capture] Failed to bind port ${CAPTURE_PORT}. ORPHAN PROCESS LIKELY — check \`lsof -i :${CAPTURE_PORT}\` and kill the stale process before restarting. Detail: ${message}`,
		);
	}
}
