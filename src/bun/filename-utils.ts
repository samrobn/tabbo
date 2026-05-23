import { basename } from "path";

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
