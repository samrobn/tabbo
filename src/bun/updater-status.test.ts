import { describe, expect, test } from "bun:test";
import type { UpdateStatusEntry } from "electrobun/main";
import {
	buildChangelogUrl,
	electrobunStatusToPhase,
	applyFailureMessage,
	downloadOutcome,
	shouldRelayEntry,
} from "./updater-status";

const entry = (status: UpdateStatusEntry["status"], details?: UpdateStatusEntry["details"]): UpdateStatusEntry => ({
	status,
	message: "",
	timestamp: 0,
	...(details ? { details } : {}),
});

describe("shouldRelayEntry", () => {
	test("download and apply progress is relayed", () => {
		expect(shouldRelayEntry(entry("download-starting"))).toBe(true);
		expect(shouldRelayEntry(entry("downloading"))).toBe(true);
		expect(shouldRelayEntry(entry("download-complete"))).toBe(true);
		expect(shouldRelayEntry(entry("applying"))).toBe(true);
	});

	// The webview uses these only to hide the update dialog, so every
	// background check knocked it out of "Restart now", a download, or an error.
	test("check bookkeeping is not relayed", () => {
		expect(shouldRelayEntry(entry("checking"))).toBe(false);
		expect(shouldRelayEntry(entry("idle"))).toBe(false);
		expect(shouldRelayEntry(entry("no-update"))).toBe(false);
	});

	// Check, download, and apply outcomes come from the updater's state after
	// each call, not from events the client may read late or replay stale.
	test("an operation's error event is not relayed", () => {
		expect(shouldRelayEntry(entry("error", { errorMessage: "offline" }))).toBe(false);
	});

	test("a failed install found on relaunch is relayed - only it carries latestHash", () => {
		expect(shouldRelayEntry(entry("error", { currentHash: "a", latestHash: "b", errorMessage: "denied" }))).toBe(true);
	});
});

describe("downloadOutcome", () => {
	const info = { version: "1.2.3", hash: "h", updateAvailable: true, updateReady: false, error: "" };

	test("a prepared update is ready", () => {
		expect(downloadOutcome({ ...info, updateReady: true })).toEqual({ phase: "ready" });
	});

	test("a failed download is an error with the updater's message", () => {
		expect(downloadOutcome({ ...info, error: "Failed to download update: HttpStatus" })).toEqual({
			phase: "error",
			message: "Failed to download update: HttpStatus",
		});
	});

	// The error slot is shared: a check queued behind the download can clear it
	// before it is read, and a cancelled download sets none. Never leave the
	// dialog on "Downloading".
	test("neither ready nor failed is still an error", () => {
		expect(downloadOutcome(info)).toEqual({ phase: "error", message: "The update could not be downloaded" });
	});
});

describe("applyFailureMessage", () => {
	const info = { version: "1.2.3", hash: "h", updateAvailable: true, updateReady: true, error: "" };

	test("a new updater error is a failure", () => {
		expect(applyFailureMessage({ ...info, error: "Cannot apply update: denied" }, "", [])).toBe("Cannot apply update: denied");
	});

	test("an error left from an earlier check is not this apply's failure", () => {
		const stale = "Failed to check for updates: offline";
		expect(applyFailureMessage({ ...info, error: stale }, stale, [entry("applying"), entry("launching-new-version")])).toBeNull();
	});

	test("a repeat of the same error is still a failure when this apply logged it", () => {
		const repeated = "Cannot apply update: denied";
		expect(applyFailureMessage({ ...info, error: repeated }, repeated, [{ ...entry("error"), message: repeated }])).toBe(repeated);
	});

	test("a refused quit or nothing to apply is a failure", () => {
		expect(applyFailureMessage(info, "", [{ ...entry("idle"), message: "Update restart was cancelled" }])).toBe("Update restart was cancelled");
		expect(applyFailureMessage(info, "", [{ ...entry("no-update"), message: "Direct updates are disabled" }])).toBe("Direct updates are disabled");
	});

	test("an apply under way is not a failure", () => {
		expect(applyFailureMessage(info, "", [entry("applying"), entry("launching-new-version")])).toBeNull();
	});
});

describe("buildChangelogUrl", () => {
	test("appends /CHANGELOG.md to a clean base URL", () => {
		expect(
			buildChangelogUrl("https://github.com/owner/repo/releases/latest/download"),
		).toBe(
			"https://github.com/owner/repo/releases/latest/download/CHANGELOG.md",
		);
	});

	test("strips a single trailing slash before joining", () => {
		expect(
			buildChangelogUrl("https://github.com/owner/repo/releases/latest/download/"),
		).toBe(
			"https://github.com/owner/repo/releases/latest/download/CHANGELOG.md",
		);
	});

	test("strips multiple trailing slashes", () => {
		expect(buildChangelogUrl("https://example.com///")).toBe(
			"https://example.com/CHANGELOG.md",
		);
	});
});

describe("electrobunStatusToPhase", () => {
	test("idle → idle", () => {
		expect(electrobunStatusToPhase("idle")).toEqual({ phase: "idle" });
	});

	test("checking → checking", () => {
		expect(electrobunStatusToPhase("checking")).toEqual({ phase: "checking" });
	});

	test("update-available → null (broadcast is suppressed; checkForUpdate RPC carries the real payload)", () => {
		// Regression: Electrobun emits update-available synchronously during
		// checkForUpdate(), before the RPC response resolves. If we broadcast
		// with null version+changelog the webview's snooze guard breaks (see
		// header comment in updater-status.ts).
		expect(electrobunStatusToPhase("update-available")).toBeNull();
	});

	test("no-update → idle (no separate phase for the absence of an update)", () => {
		expect(electrobunStatusToPhase("no-update")).toEqual({ phase: "idle" });
	});

	test.each([
		"download-starting",
		"downloading-patch",
		"downloading-full-bundle",
		"download-progress",
		"decompressing",
		"checking-local-tar",
		"applying-patch",
		"downloading",
	] as const)("%s → downloading", (status) => {
		expect(electrobunStatusToPhase(status, { progress: 42 })).toEqual({
			phase: "downloading",
			progress: 42,
		});
	});

	test("downloading carries null progress when details omit it", () => {
		expect(electrobunStatusToPhase("download-progress")).toEqual({
			phase: "downloading",
			progress: null,
		});
	});

	test.each([
		"download-complete",
		"applying",
		"extracting",
		"replacing-app",
		"launching-new-version",
	] as const)("%s → ready", (status) => {
		expect(electrobunStatusToPhase(status)).toEqual({ phase: "ready" });
	});

	test("complete → null: 2.x also emits it when a relaunch reconciles an update already installed", () => {
		expect(electrobunStatusToPhase("complete")).toBeNull();
	});

	test("error prefers entry.message (2.x: the prefixed, readable text) over details.errorMessage (the bare detail)", () => {
		expect(
			electrobunStatusToPhase(
				"error",
				{ errorMessage: "HttpStatus" },
				"Failed to check for updates: HttpStatus",
			),
		).toEqual({ phase: "error", message: "Failed to check for updates: HttpStatus" });
	});

	test("error falls back to details.errorMessage when entry.message is empty", () => {
		expect(electrobunStatusToPhase("error", { errorMessage: "HTTP 404" }, "")).toEqual({
			phase: "error",
			message: "HTTP 404",
		});
	});

	test("error falls back to a generic string when both are empty", () => {
		expect(electrobunStatusToPhase("error", { errorMessage: "" }, "")).toEqual({
			phase: "error",
			message: "Update failed",
		});
	});

	test("error falls back to a generic string when both are missing", () => {
		expect(electrobunStatusToPhase("error")).toEqual({
			phase: "error",
			message: "Update failed",
		});
	});

	test("patch-failed uses the patch-specific generic fallback", () => {
		expect(electrobunStatusToPhase("patch-failed")).toEqual({
			phase: "error",
			message: "Patch application failed",
		});
	});

	test.each([
		"local-tar-found",
		"local-tar-missing",
		"fetching-patch",
		"patch-found",
		"patch-not-found",
		"patch-applied",
		"extracting-version",
		"patch-chain-complete",
		"check-complete",
	] as const)(
		"%s → null (internal bookkeeping, no UI broadcast)",
		(status) => {
			expect(electrobunStatusToPhase(status)).toBeNull();
		},
	);
});
