import type { CompilationError } from "../shared/rpc-types";

const INFORMATIONAL_PATTERNS = [
	"copyright",
	"sending output",
	"setting filename",
	"tab:",
	"This is TAB",
	"reading file",
];

/** Strip absolute paths and temp file references from error output. */
function sanitise(message: string): string {
	if (typeof message !== "string") return "Compilation failed";

	return message
		.replace(/\/Users\/[^\s:]+/g, "[path]")
		.replace(/\/home\/[^\s:]+/g, "[path]")
		.replace(/\/tmp\/[^\s:]+/g, "[temp]")
		.replace(/C:\\Users\\[^\s:]+/gi, "[path]")
		.replace(/\/var\/[^\s:]+/g, "[path]")
		.replace(/[a-f0-9]{32}\.(tab|ps|pdf)/g, "[file].$1");
}

/** Clean up raw error text for display. */
function enhance(message: string): string {
	return message
		.replace(/^Error:\s*/i, "")
		.replace(/^Warning:\s*/i, "")
		.replace(/\[path\]/g, "")
		.replace(/\[temp\]/g, "")
		.replace(/\[file\]/g, "input")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse tab binary stderr into structured errors with line numbers and hints. */
export function parseTabErrors(errorOutput: string): CompilationError[] {
	const errors: CompilationError[] = [];
	const sanitised = sanitise(errorOutput);

	for (const line of sanitised.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (INFORMATIONAL_PATTERNS.some((p) => trimmed.includes(p))) continue;

		// Pass 1 errors: line:char format
		const lineCharMatch = trimmed.match(/(\d+):(\d+)\s*[:-]?\s*(.+)/);
		if (lineCharMatch) {
			errors.push({
				line: parseInt(lineCharMatch[1], 10),
				message: enhance(lineCharMatch[3].trim()),
			});
			continue;
		}

		// Extract line number from "line N" format
		const lineNumMatch = trimmed.match(/line\s+(\d+)/i);
		const extractedLine = lineNumMatch
			? parseInt(lineNumMatch[1], 10)
			: undefined;

		if (trimmed.includes("Bad character")) {
			const match = trimmed.match(/Bad character-(\w)-(\d+)/);
			errors.push({
				line: extractedLine,
				message: match
					? `Invalid character '${match[1]}'. Hint: Use letters a-p for frets, 1-9 for Italian style, or space for unplayed strings.`
					: enhance(trimmed),
			});
		} else if (trimmed.includes("get_width")) {
			errors.push({
				line: extractedLine,
				message:
					"Tablature too wide for line. Hint: Add a blank line to force a line break, or use -l flag to set line length.",
			});
		} else if (trimmed.includes("not found")) {
			errors.push({
				line: extractedLine,
				message:
					"Value not found. Hint: Check that all referenced values (fonts, includes) exist.",
			});
		} else if (
			trimmed.includes("end of file") ||
			trimmed.includes("EOF")
		) {
			errors.push({
				line: extractedLine,
				message:
					'Unexpected end of file. Hint: Add "e" on a new line to mark the end of the document.',
			});
		} else if (trimmed.includes("grid") || trimmed.includes("Grid")) {
			errors.push({
				line: extractedLine,
				message:
					enhance(trimmed) +
					" Hint: Grids start with # followed by number of lines (e.g., #2 for two notes).",
			});
		} else if (trimmed.includes("font") || trimmed.includes("Font")) {
			errors.push({
				line: extractedLine,
				message:
					enhance(trimmed) +
					" Hint: Check TABFONTS environment variable points to the fonts directory.",
			});
		} else if (trimmed.includes("system") || trimmed.includes("System")) {
			const sysMatch = trimmed.match(/system\s*(\d+)/i);
			errors.push({
				message:
					enhance(trimmed) +
					(sysMatch ? ` (in system ${sysMatch[1]})` : ""),
			});
		} else if (
			trimmed.includes("barline") ||
			trimmed.includes("bar line")
		) {
			errors.push({
				line: extractedLine,
				message:
					enhance(trimmed) +
					' Hint: Use "b" for barline, "bb" for double, ".bb." for repeat.',
			});
		} else if (trimmed.includes("flag")) {
			errors.push({
				line: extractedLine,
				message:
					enhance(trimmed) +
					' Hint: Flags are 0-5 (or W for whole, w for half). Use "." after for dotted.',
			});
		} else {
			errors.push({ line: extractedLine, message: enhance(trimmed) });
		}
	}

	return errors.length > 0 ? errors : [{ message: "Compilation failed" }];
}
