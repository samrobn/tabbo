import type {
	UpdateStatusDetails,
	UpdateStatusEntry,
	UpdateStatusType,
} from "electrobun/main";
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
 * Electrobun 2.x's native updater emits only `idle`, `checking`,
 * `update-available`, `no-update`, `download-starting`, `downloading`,
 * `download-complete`, `applying`, `launching-new-version`, `complete`, and
 * `error`, and never a `progress` value; the other names stay in the type for
 * source compatibility and keep their 1.x mapping below. So on 2.x the download
 * phase shows the modal's indeterminate bar throughout.
 *
 * Mapping rationale:
 * - `idle` → idle (nothing has started)
 * - `checking` → checking (the HTTP fetch is in flight)
 * - `update-available` → null = no broadcast. Electrobun delivers this
 *   BEFORE the awaited `Updater.checkForUpdate()` resolves with the real
 *   version + changelog (1.x emitted it synchronously; 2.x's client notifies
 *   listeners from its event poll before resolving the check), with no version. If we broadcast it
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
 * - `downloading` → downloading (2.x: the whole native download-and-prepare
 *   step and the only status during it, so it must restore the dialog if a
 *   re-check knocked the phase back mid-download)
 * - `download-complete` → ready (Electrobun sets `updateInfo.updateReady = true`
 *   immediately before emitting this; the tar is fully extracted and
 *   `applyUpdate()` will succeed without further network access)
 * - `applying`, `extracting`, `replacing-app`, `launching-new-version` → ready
 *   (apply path; app is about to quit and relaunch — keep UI in `ready` state
 *   so the modal copy doesn't flicker)
 * - `error`, `patch-failed` → error (prefer `entry.message`: 2.x puts the
 *   readable "Failed to download update: <detail>" text there and only the bare
 *   detail, possibly a raw error name, in `details.errorMessage`; then
 *   `details.errorMessage`, then a generic string)
 *
 * Deliberately mapped to null = no broadcast:
 * - `update-available` — see dedicated bullet above.
 * - `local-tar-found`, `local-tar-missing`, `fetching-patch`, `patch-found`,
 *   `patch-not-found`, `patch-applied`, `extracting-version`,
 *   `patch-chain-complete` — internal patch-chain bookkeeping events.
 *   Download phase is already active; broadcasting them would just cause UI
 *   flicker with no signal.
 * - `check-complete` — in the union but never emitted in practice.
 * - `complete` — the apply path already shows `ready`, and 2.x also emits it
 *   when a relaunch reconciles an update that is already installed, which
 *   must not offer "Restart now" again.
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
		case "downloading":
			return {
				phase: "downloading",
				progress: details?.progress ?? null,
			};

		case "download-complete":
		case "applying":
		case "extracting":
		case "replacing-app":
		case "launching-new-version":
			return { phase: "ready" };

		case "error":
			return {
				phase: "error",
				message:
					entryMessage || details?.errorMessage || "Update failed",
			};

		case "patch-failed":
			return {
				phase: "error",
				message:
					entryMessage ||
					details?.errorMessage ||
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
		case "complete":
			return null;

		default: {
			const _exhaustive: never = status;
			void _exhaustive;
			return null;
		}
	}
}

/**
 * Whether to relay a status entry to the webview. Check, download, and apply
 * outcomes come from the updater after each call (`checkForUpdate`'s own
 * result, `downloadOutcome`, `applyFailureMessage`), because Electrobun 2.x's
 * client can resolve an operation before reading its last event, and replays
 * stale events to the next listener. So `error` events are not relayed -
 * except a failed install the native core finds when the app relaunches, which
 * no call returns and which alone carries `latestHash`. Nor are `checking`,
 * `idle`, and `no-update`: the webview uses them only to hide the update
 * dialog, so each background check knocked it out of "Restart now", a
 * download, or that relaunch error.
 */
export function shouldRelayEntry(entry: UpdateStatusEntry): boolean {
	if (entry.status === "checking" || entry.status === "idle" || entry.status === "no-update") return false;
	return entry.status !== "error" || entry.details?.latestHash !== undefined;
}

/** The fields of `Updater.updateInfo()` the outcomes read; electrobun/main doesn't export its type. */
export interface UpdaterState {
	updateReady: boolean;
	error: string;
}

/**
 * What a finished download shows. `updateInfo()` is one slot shared by every
 * operation: a check queued behind the download can clear its error before it
 * is read, and a cancelled download sets none - so anything short of ready is
 * an error, never nothing, which would leave the dialog on "Downloading".
 */
export function downloadOutcome(info: UpdaterState): UpdateStatus {
	if (info.updateReady) return { phase: "ready" };
	return { phase: "error", message: info.error || "The update could not be downloaded" };
}

/**
 * Why an apply failed, or null. On 2.x `applyUpdate()` also resolves on
 * success, as the graceful quit starts, so only evidence from this call counts:
 * an `error`, a refused quit (`idle`), or nothing to apply (`no-update`) among
 * the statuses it logged, or an updater error that differs from the one before
 * it started (the slot keeps an earlier failed check's error).
 */
export function applyFailureMessage(info: UpdaterState, errorBefore: string, entriesDuringApply: UpdateStatusEntry[]): string | null {
	const failure = entriesDuringApply.find(
		(entry) => entry.status === "error" || entry.status === "idle" || entry.status === "no-update",
	);
	if (failure) return failure.message || info.error || "The update could not be applied";
	if (info.error && info.error !== errorBefore) return info.error;
	return null;
}
