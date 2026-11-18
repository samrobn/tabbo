import { join, resolve } from "path";
import { existsSync } from "fs";
import type { Subprocess } from "bun";
import type { GetLayoutResponse, LayoutResult } from "../shared/rpc-types";
import { toErrorMessage } from "./error-utils";

type WorkerProc = Subprocess<"pipe", "pipe", "pipe">;

const WORKER_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 2_000;
const EXPECTED_SCHEMA_VERSION = 1;

// Respawn guard: track timestamps of recent spawns to detect a crash loop.
const RESPAWN_WINDOW_MS = 30_000;
const RESPAWN_MAX = 3;

/**
 * Resolve a resource path, trying the built app location first, then dev fallback.
 * In a built Electrobun app, resources are copied to resources/ relative to the bun entrypoint.
 * In dev, they're in engine/ relative to the project root.
 */
function resolveResource(builtRelative: string, devRelative: string): string {
	const builtPath = join(import.meta.dir, builtRelative);
	if (existsSync(builtPath)) return builtPath;

	const devPath = resolve(devRelative);
	if (existsSync(devPath)) return devPath;

	throw new Error(
		`Resource not found. Tried:\n  ${builtPath}\n  ${devPath}`,
	);
}

let _tabBinary: string | undefined;
let _fontsDir: string | undefined;

export function getTabBinary(): string {
	_tabBinary ??= resolveResource("../resources/bin/tab", "engine/tab");
	return _tabBinary;
}

export function getFontsDir(): string {
	_fontsDir ??= resolveResource("../resources/fonts", "engine/fonts");
	return _fontsDir;
}

interface InFlightRequest {
	resolve: (result: GetLayoutResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingRequest {
	content: string;
	resolve: (result: GetLayoutResponse) => void;
	// reject is kept for programmer errors that escape the worker-lifecycle catch.
	reject: (err: Error) => void;
}

export class EngineWorker {
	// The binary is injectable so tests can stand in a process that misbehaves.
	constructor(private readonly tabBinary: () => string = getTabBinary) {}

	private proc: WorkerProc | null = null;
	// spawnPromise is set while a spawn+probe is in progress; callers await it
	// rather than starting a second concurrent spawn.
	private spawnPromise: Promise<void> | null = null;
	private inFlight: InFlightRequest | null = null;
	private pending: PendingRequest | null = null;
	// Closed flag: set when this instance has been explicitly shut down.
	private closed = false;

	// Set during spawn() for the version probe; cleared once it resolves.
	private versionProbeResolve: ((line: string) => void) | null = null;
	private versionProbeReject: ((err: Error) => void) | null = null;

	// Spawn history timestamps for crash-loop detection.
	private spawnHistory: number[] = [];

	async getLayout(content: string): Promise<GetLayoutResponse> {
		if (this.closed) {
			return {
				layout: null,
				errors: [{ message: "Worker has been shut down." }],
			};
		}

		try {
			// Ensure a verified worker is running. this.proc is set before the
			// version probe finishes, so wait on any spawn in progress too: a
			// request sent mid-probe would go to an unchecked process and race
			// the probe for its reply. spawnPromise also serialises concurrent
			// callers so only one spawn+probe runs.
			if (!this.proc || this.spawnPromise) {
				if (!this.spawnPromise) {
					this.spawnPromise = this.spawn().finally(() => {
						this.spawnPromise = null;
					});
				}
				await this.spawnPromise;
			}

			// If a request is in-flight, latest-wins: replace any queued pending.
			// Superseded callers resolve (not reject) with superseded: true so
			// fire-and-forget callers don't produce unhandled rejection warnings.
			if (this.inFlight) {
				return new Promise((resolve, reject) => {
					// Resolve any previously queued pending as superseded.
					if (this.pending) {
						this.pending.resolve({ layout: null, errors: [], superseded: true });
					}
					this.pending = { content, resolve, reject };
				});
			}

			return this.dispatch(content);
		} catch (err) {
			// Worker-lifecycle errors (spawn-cap exhausted, version mismatch,
			// premature exit during probe, per-request timeout) are converted to
			// the clean response envelope so callers see a consistent shape.
			return {
				layout: null,
				errors: [
					{ message: toErrorMessage(err) },
				],
			};
		}
	}

	private dispatch(content: string): Promise<GetLayoutResponse> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.inFlight = null;
				this.killProc();
				// Resolve (not reject) with an error envelope so the per-request
				// timeout doesn't produce an unhandled rejection at the call site.
				resolve({
					layout: null,
					errors: [
						{
							message: `Engine worker timed out after ${WORKER_TIMEOUT_MS}ms. Worker will be respawned on next request.`,
						},
					],
				});
				// Kick off pending if there is one.
				this.drainPending();
			}, WORKER_TIMEOUT_MS);

			this.inFlight = { resolve, reject, timer };

			const line = JSON.stringify({ cmd: "layout", content }) + "\n";
			this.proc!.stdin.write(line);
		});
	}

	private async spawn(): Promise<void> {
		const now = Date.now();

		// Evict spawn timestamps older than the window.
		this.spawnHistory = this.spawnHistory.filter(
			(t) => now - t < RESPAWN_WINDOW_MS,
		);

		if (this.spawnHistory.length >= RESPAWN_MAX) {
			throw new Error(
				`Engine worker crashed ${RESPAWN_MAX} times within ${RESPAWN_WINDOW_MS / 1000}s. ` +
				"The typesetter appears to be broken. Please restart Tabbo.",
			);
		}

		this.spawnHistory.push(now);
		this.versionProbeResolve = null;
		this.versionProbeReject = null;

		const proc = Bun.spawn([this.tabBinary(), "-worker"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, TABFONTS: getFontsDir() },
		});

		this.proc = proc;

		// Start background loops before the version probe.
		// The stdout loop is the single reader on proc.stdout — readOneLine
		// is not used (it would conflict with the reader lock).
		this.startStderrDrain(proc);
		this.startStdoutLoop(proc);

		// Monitor exits before probing, so a worker that dies at start-up fails
		// the probe at once with its exit code rather than timing out.
		proc.exited.then((code) => {
			if (this.proc !== proc) return; // Superseded.
			this.onProcExited(code);
		});

		try {
			await this.probeVersion();
		} catch (err) {
			// Don't leave an unverified worker in place for the next request.
			if (this.proc === proc) this.killProc();
			throw err;
		}
	}

	private async probeVersion(): Promise<void> {
		// The stdout loop delivers lines via handleLine, which checks
		// versionProbeResolve first, so set the resolver up before writing.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const response = Promise.race([
			new Promise<string>((res, rej) => {
				this.versionProbeResolve = res;
				this.versionProbeReject = rej;
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Version probe timed out.")),
					VERSION_PROBE_TIMEOUT_MS,
				);
			}),
		]);

		this.proc!.stdin.write(JSON.stringify({ cmd: "version" }) + "\n");

		let responseLine: string;
		try {
			responseLine = await response;
		} finally {
			clearTimeout(timer);
			this.versionProbeResolve = null;
			this.versionProbeReject = null;
		}

		let parsed: { schema_version?: number };
		try {
			parsed = JSON.parse(responseLine);
		} catch {
			throw new Error(
				`Engine protocol error: version probe returned non-JSON: ${responseLine}`,
			);
		}

		if (parsed.schema_version !== EXPECTED_SCHEMA_VERSION) {
			throw new Error(
				`Engine protocol version mismatch (expected ${EXPECTED_SCHEMA_VERSION}, got ${parsed.schema_version}). Please restart Tabbo.`,
			);
		}
	}

	/**
	 * Continuous stdout reader. Accumulates chunks into a rolling string buffer
	 * and splits on `\n`. Each complete line is dispatched to handleLine.
	 *
	 * This is the only reader on proc.stdout — using `for await` acquires the
	 * reader lock on the ReadableStream. readOneLine is not used separately.
	 *
	 * We must NOT assume each chunk is a complete line — Bun yields
	 * chunk-aligned Uint8Array slices that can split mid-JSON.
	 */
	private startStdoutLoop(proc: WorkerProc): void {
		const decoder = new TextDecoder();
		let buffer = "";
		(async () => {
			for await (const chunk of proc.stdout) {
				// A killed or replaced worker's late output must not reach
				// handleLine, where it would answer the new worker's probe or requests.
				if (this.proc !== proc) return;
				buffer += decoder.decode(chunk, { stream: true });

				let nl: number;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line) this.handleLine(line);
				}
			}
			// Stream closed — proc has exited or was killed.
		})().catch(() => {
			// Ignore: onProcExited handles the cleanup.
		});
	}

	/**
	 * Continuous stderr drain for the lifetime of the process. Bun reads a piped
	 * stream eagerly whether or not we do (measured on Bun 1.3.9: 20 MB of
	 * unread output never blocked the child), so this isn't what keeps the
	 * worker's stdout flowing; it exists for the debug log below, and so unread
	 * output doesn't accumulate in Bun's memory over a long session.
	 *
	 * Logging is gated on TABBO_DEBUG_ENGINE being set to any non-empty value, to avoid spamming the bun process
	 * log on every keystroke. The engine emits at least one known-noisy warning
	 * ("setting filename to %s") on every invocation via dbg1() in args.cc.
	 */
	private startStderrDrain(proc: WorkerProc): void {
		const debug = Boolean(process.env.TABBO_DEBUG_ENGINE);
		const decoder = new TextDecoder();
		(async () => {
			for await (const chunk of proc.stderr) {
				if (!debug) continue;
				const text = decoder.decode(chunk, { stream: true });
				if (text.trim()) {
					console.debug("[engine-worker stderr]", text.trimEnd());
				}
			}
		})().catch(() => {});
	}

	private handleLine(line: string): void {
		// Version probe has priority: deliver the line to it if waiting.
		if (this.versionProbeResolve) {
			this.versionProbeResolve(line);
			this.versionProbeResolve = null;
			this.versionProbeReject = null;
			return;
		}

		const inflight = this.inFlight;
		if (!inflight) {
			// Unexpected line with no request in flight — protocol anomaly.
			console.warn(
				"[engine-worker] received line with no in-flight request:",
				line.slice(0, 200),
			);
			return;
		}

		clearTimeout(inflight.timer);
		this.inFlight = null;

		let parsed: LayoutResult;
		try {
			parsed = JSON.parse(line) as LayoutResult;
		} catch {
			inflight.resolve({
				layout: null,
				errors: [
					{
						message: `Engine protocol error: response is not valid JSON. Line: ${line.slice(0, 200)}`,
					},
				],
			});
			this.drainPending();
			return;
		}

		const hasErrors = parsed.errors && parsed.errors.length > 0;
		const hasPages = parsed.pages && parsed.pages.length > 0;

		if (hasErrors && !hasPages) {
			// Error envelope: layout is null.
			inflight.resolve({ layout: null, errors: parsed.errors });
		} else {
			inflight.resolve({
				layout: parsed,
				errors: parsed.errors ?? [],
			});
		}

		this.drainPending();
	}

	private drainPending(): void {
		if (!this.pending || this.inFlight) return;

		const { content, resolve } = this.pending;
		this.pending = null;

		// Convert any worker-lifecycle error to the response envelope so the
		// pending caller sees a consistent shape (no unhandled rejections).
		const toEnvelope = (err: unknown): GetLayoutResponse => ({
			layout: null,
			errors: [{ message: toErrorMessage(err) }],
		});

		// Ensure the worker is alive before dispatching.
		if (!this.proc) {
			// Spawn lazily — serialise via spawnPromise.
			if (!this.spawnPromise) {
				this.spawnPromise = this.spawn().finally(() => {
					this.spawnPromise = null;
				});
			}
			this.spawnPromise
				.then(() => this.dispatch(content))
				.then(resolve)
				.catch((err) => resolve(toEnvelope(err)));
			return;
		}

		this.dispatch(content).then(resolve).catch((err) => resolve(toEnvelope(err)));
	}

	private onProcExited(code: number | null): void {
		this.proc = null;

		// If the version probe was in-flight, reject it.
		if (this.versionProbeReject) {
			this.versionProbeReject(
				new Error(`Engine worker exited (code ${code}) during version probe.`),
			);
			this.versionProbeResolve = null;
			this.versionProbeReject = null;
		}

		if (this.inFlight) {
			const inflight = this.inFlight;
			this.inFlight = null;
			clearTimeout(inflight.timer);
			inflight.resolve({
				layout: null,
				errors: [
					{
						message: `Engine worker exited unexpectedly (code ${code}). Request failed.`,
					},
				],
			});
		}

		// Drain pending: spawn will be triggered inside drainPending → dispatch.
		this.drainPending();
	}

	private killProc(): void {
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {
				// Already dead.
			}
			this.proc = null;
		}
		// Don't null spawnPromise here — a concurrent spawn may be in progress
		// and its .finally() will clear it when it settles.
	}

	/** Tear down the worker and settle any in-flight/pending requests. */
	shutdown(): void {
		this.closed = true;
		if (this.pending) {
			this.pending.resolve({ layout: null, errors: [], superseded: true });
			this.pending = null;
		}
		if (this.inFlight) {
			clearTimeout(this.inFlight.timer);
			this.inFlight.resolve({
				layout: null,
				errors: [{ message: "Worker shut down." }],
			});
			this.inFlight = null;
		}
		if (this.versionProbeReject) {
			this.versionProbeReject(new Error("Worker shut down."));
			this.versionProbeResolve = null;
			this.versionProbeReject = null;
		}
		this.killProc();
	}
}

// Module-level singleton.
let _instance: EngineWorker | undefined;

export function getEngineWorker(): EngineWorker {
	_instance ??= new EngineWorker();
	return _instance;
}
