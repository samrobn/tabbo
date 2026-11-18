import { Updater } from "electrobun/main";
import type { UpdateInfo, UpdateStatus } from "../shared/rpc-types";
import { parseChangelog } from "./changelog-parser";
import { applyFailureMessage, buildChangelogUrl, downloadOutcome } from "./updater-status";
import { createStatusRelay } from "./update-relay";

// Changelog fetch is best-effort (see checkForUpdate); keep it short so a
// slow/unreachable host doesn't stall the update check the user is waiting on.
const CHANGELOG_FETCH_TIMEOUT_MS = 5_000;

const statusRelay = createStatusRelay(Updater);

/**
 * Set where UpdateStatus pushes go. Call once after the main window is created.
 * Statuses are relayed only while a check, download, or apply runs (see
 * update-relay.ts).
 */
export function subscribeToUpdateStatus(send: (status: UpdateStatus) => void): void {
	statusRelay.setSender(send);
}

/**
 * Check for an available update and return structured info.
 *
 * Returns `{ available: false, version: null, changelog: null }` when there is
 * no update (the dev channel always says so). A failed check rejects - Electrobun
 * 2.x resolves it with the reason in `error` - and the webview shows that only
 * for a check the user asked for; background checks stay silent and retry on
 * the next interval.
 *
 * On success, fetches CHANGELOG.md from the release asset URL so we always
 * show the *next* version's changelog, not the currently-installed one.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
	const result = await statusRelay.around(() => Updater.checkForUpdate());
	if (result.error) throw new Error(result.error);

	if (!result.updateAvailable) {
		return { available: false, version: null, changelog: null };
	}

	const version = result.version || null;
	let changelog: string | null = null;

	if (version) {
		try {
			const baseUrl = await Updater.localInfo.baseUrl();
			const changelogUrl = buildChangelogUrl(baseUrl);
			const response = await fetch(changelogUrl, {
				signal: AbortSignal.timeout(CHANGELOG_FETCH_TIMEOUT_MS),
			});
			if (response.ok) {
				const changelogText = await response.text();
				changelog = parseChangelog(changelogText, version);
			}
		} catch {
			// Changelog is best-effort; don't fail the update check if it's missing
		}
	}

	return { available: true, version, changelog };
}

/**
 * Begin downloading the update bundle. Fire-and-forget from the RPC handler;
 * progress is pushed to the webview via `subscribeToUpdateStatus`, and the
 * outcome - ready or failed - from the updater's state once the download ends.
 */
export async function startUpdateDownload(): Promise<void> {
	try {
		await statusRelay.around(() => Updater.downloadUpdate());
	} catch (err) {
		// A safety net: 2.x resolves a failed download and reports it in state.
		console.error("[tabbo] Unexpected error during update download:", err);
	}
	statusRelay.push(downloadOutcome(Updater.updateInfo()));
}

/**
 * Quit and relaunch into the downloaded update.
 * Only call after a `ready` status has been received. Calls Electrobun's
 * `applyUpdate`, which starts a graceful quit and hands the replacement to a
 * helper that relaunches the app; on 2.x the call resolves either way.
 *
 * Failures are thrown so the RPC handler can surface them to the webview's
 * try/catch — otherwise a silent failure (corrupt tar, permissions, signing
 * mismatch) leaves the Restart button permanently disabled with no recovery.
 * Electrobun 2.x resolves `applyUpdate()` even then; `applyFailureMessage`
 * reads why from the updater's state and the statuses logged during the call.
 */
export async function applyDownloadedUpdate(): Promise<void> {
	const historyBefore = Updater.getStatusHistory().length;
	const errorBefore = Updater.updateInfo().error;
	try {
		await statusRelay.around(() => Updater.applyUpdate());
	} catch (err) {
		console.error("[tabbo] Unexpected error applying update:", err);
		throw err;
	}
	const failure = applyFailureMessage(Updater.updateInfo(), errorBefore, Updater.getStatusHistory().slice(historyBefore));
	if (failure) {
		// The error event isn't relayed (see shouldRelayEntry), so show it here.
		statusRelay.push({ phase: "error", message: failure });
		throw new Error(failure);
	}
}
