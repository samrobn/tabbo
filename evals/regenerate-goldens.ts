import { join, relative } from "node:path";
import { readdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";

// run.ts is used only for its runFixture helper, not its binary resolution.
// Golden generation always uses the upstream reference binary, not the local engine.
import { runFixture } from "./run.ts";

const GOLDENS_DIR = join(import.meta.dir, "goldens");
const REFERENCE_DIR = join(import.meta.dir, "reference");

// Read the pinned upstream commit sha from evals/reference/VERSION.
function readReferenceSha(): string {
	const versionPath = join(REFERENCE_DIR, "VERSION");
	if (!existsSync(versionPath)) {
		throw new Error(
			`Reference engine not found at ${REFERENCE_DIR}. Build from upstream per evals/REFERENCE.md.`,
		);
	}
	const content = readFileSync(versionPath, "utf-8");
	const match = content.match(/^commit:\s*([0-9a-f]+)/m);
	if (!match) throw new Error(`Malformed VERSION file at ${versionPath} - no "commit:" line found.`);
	return match[1];
}

// Override the tab binary and fonts resolution to point at the reference.
// run.ts exports runFixture which calls getTabBinary()/getFontsDir() internally,
// so we cannot patch those from here. Instead we run the pipeline directly by
// re-implementing the relevant portion, passing the reference paths through env.
//
// The simplest approach: set process.env so that when runFixture resolves paths it
// sees the already-built reference binary. But runFixture uses resolveResource which
// checks built paths first. To avoid coupling to that logic, we call our own spawn here.

import { existsSync as fsExists } from "node:fs";
import { FIXTURES, filesBytesEqual, getGsBinary, warnOnGsVersionMismatch } from "./utils";

const TAB_TIMEOUT_MS = 5_000;
const GS_TIMEOUT_MS = 3_000;

function getReferenceBinary(): string {
	const p = join(REFERENCE_DIR, "tab");
	if (!fsExists(p)) {
		throw new Error(
			`Reference engine not found at ${p}. Build from upstream per evals/REFERENCE.md.`,
		);
	}
	return p;
}

function getReferenceFontsDir(): string {
	const p = join(REFERENCE_DIR, "fonts");
	if (!fsExists(p)) {
		throw new Error(
			`Reference fonts not found at ${p}. Build from upstream per evals/REFERENCE.md.`,
		);
	}
	return p;
}



async function spawnOrThrow(
	args: string[],
	opts: { env?: Record<string, string>; timeoutMs: number; label: string; cwd?: string },
): Promise<void> {
	const proc = Bun.spawn(args, {
		env: opts.env ? { ...Bun.env, ...opts.env } : Bun.env,
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs);
	const code = await proc.exited;
	clearTimeout(timer);
	if (code !== 0) {
		if (timedOut) {
			throw new Error(`${opts.label} timed out after ${opts.timeoutMs}ms (killed; no stderr).`);
		}
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`${opts.label} exited ${code}:\n${stderr.trim()}`);
	}
}

async function getGsVersion(): Promise<string> {
	try {
		const gs = getGsBinary();
		const proc = Bun.spawn([gs, "--version"], { stdout: "pipe", stderr: "pipe" });
		await proc.exited;
		return (await new Response(proc.stdout).text()).trim();
	} catch {
		return "unknown";
	}
}

function makeRunDir(): string {
	const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
	const dir = join(import.meta.dir, "runs", `reference-${ts}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function runReferenceFixture(fixture: string, runDir: string): Promise<number> {
	const fixturesDir = join(import.meta.dir, "fixtures");
	const inputTab = join(fixturesDir, `${fixture}.tab`);
	const outputPs = join(runDir, `${fixture}.ps`);
	const outputPdf = join(runDir, `${fixture}.pdf`);
	const outputPngPattern = join(runDir, `${fixture}-p%d.png`);

	getReferenceBinary();     // validate presence (spawn below uses relative paths)
	getReferenceFontsDir();
	const gs = getGsBinary();

	// The upstream reference binary does not support -no-includes (that flag was added
	// in the tabbo fork). Run without it - upstream silently warns on unknown flags and
	// continues, but omitting it avoids the spurious warning on stderr.
	//
	// Spawn with cwd = evals/ and evals-relative paths: the reference binary
	// aborts (SIGABRT, empty stderr) on long absolute paths - a fixed-size
	// path buffer upstream - which broke regeneration from long-path
	// checkouts such as .claude/worktrees/. tab/fonts existence was already
	// validated above via the absolute-path getters.
	await spawnOrThrow(
		[join("reference", "tab"), "-o", relative(import.meta.dir, outputPs), relative(import.meta.dir, inputTab)],
		{ env: { TABFONTS: join("reference", "fonts") }, cwd: import.meta.dir, timeoutMs: TAB_TIMEOUT_MS, label: `ref-tab(${fixture})` },
	);

	await spawnOrThrow(
		[gs, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
			`-sOutputFile=${outputPdf}`, outputPs],
		{ timeoutMs: GS_TIMEOUT_MS, label: `gs-pdf(${fixture})` },
	);

	await spawnOrThrow(
		[gs, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m",
			"-r150", `-sOutputFile=${outputPngPattern}`, outputPdf],
		{ timeoutMs: GS_TIMEOUT_MS, label: `gs-png(${fixture})` },
	);

	return readdirSync(runDir).filter(
		(f) => f.startsWith(`${fixture}-p`) && f.endsWith(".png"),
	).length;
}

function gatherRunPngs(runDir: string, fixture: string): string[] {
	return readdirSync(runDir)
		.filter((f) => f.startsWith(`${fixture}-p`) && f.endsWith(".png"))
		.sort();
}

async function main(): Promise<void> {
	const referenceSha = readReferenceSha();
	const runDir = makeRunDir();

	console.log(`Reference sha: ${referenceSha}`);
	warnOnGsVersionMismatch(getGsBinary());
	console.log(`Run directory: ${runDir}\n`);

	const gs = getGsBinary();
	const [gsVersion] = await Promise.all([getGsVersion()]);
	const renderedAt = new Date().toISOString();

	// Only fixture page PNGs (<fixture>-p<N>.png) are goldens here; woff2-coverage.png
	// belongs to fonts-coverage.ts and must stay invisible to this add/change/remove logic.
	const prevGoldens = new Set(
		existsSync(GOLDENS_DIR)
			? readdirSync(GOLDENS_DIR).filter((f) => /-p\d+\.png$/.test(f))
			: [],
	);

	type FixtureEntry = { pages: number; gsVersion: string; referenceSha: string; renderedAt: string };
	const manifest: Record<string, FixtureEntry> = {};

	const added: string[] = [];
	const changed: string[] = [];
	const unchanged: string[] = [];

	for (const fixture of FIXTURES) {
		try {
			const pages = await runReferenceFixture(fixture, runDir);
			const pngs = gatherRunPngs(runDir, fixture);
			manifest[fixture] = { pages, gsVersion, referenceSha, renderedAt };
			console.log(`  ${fixture}: ${pages} page(s)`);

			for (const png of pngs) {
				const src = join(runDir, png);
				const dest = join(GOLDENS_DIR, png);

				if (!prevGoldens.has(png)) {
					added.push(png);
				} else {
					if (filesBytesEqual(src, dest)) {
						unchanged.push(png);
					} else {
						changed.push(png);
					}
				}

				copyFileSync(src, dest);
				prevGoldens.delete(png);
			}
		} catch (err) {
			console.error(`  ${fixture}: FAILED - ${(err as Error).message}`);
			process.exit(1);
		}
	}

	// Any golden left in prevGoldens was not produced in this run (removed pages).
	const removed = [...prevGoldens];

	const manifestPath = join(GOLDENS_DIR, "MANIFEST.json");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

	for (const f of removed) {
		unlinkSync(join(GOLDENS_DIR, f));
	}

	console.log("\n--- Goldens updated ---");
	if (added.length) console.log(`  Added:              ${added.join(", ")}`);
	if (removed.length) console.log(`  Removed (deleted):  ${removed.join(", ")}`);
	if (changed.length) console.log(`  Changed:            ${changed.join(", ")}`);
	console.log(`  Unchanged: ${unchanged.length} file(s)`);
	console.log(`  Manifest:  ${manifestPath}`);
}

await main();
