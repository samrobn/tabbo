import { join } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { getTabBinary, getFontsDir, getGsBinary } from "./utils";

const TAB_TIMEOUT_MS = 5_000;
const GS_TIMEOUT_MS = 3_000;
// Set TABBO_EVAL_SKIP_JSON=1 to run only the PS pass (faster iteration when
// debugging engine output). The JSON pass is on by default so CI catches
// regressions in either pipeline.
const SKIP_JSON_PASS = process.env.TABBO_EVAL_SKIP_JSON === "1";

const FIXTURES = ["simple", "demo", "sample", "c", "t"];

function makeRunDir(): string {
	// ISO 8601 with colons replaced by dashes for filesystem safety.
	const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
	const dir = join(import.meta.dir, "runs", ts);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function spawnOrThrow(
	args: string[],
	opts: { env?: Record<string, string>; timeoutMs: number; label: string },
): Promise<void> {
	const proc = Bun.spawn(args, {
		env: opts.env ? { ...Bun.env, ...opts.env } : Bun.env,
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

function countPngs(runDir: string, fixture: string): number {
	return readdirSync(runDir).filter(
		(f) => f.startsWith(`${fixture}-p`) && f.endsWith(".png"),
	).length;
}

export async function runFixture(
	fixture: string,
	runDir: string,
): Promise<number> {
	const fixturesDir = join(import.meta.dir, "fixtures");
	const inputTab = join(fixturesDir, `${fixture}.tab`);
	const outputPs = join(runDir, `${fixture}.ps`);
	const outputPdf = join(runDir, `${fixture}.pdf`);
	const outputPngPattern = join(runDir, `${fixture}-p%d.png`);

	const tab = getTabBinary();
	const gs = getGsBinary();
	const fonts = getFontsDir();

	await spawnOrThrow(
		[tab, "-no-includes", "-o", outputPs, inputTab],
		{ env: { TABFONTS: fonts }, timeoutMs: TAB_TIMEOUT_MS, label: `tab(${fixture})` },
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

	return countPngs(runDir, fixture);
}

export async function main(fixtureArg?: string): Promise<string> {
	const targets = fixtureArg ? [fixtureArg] : FIXTURES;

	if (fixtureArg && !FIXTURES.includes(fixtureArg)) {
		console.error(`Unknown fixture "${fixtureArg}". Available: ${FIXTURES.join(", ")}`);
		process.exit(1);
	}

	const runDir = makeRunDir();
	console.log(`Run directory: ${runDir}\n`);

	const rows: Array<{ fixture: string; pages: number; psFirstPng: string; jsonFirstPng: string }> = [];
	let failed = false;

	const jsonDir = join(runDir, "json");

	// Defer the render-json import until we know we'll use it. Importing
	// pulls in src/bun/capture-server, whose module-load registers fonts and
	// emits warnings when the built-app paths don't exist (always true in dev).
	const renderJsonFixture = SKIP_JSON_PASS
		? null
		: (await import("./render-json")).renderJsonFixture;

	// Sequential per-fixture loop. Promise.all over targets would cut wall
	// time materially (~5x for 5 fixtures × 4 spawns each) — rejected for now
	// because (a) interleaved console output makes failure diagnosis harder,
	// (b) Skia GlobalFonts.register isn't documented as concurrency-safe, and
	// (c) eval runtime isn't a CI bottleneck yet. Revisit if it becomes one.
	for (const fixture of targets) {
		const psFirstPng = join(runDir, `${fixture}-p1.png`);
		let pages = 0;
		let jsonFirstPng = SKIP_JSON_PASS ? "(skipped)" : "(pending)";
		let psOk = false;
		let jsonOk = false;

		try {
			pages = await runFixture(fixture, runDir);
			psOk = true;
		} catch (err) {
			console.error(`  ${fixture}: PS pass FAILED - ${(err as Error).message}`);
			failed = true;
		}

		if (psOk && renderJsonFixture) {
			try {
				await renderJsonFixture(fixture, jsonDir);
				jsonFirstPng = join(jsonDir, `${fixture}-p1.png`);
				jsonOk = true;
			} catch (err) {
				console.error(`  ${fixture}: JSON pass FAILED - ${(err as Error).message}`);
				jsonFirstPng = "(failed)";
				failed = true;
			}
		}

		// Push the row whenever PS produced output, even if JSON failed — the
		// successful PS PNG is on disk and the user benefits from seeing its
		// path in the summary.
		if (psOk) {
			rows.push({ fixture, pages, psFirstPng, jsonFirstPng });
			const tag = SKIP_JSON_PASS ? "" : (jsonOk ? " (ps + json)" : " (ps ok, json FAILED)");
			console.log(`  ${fixture}: ${pages} page(s)${tag}`);
		}
	}

	console.log("\n--- Summary ---");
	console.log(`${"Fixture".padEnd(10)} ${"Pages".padEnd(7)} First PNG (PS)`);
	for (const row of rows) {
		console.log(`${row.fixture.padEnd(10)} ${String(row.pages).padEnd(7)} ${row.psFirstPng}`);
	}
	if (!SKIP_JSON_PASS) {
		console.log(`\n${"Fixture".padEnd(10)} First PNG (JSON)`);
		for (const row of rows) {
			console.log(`${row.fixture.padEnd(10)} ${row.jsonFirstPng}`);
		}
	}

	if (failed) process.exit(1);
	return runDir;
}

// Run when invoked directly (not imported).
if (import.meta.path === Bun.main) {
	const arg = process.argv[2];
	await main(arg);
}
