import { describe, expect, test } from "bun:test";
import { isSafeName, writePage, registerLuteFonts, registerBodyFonts, resolveFixturePath } from "./capture-server";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { GlobalFonts } from "@napi-rs/canvas";

// ---------------------------------------------------------------------------
// resolveFixturePath
// ---------------------------------------------------------------------------

// In production the resolver uses a path inside the .app bundle (at
// resources/fixtures/, alongside resources/fonts/ and resources/bin/).
// In tests we run from the source tree; pass the source-tree path explicitly
// so the resolver still produces meaningful paths to verify against.
const SRC_FIXTURES_DIR = resolve(process.cwd(), "evals/fixtures");

describe("resolveFixturePath", () => {
	test("joins dir + <source>.tab", () => {
		const result = resolveFixturePath("simple", SRC_FIXTURES_DIR);
		expect(result).toMatch(/evals\/fixtures\/simple\.tab$/);
		expect(result.startsWith("/")).toBe(true);
	});

	test("the source-tree simple.tab fixture file actually exists", () => {
		const path = resolveFixturePath("simple", SRC_FIXTURES_DIR);
		expect(existsSync(path)).toBe(true);
	});

	test("resolved content is non-empty text", async () => {
		const path = resolveFixturePath("simple", SRC_FIXTURES_DIR);
		const content = await Bun.file(path).text();
		expect(content.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// source param validation via isSafeName (same regex governs both name and source)
// ---------------------------------------------------------------------------

describe("source param validation (via isSafeName)", () => {
	test("accepts valid source names", () => {
		expect(isSafeName("simple")).toBe(true);
		expect(isSafeName("my-fixture")).toBe(true);
		expect(isSafeName("fixture_01")).toBe(true);
	});

	test("rejects slashes (path traversal)", () => {
		expect(isSafeName("../secret")).toBe(false);
		expect(isSafeName("sub/dir")).toBe(false);
	});

	test("rejects dots", () => {
		// A caller passing "simple.tab" would double the extension to simple.tab.tab —
		// reject so the extension is always controlled by the server.
		expect(isSafeName("simple.tab")).toBe(false);
		expect(isSafeName(".hidden")).toBe(false);
	});

	test("rejects empty string", () => {
		expect(isSafeName("")).toBe(false);
	});

	test("rejects spaces", () => {
		expect(isSafeName("my fixture")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isSafeName
// ---------------------------------------------------------------------------

describe("isSafeName", () => {
	test("accepts alphanumeric names", () => {
		expect(isSafeName("fixture1")).toBe(true);
		expect(isSafeName("MyFixture")).toBe(true);
		expect(isSafeName("abc123")).toBe(true);
	});

	test("accepts hyphens and underscores", () => {
		expect(isSafeName("my-fixture")).toBe(true);
		expect(isSafeName("my_fixture")).toBe(true);
		expect(isSafeName("a-b_c-1")).toBe(true);
	});

	test("rejects empty string", () => {
		expect(isSafeName("")).toBe(false);
	});

	test("rejects path traversal sequences", () => {
		expect(isSafeName("../etc/passwd")).toBe(false);
		expect(isSafeName("../../secret")).toBe(false);
	});

	test("rejects slashes", () => {
		expect(isSafeName("a/b")).toBe(false);
		expect(isSafeName("a\\b")).toBe(false);
	});

	test("rejects spaces", () => {
		expect(isSafeName("my fixture")).toBe(false);
	});

	test("rejects dots", () => {
		expect(isSafeName("my.fixture")).toBe(false);
		expect(isSafeName(".hidden")).toBe(false);
	});

	test("rejects shell-special characters", () => {
		expect(isSafeName("$(rm -rf)")).toBe(false);
		expect(isSafeName("name;cmd")).toBe(false);
		expect(isSafeName("name&other")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Font registration — lute fonts available to Skia's SVG renderer
// ---------------------------------------------------------------------------

describe("font registration", () => {
	test("registers lute, blute, and tlute families from the source-tree WOFF2 dir", () => {
		// Use the source-tree path rather than the built-app path so this test
		// exercises the real registration code path against the real fonts.
		// If the WOFF2 dir is missing (e.g. pre-build fresh clone), fail loudly
		// rather than vacuously passing.
		const woff2Dir = resolve(import.meta.dir, "../../engine/fonts/woff2");
		expect(existsSync(woff2Dir)).toBe(true);

		registerLuteFonts(woff2Dir);

		expect(GlobalFonts.has("lute9")).toBe(true);
		expect(GlobalFonts.has("blute85")).toBe(true);
		expect(GlobalFonts.has("tlute9")).toBe(true);
	});

	test("registers TabboBody from the source-tree body-fonts dir", () => {
		const bodyFontsDir = resolve(import.meta.dir, "../../assets/fonts");
		expect(existsSync(bodyFontsDir)).toBe(true);

		registerBodyFonts(bodyFontsDir);

		expect(GlobalFonts.has("TabboBody")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// writePage — integration (native canvas required)
// ---------------------------------------------------------------------------

const TINY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
  <rect width="10" height="10" fill="red"/>
</svg>`;

describe("writePage", () => {
	const dir = join(tmpdir(), `capture-test-${Date.now()}`);

	test("writes SVG and PNG files with correct 1-based page name", async () => {
		mkdirSync(dir, { recursive: true });

		const paths = await writePage(dir, "fixture", 0, TINY_SVG, 10, 10);

		expect(paths.svg).toBe(join(dir, "fixture-p1.svg"));
		expect(paths.png).toBe(join(dir, "fixture-p1.png"));
		expect(existsSync(paths.svg)).toBe(true);
		expect(existsSync(paths.png)).toBe(true);

		// PNG must start with the PNG magic bytes
		const header = new Uint8Array(await Bun.file(paths.png).arrayBuffer()).slice(0, 8);
		expect(header[0]).toBe(0x89); // PNG magic
		expect(header[1]).toBe(0x50); // P

		rmSync(dir, { recursive: true });
	});

	test("uses page index for 1-based naming (page index 2 → p3)", async () => {
		mkdirSync(dir, { recursive: true });

		const paths = await writePage(dir, "multi", 2, TINY_SVG, 10, 10);

		expect(paths.svg).toBe(join(dir, "multi-p3.svg"));
		expect(paths.png).toBe(join(dir, "multi-p3.png"));

		rmSync(dir, { recursive: true });
	});

	test("white bg produces different PNG bytes than transparent for the same SVG", async () => {
		// Sanity check that the fillRect is actually being applied. We don't
		// inspect pixel values — just confirm the encoded bytes differ, which they
		// will because the white fill changes pixel data in the IDAT chunk.
		mkdirSync(dir, { recursive: true });

		const whitePaths = await writePage(dir, "bg-white", 0, TINY_SVG, 10, 10, "white");
		const transparentPaths = await writePage(dir, "bg-transparent", 0, TINY_SVG, 10, 10, "transparent");

		const whiteBytes = (await Bun.file(whitePaths.png).arrayBuffer()).byteLength;
		const transparentBytes = (await Bun.file(transparentPaths.png).arrayBuffer()).byteLength;

		expect(whiteBytes).not.toBe(transparentBytes);

		rmSync(dir, { recursive: true });
	});
});
