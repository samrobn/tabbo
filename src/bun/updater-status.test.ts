import { describe, expect, test } from "bun:test";
import {
	buildChangelogUrl,
	electrobunStatusToPhase,
} from "./updater-status";

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
		"complete",
	] as const)("%s → ready", (status) => {
		expect(electrobunStatusToPhase(status)).toEqual({ phase: "ready" });
	});

	test("error prefers details.errorMessage over entry.message", () => {
		expect(
			electrobunStatusToPhase(
				"error",
				{ errorMessage: "from details" },
				"from entry",
			),
		).toEqual({ phase: "error", message: "from details" });
	});

	test("error falls back to entry.message when details.errorMessage is absent (the common case)", () => {
		expect(electrobunStatusToPhase("error", undefined, "HTTP 404")).toEqual({
			phase: "error",
			message: "HTTP 404",
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
		"downloading",
	] as const)(
		"%s → null (internal bookkeeping, no UI broadcast)",
		(status) => {
			expect(electrobunStatusToPhase(status)).toBeNull();
		},
	);
});
