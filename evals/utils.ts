import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

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

export function getTabBinary(): string {
	return resolveResource("../resources/bin/tab", "engine/tab");
}

export function getFontsDir(): string {
	return resolveResource("../resources/fonts", "engine/fonts");
}

export function getGsBinary(): string {
	try {
		return resolveResource("../resources/bin/gs", "gs/gs-minimal");
	} catch {
		// Fall back to system gs when gs/gs-minimal has not been built yet.
		return "gs";
	}
}
