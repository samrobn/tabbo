/**
 * Offline JSON-path renderer for the eval harness.
 *
 * Drives `engine/tab -worker` for a fixture, parses the layout JSON, generates
 * SVG via the shared `layout-render.ts` module (the same code the live preview
 * uses), and rasterises to PNG via @napi-rs/canvas with Skia (reusing
 * capture-server's font registration). Output mirrors the PS-path harness:
 * one PNG per page in `evals/runs/<timestamp>/json/`.
 *
 * Why offline (no app required): the production capture-server depends on a
 * running webview and saturates after one capture per session. For batch eval
 * over five fixtures we render standalone — same rasteriser library, same
 * fonts, same shared SVG generator, deterministic, fast.
 */

import { join, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
	registerLuteFonts,
	registerBodyFonts,
	writePage,
} from "../src/bun/capture-server";
import { layoutToSvgPages } from "../src/shared/layout-render";
import type { LayoutResult } from "../src/shared/rpc-types";
import { FIXTURES, getTabBinary, getFontsDir } from "./utils";

const TAB_TIMEOUT_MS = 5_000;

// PostScript points → CSS pixels at 96 DPI. layoutToSvgPages returns page
// geometry in pt (the engine's native unit for layout); writePage's Skia
// rasteriser scales pixel inputs by DPI_SCALE = 150/96 internally. Mirror the
// conversion App.vue:capturePreviewPages does so JSON-path captures render at
// the same intrinsic resolution as the live-preview captures.
const PT_TO_PX = 96 / 72;

// Source-tree font paths. The capture-server module's top-level register calls
// run with built-app paths (which don't exist here) and silently warn. Re-call
// with source-tree overrides so Skia actually has the lute glyphs and body
// font for SVG rasterisation.
function registerFontsFromSourceTree(): void {
	const repoRoot = resolve(import.meta.dir, "..");
	registerLuteFonts(join(repoRoot, "engine", "fonts", "woff2"));
	registerBodyFonts(join(repoRoot, "assets", "fonts"));
}
let fontsRegistered = false;
function ensureFonts(): void {
	if (fontsRegistered) return;
	registerFontsFromSourceTree();
	fontsRegistered = true;
}

/**
 * Spawn `tab -worker`, send a single `cmd: "layout"` request, parse the last
 * NDJSON line of stdout. Synchronous spawn keeps the harness simple — fixtures
 * are small, the worker exits on stdin EOF.
 *
 * Rejected: reuse one long-lived worker across fixtures (mirroring
 * `src/bun/engine-worker.ts::EngineWorker`). Would save ~200-500ms total
 * (5 cold starts vs 1) but requires async stdin/stdout wiring and per-fixture
 * isolation — not worth the complexity until eval runtime is a CI bottleneck.
 */
function compileLayout(fixturePath: string): LayoutResult {
	const content = readFileSync(fixturePath, "utf8");
	const req = JSON.stringify({ cmd: "layout", content }) + "\n";

	const r = spawnSync(getTabBinary(), ["-worker"], {
		input: req,
		env: { ...process.env, TABFONTS: getFontsDir() },
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
		timeout: TAB_TIMEOUT_MS,
	});

	if (r.status !== 0 && r.signal !== null) {
		throw new Error(`tab -worker killed by signal ${r.signal} (likely timeout >${TAB_TIMEOUT_MS}ms)`);
	}
	if (r.error) throw r.error;

	const stdout = r.stdout.trim();
	if (stdout === "") {
		throw new Error(`tab -worker produced no output. stderr:\n${r.stderr}`);
	}
	const lines = stdout.split("\n");
	const last = JSON.parse(lines[lines.length - 1]);
	if (!Array.isArray(last.pages) || last.pages.length === 0) {
		// Empty pages array is treated as a failure: a fixture that compiles to
		// zero pages would otherwise silently pass the harness AND let the regen
		// script delete its existing goldens. Surface engine errors if any.
		const errs = JSON.stringify(last.errors ?? []);
		throw new Error(`tab -worker returned no pages. Errors: ${errs}`);
	}
	return last as LayoutResult;
}

/**
 * Render a single fixture to per-page PNGs in `outDir`.
 * Returns the number of pages written.
 */
export async function renderJsonFixture(fixture: string, outDir: string): Promise<number> {
	ensureFonts();
	mkdirSync(outDir, { recursive: true });

	const fixturePath = join(import.meta.dir, "fixtures", `${fixture}.tab`);
	const layout = compileLayout(fixturePath);
	const pages = layoutToSvgPages(layout);

	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		// writePage uses pageIndex-based naming, so passing i gives us
		// `<fixture>-p1.png` for the first page (matches PS-path convention).
		await writePage(
			outDir,
			fixture,
			i,
			page.svg,
			page.widthPt * PT_TO_PX,
			page.heightPt * PT_TO_PX,
			"white",
		);
	}
	return pages.length;
}

export async function main(fixtureArg?: string): Promise<void> {
	if (fixtureArg && !FIXTURES.includes(fixtureArg)) {
		console.error(`Unknown fixture "${fixtureArg}". Available: ${FIXTURES.join(", ")}`);
		process.exit(1);
	}
	const targets = fixtureArg ? [fixtureArg] : FIXTURES;

	const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
	const outDir = join(import.meta.dir, "runs", ts, "json");
	mkdirSync(outDir, { recursive: true });
	console.log(`JSON-path run dir: ${outDir}\n`);

	let failed = false;
	for (const fixture of targets) {
		try {
			const pages = await renderJsonFixture(fixture, outDir);
			console.log(`  ${fixture}: ${pages} page(s) (json)`);
		} catch (err) {
			console.error(`  ${fixture}: FAILED - ${(err as Error).message}`);
			failed = true;
		}
	}
	if (failed) process.exit(1);
}

if (import.meta.path === Bun.main) {
	const arg = process.argv[2];
	await main(arg);
}
