import type {
	UpdateStatusType,
	UpdateStatusDetails,
} from "electrobun/bun";
import type { UpdateStatus } from "../shared/rpc-types";

/**
 * Pure helpers split out of `updater.ts` so they can be unit-tested without
 * triggering Electrobun's module-level `Updater` init (which reads the bundled
 * `version.json` and fails with ENOENT outside a built app — same pattern as
 * `vite-probe.ts` extracted from `index.ts`).
 */

/**
 * Build the absolute URL for the release-asset CHANGELOG.md given the base URL
 * exposed by `Updater.localInfo.baseUrl()`. Strips trailing slashes from the
 * base before joining so we never produce `…//CHANGELOG.md`.
 */
export function buildChangelogUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/CHANGELOG.md`;
}

/**
 * Maps Electrobun's 26-value UpdateStatusType enum to our 6-phase UpdateStatus.
 *
 * Mapping rationale:
 * - `idle` → idle (nothing has started)
 * - `checking` → checking (the HTTP fetch is in flight)
 * - `update-available` → null = no broadcast. Electrobun emits this
 *   synchronously during `Updater.checkForUpdate()`, BEFORE the awaited RPC
 *   response resolves with the real version + changelog. If we broadcast it
 *   here with `version: null`, the webview's snooze guard (which keys off
 *   `status.version`) gets bypassed and the modal opens blank; the
 *   subsequent real response then no-ops past the snooze without clearing
 *   the open modal. Rely exclusively on the `checkForUpdate` RPC response
 *   for surfacing the available phase.
 * - `no-update` → idle (no update found; UI stays at rest)
 * - `download-starting`, `downloading-patch`, `downloading-full-bundle`,
 *   `download-progress`, `decompressing` → downloading (the bundle/patch chain
 *   is being fetched and unpacked — not yet safe to call applyUpdate)
 * - `checking-local-tar` → downloading (patch-path pre-flight; keep progress
 *   bar pulsing rather than freezing)
 * - `applying-patch` → downloading (multi-patch chains spend long stretches
 *   here; map it to keep the bar moving)
 * - `download-complete` → ready (Electrobun sets `updateInfo.updateReady = true`
 *   immediately before emitting this; the tar is fully extracted and
 *   `applyUpdate()` will succeed without further network access)
 * - `applying`, `extracting`, `replacing-app`, `launching-new-version`,
 *   `complete` → ready (apply path; app is about to quit and relaunch — keep
 *   UI in `ready` state so the modal copy doesn't flicker)
 * - `error`, `patch-failed` → error (prefer `details.errorMessage`, fall back
 *   to `entry.message` since the common error sites in `Updater.ts` only set
 *   the latter, then to a generic string)
 *
 * Deliberately mapped to null = no broadcast:
 * - `update-available` — see dedicated bullet above.
 * - `local-tar-found`, `local-tar-missing`, `fetching-patch`, `patch-found`,
 *   `patch-not-found`, `patch-applied`, `extracting-version`,
 *   `patch-chain-complete` — internal patch-chain bookkeeping events.
 *   Download phase is already active; broadcasting them would just cause UI
 *   flicker with no signal.
 * - `check-complete` — in the union but never emitted in practice.
 * - `downloading` — parent-level aggregate; the granular sub-statuses already
 *   carry the real progress.
 *
 * The `default:` clause uses `const _exhaustive: never = status` so that any
 * future Electrobun upgrade adding a new status fails the TypeScript build
 * here, rather than silently dropping events at runtime.
 */
export function electrobunStatusToPhase(
	status: UpdateStatusType,
	details?: UpdateStatusDetails,
	entryMessage?: string,
): UpdateStatus | null {
	switch (status) {
		case "idle":
			return { phase: "idle" };

		case "checking":
			return { phase: "checking" };

		case "no-update":
			return { phase: "idle" };

		case "download-starting":
		case "downloading-patch":
		case "downloading-full-bundle":
		case "download-progress":
		case "decompressing":
		case "checking-local-tar":
		case "applying-patch":
			return {
				phase: "downloading",
				progress: details?.progress ?? null,
			};

		case "download-complete":
		case "applying":
		case "extracting":
		case "replacing-app":
		case "launching-new-version":
		case "complete":
			return { phase: "ready" };

		case "error":
			return {
				phase: "error",
				message:
					details?.errorMessage ?? entryMessage ?? "Update failed",
			};

		case "patch-failed":
			return {
				phase: "error",
				message:
					details?.errorMessage ??
					entryMessage ??
					"Patch application failed",
			};

		case "update-available":
		case "local-tar-found":
		case "local-tar-missing":
		case "fetching-patch":
		case "patch-found":
		case "patch-not-found":
		case "patch-applied":
		case "extracting-version":
		case "patch-chain-complete":
		case "check-complete":
		case "downloading":
			return null;

		default: {
			const _exhaustive: never = status;
			void _exhaustive;
			return null;
		}
	}
}
