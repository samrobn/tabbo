import { Updater } from "electrobun/bun";
import type { UpdateInfo, UpdateStatus } from "../shared/rpc-types";
import { parseChangelog } from "./changelog-parser";
import {
	buildChangelogUrl,
	electrobunStatusToPhase,
} from "./updater-status";

type StatusSender = (status: UpdateStatus) => void;

/**
 * Register a callback that receives UpdateStatus whenever the Electrobun
 * update state machine transitions. Call once after the main window is created.
 *
 * The callback is wired to Electrobun's `onStatusChange`, which fires
 * synchronously during checkForUpdate / downloadUpdate / applyUpdate.
 */
export function subscribeToUpdateStatus(send: StatusSender): void {
	Updater.onStatusChange((entry) => {
		const mapped = electrobunStatusToPhase(
			entry.status,
			entry.details,
			entry.message,
		);
		if (mapped !== null) {
			send(mapped);
		}
	});
}

/**
 * Check for an available update and return structured info.
 *
 * Returns `{ available: false, version: null, changelog: null }` for:
 * - dev channel (Electrobun returns no-update immediately)
 * - network failures (don't surface scary errors to the user; silent retry
 *   is expected from the frontend on the next check interval)
 *
 * On success, fetches CHANGELOG.md from the release asset URL so we always
 * show the *next* version's changelog, not the currently-installed one.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
	try {
		const result = await Updater.checkForUpdate();

		if (!result.updateAvailable) {
			return { available: false, version: null, changelog: null };
		}

		const version = result.version ?? null;
		let changelog: string | null = null;

		if (version) {
			try {
				const baseUrl = await Updater.localInfo.baseUrl();
				const changelogUrl = buildChangelogUrl(baseUrl);
				const response = await fetch(changelogUrl, {
					signal: AbortSignal.timeout(5000),
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
	} catch {
		return { available: false, version: null, changelog: null };
	}
}

/**
 * Begin downloading the update bundle. Fire-and-forget from the RPC handler;
 * progress is pushed to the webview via `subscribeToUpdateStatus`.
 *
 * Errors are surfaced as `error` phase events through the subscriber, not as
 * thrown exceptions, so the RPC handler can return immediately.
 */
export async function startUpdateDownload(): Promise<void> {
	try {
		await Updater.downloadUpdate();
	} catch (err) {
		// Electrobun's downloadUpdate doesn't throw on network errors — it emits
		// status events instead. This catch is a safety net for unexpected throws.
		console.error("[tabbo] Unexpected error during update download:", err);
	}
}

/**
 * Quit and relaunch into the downloaded update.
 * Only call after a `ready` status has been received. Calls Electrobun's
 * `applyUpdate`, which replaces the app bundle and relaunches; the process
 * will not return from this call on success.
 *
 * Errors are re-thrown so the RPC handler can surface them to the webview's
 * try/catch — otherwise a silent failure (corrupt tar, permissions, signing
 * mismatch) leaves the Restart button permanently disabled with no recovery.
 */
export async function applyDownloadedUpdate(): Promise<void> {
	try {
		await Updater.applyUpdate();
	} catch (err) {
		console.error("[tabbo] Unexpected error applying update:", err);
		throw err;
	}
}
