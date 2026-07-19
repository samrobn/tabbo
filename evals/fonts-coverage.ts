/**
 * WOFF2 glyph-coverage eval.
 *
 * Renders every mapped PK glyph (engine/fonts/pua-mapping.json) in every
 * lute/blute/tlute WOFF2 family to a deterministic grid PNG via @napi-rs/canvas
 * (Skia - the same rasteriser as the JSON eval pass; no headless browser
 * needed), and compares it cell-by-cell against the committed golden. Catches
 * the regressions the layout evals can't: missing glyphs, inverted fills,
 * path-winding bugs on the ~180 PK codes no fixture exercises.
 *
 * Modes:
 *   bun evals/fonts-coverage.ts                  compare against the golden, exit 1 on diff
 *   bun evals/fonts-coverage.ts --update-golden  re-render + overwrite the golden (renders
 *                                                twice and refuses on non-determinism)
 *   bun evals/fonts-coverage.ts --if-changed     skip (exit 0) unless the font sources'
 *                                                hash differs from the golden manifest -
 *                                                the fast-path gate used by run.ts
 *
 * Regen flow after a font change: edit .mf / pua-mapping.json, run
 * engine/fonts/build-woff2-fonts.sh, eyeball engine/dev/preview.html, then
 * `bun evals/fonts-coverage.ts --update-golden` and commit the golden pair.
 */

import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const FONTS_DIR = join(import.meta.dir, "../engine/fonts/woff2");
const MAPPING_PATH = join(import.meta.dir, "../engine/fonts/pua-mapping.json");
const GOLDEN_PATH = join(import.meta.dir, "goldens/woff2-coverage.png");
const MANIFEST_PATH = join(import.meta.dir, "goldens/woff2-coverage.MANIFEST.json");

const CELL_W = 24;
const CELL_H = 30;
const COLS = 32;
const HEADER_H = 6; // solid separator bar above each family block
const FONT_PX = 18;
const BASELINE_Y = 22; // within-cell baseline

interface Cell {
	family: string;
	pkCode: number;
	codepoint: number;
	x: number;
	y: number;
}

function mappedCodes(): Array<{ pkCode: number; codepoint: number }> {
	const mapping = JSON.parse(readFileSync(MAPPING_PATH, "utf-8")) as {
		ascii_zone: { codes: number[] };
		pua_zone: { offset: number; codes: number[] };
	};
	return [
		...mapping.ascii_zone.codes.map((code) => ({ pkCode: code, codepoint: code })),
		...mapping.pua_zone.codes.map((code) => ({ pkCode: code, codepoint: mapping.pua_zone.offset + code })),
	];
}

function families(): string[] {
	return readdirSync(FONTS_DIR)
		.filter((entry) => entry.endsWith(".woff2"))
		.map((entry) => basename(entry, ".woff2"))
		.sort();
}

/** Hash of everything the golden depends on: WOFF2 bytes + the PK→PUA mapping. */
function sourcesHash(): string {
	const hash = createHash("sha256");
	for (const entry of readdirSync(FONTS_DIR).sort()) {
		if (!entry.endsWith(".woff2")) continue;
		hash.update(entry);
		hash.update(readFileSync(join(FONTS_DIR, entry)));
	}
	hash.update(readFileSync(MAPPING_PATH));
	// Include this script itself: a change to the grid geometry or rendering
	// code must re-trigger the comparison (and usually a golden regen), or
	// --if-changed would keep skipping it forever.
	hash.update(readFileSync(import.meta.path));
	return hash.digest("hex");
}

function layoutCells(): { cells: Cell[]; width: number; height: number } {
	const codes = mappedCodes();
	const rowsPerFamily = Math.ceil(codes.length / COLS);
	const blockH = HEADER_H + rowsPerFamily * CELL_H;
	const fams = families();
	const cells: Cell[] = [];
	fams.forEach((family, familyIndex) => {
		const blockTop = familyIndex * blockH;
		codes.forEach((code, codeIndex) => {
			cells.push({
				family,
				pkCode: code.pkCode,
				codepoint: code.codepoint,
				x: (codeIndex % COLS) * CELL_W,
				y: blockTop + HEADER_H + Math.floor(codeIndex / COLS) * CELL_H,
			});
		});
	});
	return { cells, width: COLS * CELL_W, height: fams.length * blockH };
}

/*
 * Buffer-based GlobalFonts.register (not registerFromPath) - same rationale as
 * src/bun/capture-server.ts's registerLuteFonts. A local copy rather than an
 * import: importing capture-server fires its module-load registration against
 * built-app paths and prints spurious "fonts dir not found" warnings on every
 * eval run.
 */
function registerFonts(): void {
	for (const entry of readdirSync(FONTS_DIR).sort()) {
		if (!entry.endsWith(".woff2")) continue;
		GlobalFonts.register(readFileSync(join(FONTS_DIR, entry)), basename(entry, ".woff2"));
	}
}

function render(): ReturnType<typeof createCanvas> {
	registerFonts();
	const { cells, width, height } = layoutCells();
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "white";
	ctx.fillRect(0, 0, width, height);
	// Family separator bars (vector-deterministic; no text labels - system
	// fonts would make the golden machine-dependent).
	ctx.fillStyle = "black";
	let currentFamily = "";
	for (const cell of cells) {
		if (cell.family !== currentFamily) {
			currentFamily = cell.family;
			ctx.fillRect(0, cell.y - HEADER_H, width, 2);
		}
		// Clip to the cell so oversized glyphs can't bleed into neighbours -
		// keeps the per-cell failure report pointing at the glyph that changed.
		ctx.save();
		ctx.beginPath();
		ctx.rect(cell.x, cell.y, CELL_W, CELL_H);
		ctx.clip();
		ctx.font = `${FONT_PX}px ${cell.family}`;
		ctx.fillText(String.fromCodePoint(cell.codepoint), cell.x + 3, cell.y + BASELINE_Y);
		ctx.restore();
	}
	return canvas;
}

function cellPixelsDiffer(a: Uint8ClampedArray, b: Uint8ClampedArray, imgWidth: number, cell: Cell): boolean {
	for (let dy = 0; dy < CELL_H; dy++) {
		for (let dx = 0; dx < CELL_W; dx++) {
			const offset = ((cell.y + dy) * imgWidth + (cell.x + dx)) * 4;
			for (let channel = 0; channel < 4; channel++) {
				if (a[offset + channel] !== b[offset + channel]) return true;
			}
		}
	}
	return false;
}

async function compare(): Promise<number> {
	if (!existsSync(GOLDEN_PATH)) {
		console.error(`No golden at ${GOLDEN_PATH}. Run: bun evals/fonts-coverage.ts --update-golden`);
		return 1;
	}
	const fresh = render();
	const { cells, width, height } = layoutCells();
	const goldenImg = await loadImage(readFileSync(GOLDEN_PATH));
	if (goldenImg.width !== width || goldenImg.height !== height) {
		console.error(
			`Golden dimensions ${goldenImg.width}x${goldenImg.height} != expected ${width}x${height} ` +
			`(font families or mapped codes changed). Regenerate: bun evals/fonts-coverage.ts --update-golden`,
		);
		return 1;
	}
	const goldenCanvas = createCanvas(width, height);
	const goldenCtx = goldenCanvas.getContext("2d");
	goldenCtx.drawImage(goldenImg, 0, 0);
	const freshData = fresh.getContext("2d").getImageData(0, 0, width, height).data;
	const goldenData = goldenCtx.getImageData(0, 0, width, height).data;

	const failures = cells.filter((cell) => cellPixelsDiffer(freshData, goldenData, width, cell));
	if (failures.length === 0) {
		console.log(`fonts-coverage: OK (${cells.length} glyph cells match the golden)`);
		return 0;
	}
	console.error(`fonts-coverage: ${failures.length} glyph cell(s) differ from the golden:`);
	for (const cell of failures.slice(0, 40)) {
		console.error(
			`  ${cell.family}  pk ${cell.pkCode}  U+${cell.codepoint.toString(16).toUpperCase().padStart(4, "0")}`,
		);
	}
	if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
	console.error(
		"If the font change is intentional: eyeball engine/dev/preview.html, then " +
		"bun evals/fonts-coverage.ts --update-golden",
	);
	return 1;
}

async function updateGolden(): Promise<number> {
	const first = render().encodeSync("png");
	const second = render().encodeSync("png");
	if (!first.equals(second)) {
		console.error("fonts-coverage: two consecutive renders differ - non-deterministic, refusing to write a golden");
		return 1;
	}
	writeFileSync(GOLDEN_PATH, first);
	writeFileSync(
		MANIFEST_PATH,
		JSON.stringify(
			{ sourcesHash: sourcesHash(), renderedAt: new Date().toISOString() },
			null,
			2,
		) + "\n",
	);
	console.log(`fonts-coverage: golden written (${GOLDEN_PATH})`);
	return 0;
}

async function main(): Promise<void> {
	const mode = process.argv[2];
	if (mode === "--update-golden") {
		process.exit(await updateGolden());
	}
	if (mode === "--if-changed") {
		if (existsSync(MANIFEST_PATH)) {
			const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as { sourcesHash?: string };
			if (manifest.sourcesHash === sourcesHash()) {
				console.log("fonts-coverage: font sources unchanged since golden - skipped");
				process.exit(0);
			}
		}
		// Sources changed (or no manifest yet) - fall through to a full compare.
	}
	process.exit(await compare());
}

await main();
