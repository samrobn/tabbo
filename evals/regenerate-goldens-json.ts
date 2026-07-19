/**
 * Regenerate JSON-path goldens by running the local engine through render-json
 * and copying the output PNGs into evals/goldens-json/.
 *
 * Unlike the PS pipeline, JSON goldens come from the LOCAL engine (`engine/tab`),
 * not an upstream reference. Reason: the upstream `tab` binary does not produce
 * JSON output — it's a fork-only feature. Tabbo's JSON path is therefore
 * compared against itself; bumping these goldens is an explicit acknowledgement
 * that the rendered output changed intentionally.
 *
 * Run after any change that intentionally affects JSON-path output:
 *   - engine/src/output/json_print.cc edits
 *   - engine/src/layout/* edits (shared with PS — also rerun PS goldens)
 *   - src/shared/layout-render.ts edits (renderer logic)
 *
 * Usage: `bun evals/regenerate-goldens-json.ts`
 */

import { FIXTURES, filesBytesEqual } from "./utils";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { renderJsonFixture } from "./render-json";

const GOLDENS_DIR = join(import.meta.dir, "goldens-json");

/**
 * Engine commit identifier for the manifest. Appends `-dirty` if the working
 * tree has uncommitted changes affecting the engine, json renderer, or shared
 * layout module — without this, a future debugger checking out the recorded
 * sha would build a different binary than the one that produced the goldens.
 */
function getEngineSha(): string {
	try {
		const headProc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
		const sha = new TextDecoder().decode(headProc.stdout).trim();
		const statusProc = Bun.spawnSync([
			"git", "status", "--porcelain", "--",
			"engine/", "src/shared/layout-render.ts", "src/shared/rpc-types.ts",
		]);
		const dirty = new TextDecoder().decode(statusProc.stdout).trim() !== "";
		return dirty ? `${sha}-dirty` : sha;
	} catch {
		return "unknown";
	}
}

function makeRunDir(): string {
	const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
	const dir = join(import.meta.dir, "runs", `regen-json-${ts}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function main(): Promise<void> {
	const engineSha = getEngineSha();
	const runDir = makeRunDir();
	console.log(`Engine sha: ${engineSha}`);
	console.log(`Run directory: ${runDir}\n`);

	mkdirSync(GOLDENS_DIR, { recursive: true });
	const prevGoldens = new Set(
		readdirSync(GOLDENS_DIR).filter(f => /-p\d+\.png$/.test(f)),
	);

	type Entry = { pages: number; engineSha: string; renderedAt: string };
	const manifest: Record<string, Entry> = {};
	const renderedAt = new Date().toISOString();

	const added: string[] = [];
	const changed: string[] = [];
	const unchanged: string[] = [];

	for (const fixture of FIXTURES) {
		try {
			const pages = await renderJsonFixture(fixture, runDir);
			manifest[fixture] = { pages, engineSha, renderedAt };
			console.log(`  ${fixture}: ${pages} page(s)`);

			const pngs = readdirSync(runDir)
				.filter(f => f.startsWith(`${fixture}-p`) && f.endsWith(".png"))
				.sort();

			for (const png of pngs) {
				const src = join(runDir, png);
				const dest = join(GOLDENS_DIR, png);
				if (!prevGoldens.has(png)) {
					added.push(png);
				} else {
					if (filesBytesEqual(src, dest)) unchanged.push(png);
					else changed.push(png);
				}
				copyFileSync(src, dest);
				prevGoldens.delete(png);
			}
		} catch (err) {
			console.error(`  ${fixture}: FAILED - ${(err as Error).message}`);
			process.exit(1);
		}
	}

	const removed = [...prevGoldens];
	for (const f of removed) unlinkSync(join(GOLDENS_DIR, f));

	const manifestPath = join(GOLDENS_DIR, "MANIFEST.json");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

	console.log("\n--- JSON goldens updated ---");
	if (added.length) console.log(`  Added:              ${added.join(", ")}`);
	if (removed.length) console.log(`  Removed (deleted):  ${removed.join(", ")}`);
	if (changed.length) console.log(`  Changed:            ${changed.join(", ")}`);
	console.log(`  Unchanged: ${unchanged.length} file(s)`);
	console.log(`  Manifest:  ${manifestPath}`);
}

await main();
