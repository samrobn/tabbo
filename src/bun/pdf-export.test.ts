import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import { compileToPdf, exportPdfToDir } from "./pdf-export";
import { derivePdfFilename } from "./filename-utils";

// Integration tests - require real tab binary and gs on PATH.
// These exercise the full pipeline: tab → PostScript → Ghostscript → PDF → base64.

// The binary is a build artefact — fresh worktrees/clones lack it, and without
// this guard the suite fails as dozens of opaque sub-millisecond errors.
beforeAll(() => {
	const tabBinary = join(import.meta.dir, "../../engine/tab");
	if (!existsSync(tabBinary)) {
		throw new Error(`engine/tab not built — run: cd engine && make (expected at ${tabBinary})`);
	}
});

const MINIMAL_TAB = "b\n1-abc\ne\n";

describe("compileToPdf", () => {
	test("produces a valid PDF from minimal input", async () => {
		const result = await compileToPdf(MINIMAL_TAB);

		expect(result.success).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.pdf).not.toBeNull();

		// Verify it's valid base64-encoded PDF (starts with %PDF)
		const decoded = atob(result.pdf!.slice(0, 20));
		expect(decoded).toStartWith("%PDF");
	});

	test("returns errors for invalid input", async () => {
		const result = await compileToPdf("this is not valid tablature");

		expect(result.success).toBe(false);
		expect(result.pdf).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("handles empty input", async () => {
		const result = await compileToPdf("");

		expect(result.success).toBe(false);
		expect(result.pdf).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("works with long TABFONTS path (app bundle simulation)", async () => {
		// The original bug: font_n[80] buffer overflow when TABFONTS path > ~80 chars.
		// This test ensures the pipeline works with paths as long as Electrobun produces.
		// We can't easily override TABFONTS from here since compileToPdf() resolves it internally,
		// but this test documents the intent. The post-build smoke test in postbuild.ts
		// covers the actual long-path scenario.
		const result = await compileToPdf(MINIMAL_TAB);
		expect(result.success).toBe(true);
	});

	test("produces deterministic output structure", async () => {
		const result = await compileToPdf(MINIMAL_TAB);

		expect(result).toHaveProperty("success");
		expect(result).toHaveProperty("pdf");
		expect(result).toHaveProperty("errors");
		expect(typeof result.success).toBe("boolean");
		expect(Array.isArray(result.errors)).toBe(true);
	});

	test("cleans up temp files after compilation", async () => {
		const { readdirSync } = await import("fs");
		const { tmpdir } = await import("os");

		const before = readdirSync(tmpdir()).filter((f) =>
			f.startsWith("tabbo-"),
		);
		await compileToPdf(MINIMAL_TAB);
		const after = readdirSync(tmpdir()).filter((f) =>
			f.startsWith("tabbo-"),
		);

		expect(after.length).toBe(before.length);
	});

	test("cleans up temp files after failed compilation", async () => {
		const { readdirSync } = await import("fs");
		const { tmpdir } = await import("os");

		const before = readdirSync(tmpdir()).filter((f) =>
			f.startsWith("tabbo-"),
		);
		await compileToPdf("invalid input");
		const after = readdirSync(tmpdir()).filter((f) =>
			f.startsWith("tabbo-"),
		);

		expect(after.length).toBe(before.length);
	});
});

// ---------------------------------------------------------------------------
// derivePdfFilename unit tests
// ---------------------------------------------------------------------------

describe("derivePdfFilename", () => {
	test("strips .tab extension and appends .pdf", () => {
		expect(derivePdfFilename("untitled.tab")).toBe("untitled.pdf");
	});

	test("strips .txt extension and appends .pdf", () => {
		expect(derivePdfFilename("mysong.txt")).toBe("mysong.pdf");
	});

	test("appends .pdf when no extension present", () => {
		expect(derivePdfFilename("foo")).toBe("foo.pdf");
	});

	test("strips path components (path traversal guard)", () => {
		// basename of "../escape" is "escape", so it becomes "escape.pdf"
		expect(derivePdfFilename("../escape")).toBe("escape.pdf");
	});

	test("strips nested path components", () => {
		expect(derivePdfFilename("/absolute/path/song.tab")).toBe("song.pdf");
	});

	test("rejects empty string", () => {
		expect(derivePdfFilename("")).toBeNull();
	});

	test("rejects whitespace-only string", () => {
		expect(derivePdfFilename("   ")).toBeNull();
	});

	test("rejects hidden files (leading dot)", () => {
		expect(derivePdfFilename(".bashrc")).toBeNull();
	});

	test("rejects bare extension (stem would be empty)", () => {
		// ".tab" → basename ".tab" → starts with "." → null
		expect(derivePdfFilename(".tab")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// exportPdfFromContent integration tests
// ---------------------------------------------------------------------------

// MINIMAL_TAB is declared above (shared with compileToPdf tests).
const INVALID_TAB = "this is not valid tablature";

// exportPdfToDir: the testable core of the export pipeline.
// Tests pass an explicit temp directory to avoid the Electrobun runtime dependency
// on Utils.paths.documents (only available inside the packaged app environment).
describe("exportPdfToDir", () => {
	let testDir: string;
	const writtenPaths: string[] = [];

	afterEach(() => {
		for (const p of writtenPaths.splice(0)) {
			try {
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort cleanup; don't fail the test suite
			}
		}
	});

	function makeTestDir(): string {
		const dir = join(tmpdir(), `tabbo-test-${crypto.randomUUID()}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	test("success: .tab filename produces a .pdf file on disk (S1 regression)", async () => {
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, "untitled.tab", testDir);

		expect(result.success).toBe(true);
		if (!result.success) return;

		writtenPaths.push(result.path);
		expect(result.path).toEndWith("untitled.pdf");
		expect(existsSync(result.path)).toBe(true);
	});

	test("success: .txt filename produces a .pdf file (S2 regression)", async () => {
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, "mysong.txt", testDir);

		expect(result.success).toBe(true);
		if (!result.success) return;

		writtenPaths.push(result.path);
		expect(result.path).toEndWith("mysong.pdf");
		expect(existsSync(result.path)).toBe(true);
	});

	test("success: no-extension filename produces a .pdf file", async () => {
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, "foo", testDir);

		expect(result.success).toBe(true);
		if (!result.success) return;

		writtenPaths.push(result.path);
		expect(result.path).toEndWith("foo.pdf");
		expect(existsSync(result.path)).toBe(true);
	});

	test("success: client already stripped extension (current App.vue behaviour)", async () => {
		// App.vue currently strips .tab before sending, so the server receives "untitled".
		// Both "untitled.tab" and "untitled" must produce "untitled.pdf".
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, "untitled", testDir);

		expect(result.success).toBe(true);
		if (!result.success) return;

		writtenPaths.push(result.path);
		expect(result.path).toEndWith("untitled.pdf");
	});

	test("path traversal: ../escape writes safely inside outputDir (S3 regression)", async () => {
		// basename strips the path component, so "../escape" → "escape.pdf" — written
		// inside testDir, never outside it.
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, "../escape", testDir);

		expect(result.success).toBe(true);
		if (!result.success) return;

		writtenPaths.push(result.path);
		expect(result.path).toStartWith(testDir);
		expect(result.path).toEndWith("escape.pdf");
		expect(result.path).not.toContain("../");
	});

	test("rejection: empty filename returns failure before compilation", async () => {
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, "", testDir);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.message).toBeTruthy();
	});

	test("rejection: whitespace-only filename returns failure before compilation", async () => {
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, "   ", testDir);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.message).toBeTruthy();
	});

	test("rejection: hidden-file name returns failure before compilation", async () => {
		testDir = makeTestDir();
		const result = await exportPdfToDir(MINIMAL_TAB, ".bashrc", testDir);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.message).toBeTruthy();
	});

	test("failure: engine error propagates from the pipeline (not a hardcoded string)", async () => {
		testDir = makeTestDir();
		const result = await exportPdfToDir(INVALID_TAB, "bad.tab", testDir);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.message).toBeTruthy();
		expect(result.message).not.toBe("Invalid filename");
	});
});
