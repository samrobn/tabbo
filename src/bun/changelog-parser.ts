/**
 * Parse a Keep-a-Changelog-style markdown file and return the body of a
 * specific version section, or null if the section is not found.
 *
 * Recognised heading formats (both are common for pre-release versions):
 *   ## [1.2.3] - 2024-01-01
 *   ## 1.2.3 - 2024-01-01
 *   ## [1.2.3-alpha.1]
 *   ## 1.2.3-alpha.1
 *
 * The section body is everything between the matched heading and the next
 * `##`-level heading (or end of file). Leading/trailing blank lines are
 * stripped from the returned body.
 */
export function parseChangelog(markdown: string, version: string): string | null {
	const lines = markdown.split("\n");

	// Match `## [version...]` or `## version...` — optional brackets, optional
	// trailing content (date, dash) or end of line/heading.
	const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Lookahead deliberately excludes `-`: a search for `1.0.0` must not match
	// `## [1.0.0-alpha.1]`, which would surface the pre-release body when the
	// caller asked for the stable.
	const headingPattern = new RegExp(
		`^##\\s+\\[?${escapedVersion}(?:[\\]\\s#]|$)`,
		"i",
	);

	let startIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headingPattern.test(lines[i]!)) {
			startIndex = i + 1;
			break;
		}
	}

	if (startIndex === -1) return null;

	// Collect lines until the next `##` heading or end of file
	const bodyLines: string[] = [];
	for (let i = startIndex; i < lines.length; i++) {
		if (/^##\s/.test(lines[i]!)) break;
		bodyLines.push(lines[i]!);
	}

	const body = bodyLines.join("\n").trim();
	return body.length > 0 ? body : null;
}
