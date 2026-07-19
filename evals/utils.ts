import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Byte-exact file comparison. Size-only comparisons report a size-preserving
 * content change as unchanged - a golden-regeneration report must match
 * git's view (byte equality), not file size.
 */
export function filesBytesEqual(a: string, b: string): boolean {
	const bufA = readFileSync(a);
	const bufB = readFileSync(b);
	return bufA.length === bufB.length && bufA.equals(bufB);
}

/**
 * Resolve a resource path with built-app preference, dev-tree fallback.
 *
 * Mirrors the helper in `src/bun/engine-worker.ts` and `src/bun/pdf-export.ts`
 * but lives here so the eval harness doesn't import from `src/bun/` (those
 * modules carry Electrobun runtime imports that fire on load). Shared between
 * `evals/run.ts` and `evals/render-json.ts`.
 */
export function resolveResource(builtRelative: string, devRelative: string): string {
	const builtPath = join(import.meta.dir, builtRelative);
	if (existsSync(builtPath)) return builtPath;

	const devPath = resolve(devRelative);
	if (existsSync(devPath)) return devPath;

	throw new Error(`Resource not found. Tried:\n  ${builtPath}\n  ${devPath}`);
}

/**
 * Single source of truth for the eval fixture list. Previously duplicated in
 * run.ts, regenerate-goldens.ts, regenerate-goldens-json.ts, and
 * render-json.ts, which drifted when fixtures were added.
 */
export const FIXTURES = ["simple", "demo", "sample", "c", "t", "accents", "uline-wide", "n-numbers", "pagenum", "barnums", "fontsizes", "multipage", "ornaments", "ncollide"];

export function getTabBinary(): string {
	return resolveResource("../resources/bin/tab", "engine/tab");
}

export function getFontsDir(): string {
	return resolveResource("../resources/fonts", "engine/fonts");
}

/**
 * In a linked git worktree the dev-built gs (gs/gs-minimal, gitignored) exists
 * only in the primary checkout. Probe there before falling back to system gs:
 * a silent fallback rasterises PNGs with a different Ghostscript version and
 * reads as golden drift (root cause of task 20260705-D6TQ - the committed
 * goldens are rendered by gs-minimal, worktree runs were falling back to a
 * newer system gs).
 */
function primaryCheckoutGs(): string | null {
	try {
		const proc = Bun.spawnSync(
			["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: import.meta.dir },
		);
		if (proc.exitCode !== 0) return null;
		const commonDir = new TextDecoder().decode(proc.stdout).trim();
		if (!commonDir) return null;
		const primaryRoot = dirname(commonDir);
		// Only the dev build lives at a stable repo-relative path; the packaged
		// gs is inside build/<channel>/<app>.app/... and not worth probing.
		const candidate = join(primaryRoot, "gs/gs-minimal");
		if (existsSync(candidate)) return candidate;
	} catch {
		// git unavailable - fall through to system gs
	}
	return null;
}

export function getGsBinary(): string {
	try {
		return resolveResource("../resources/bin/gs", "gs/gs-minimal");
	} catch {
		// Last resort: system gs. warnOnGsVersionMismatch tells the user when
		// this lands on a version the goldens weren't rendered with.
		return primaryCheckoutGs() ?? "gs";
	}
}

export function gsVersion(gs: string): string | null {
	try {
		const proc = Bun.spawnSync([gs, "--version"]);
		if (proc.exitCode !== 0) return null;
		return new TextDecoder().decode(proc.stdout).trim();
	} catch {
		return null;
	}
}

/**
 * Loudly warn when the resolved gs version differs from the version(s) the
 * committed PS goldens were rendered with (recorded per fixture in
 * goldens/MANIFEST.json). A mismatch makes every PNG comparison show pixel
 * drift that is not an engine regression.
 *
 * Returns true when PS golden byte-compare should be skipped this run (gs
 * version mismatch confirmed against the manifest) - callers use this to
 * branch, the message above stays the loud, human-readable explanation.
 */
export function warnOnGsVersionMismatch(gs: string): boolean {
	const manifestPath = join(import.meta.dir, "goldens", "MANIFEST.json");
	if (!existsSync(manifestPath)) return false;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
			string,
			{ gsVersion?: string }
		>;
		const goldenVersions = [
			...new Set(
				Object.values(manifest)
					.map((entry) => entry.gsVersion)
					.filter((v): v is string => Boolean(v)),
			),
		];
		const local = gsVersion(gs);
		if (local === null) {
			console.error(
				`\n! Could not execute the resolved Ghostscript (${gs}) - the PS pass will fail. ` +
					`Install gs or build the pinned dev gs (gs/build-gs.sh) in the primary checkout.\n`,
			);
			return false;
		}
		if (goldenVersions.length > 0 && !goldenVersions.includes(local)) {
			console.error(
				`\n! Ghostscript version mismatch: resolved gs is ${local} (${gs}) but the ` +
					`committed PS goldens were rendered with ${goldenVersions.join(", ")}.\n` +
					`  PS golden comparison will be SKIPPED this run - pixel drift from a ` +
					`different Ghostscript is NOT an engine regression.\n` +
					`  Fix: build the pinned dev gs in the primary checkout (gs/build-gs.sh) - ` +
					`worktrees resolve it automatically.\n`,
			);
			return true;
		}
	} catch {
		// Malformed manifest - the golden review flow will surface it
	}
	return false;
}
