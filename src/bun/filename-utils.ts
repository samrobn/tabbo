import { basename, dirname, join } from "path";

/**
 * Derive a safe PDF output basename from an arbitrary client-supplied filename.
 *
 * Rules:
 * - Strip path components (defence against path traversal — `basename` keeps only the leaf).
 * - Reject blank names and hidden files (leading dot after trimming).
 * - Strip the trailing extension (any single extension: `.tab`, `.txt`, `.bak`, …).
 * - Reject names whose stem is empty after stripping (e.g. `.tab` alone).
 * - Append `.pdf`.
 *
 * The client may send the filename with or without its extension; both produce the
 * same result (`untitled.tab` → `untitled.pdf`, `untitled` → `untitled.pdf`).
 *
 * Returns null when the filename cannot be made safe.
 */
export function derivePdfFilename(filename: string): string | null {
	const safe = basename(filename).trim();
	if (!safe || safe.startsWith(".")) return null;

	// Strip one trailing extension (the rightmost dot and everything after it).
	const stem = safe.replace(/\.[^.]+$/, "");
	if (!stem) return null;

	return `${stem}.pdf`;
}

/**
 * Normalise a user-entered tab filename to a safe basename, or null if invalid.
 * Rejects path separators, parent refs, and empty/hidden stems - the trust
 * boundary for save targets. Appends ".tab" when absent (case-insensitive).
 */
export function deriveTabFilename(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.includes("/") || trimmed.includes("\\")) return null;
	// Rejects any embedded ".." sequence, not just a bare path component - stricter than strict path-traversal, deliberately erring safe.
	if (trimmed.includes("..")) return null;
	if (trimmed.startsWith(".")) return null;
	return /\.tab$/i.test(trimmed) ? trimmed : `${trimmed}.tab`;
}

export interface SaveTarget {
	path: string;
	isNew: boolean; // true → overwrite-confirm applies; false → round-trip
}

/**
 * Decide where a save writes, given a normalised filename and the document's
 * current path. projectDir is the directory new documents are saved into (the caller passes the user's Tabbo documents folder).
 */
export function resolveSaveTarget(
	name: string,
	currentPath: string | null,
	projectDir: string,
	targetDir?: string | null,
): SaveTarget {
	if (targetDir) {
		const path = join(targetDir, name);
		return { path, isNew: path !== currentPath };
	}
	if (currentPath === null) return { path: join(projectDir, name), isNew: true };
	if (basename(currentPath) === name) return { path: currentPath, isNew: false };
	return { path: join(dirname(currentPath), name), isNew: true };
}
