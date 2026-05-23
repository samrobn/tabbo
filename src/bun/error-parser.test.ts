import { describe, expect, test } from "bun:test";
import { parseTabErrors } from "./error-parser";

describe("parseTabErrors", () => {
	test("returns fallback message for empty input", () => {
		expect(parseTabErrors("")).toEqual([{ message: "Compilation failed" }]);
	});

	test("returns fallback message for whitespace-only input", () => {
		expect(parseTabErrors("  \n  \n  ")).toEqual([
			{ message: "Compilation failed" },
		]);
	});

	test("filters informational lines", () => {
		const input = [
			"tab 4.3.108 copyright 1995-2025 by Wayne Cripps",
			"tab: sending output to output.ps",
			"setting filename to input.tab",
			"tab: tab_p: sys_count: 1",
			"This is TAB version 4.3",
			"reading file input.tab",
		].join("\n");

		// All lines are informational except "tab: tab_p: sys_count: 1"
		// which matches "tab:" pattern, so it's also filtered
		expect(parseTabErrors(input)).toEqual([
			{ message: "Compilation failed" },
		]);
	});

	test("parses line:char format errors", () => {
		const result = parseTabErrors("5:12 unexpected token");
		expect(result).toEqual([
			{ line: 5, message: "unexpected token" },
		]);
	});

	test("parses line:char format with colon separator", () => {
		const result = parseTabErrors("10:3: missing value");
		expect(result).toEqual([
			{ line: 10, message: "missing value" },
		]);
	});

	test("sanitises absolute paths before parsing", () => {
		const result = parseTabErrors(
			"Error: /Users/test/project/tmp/input.tab:5:12 bad input",
		);
		// After sanitisation, "/Users/test/project/tmp/input.tab" → "[path]"
		// Then enhance strips [path], so "5:12 bad input" won't match line:char
		// The whole line becomes a generic error
		expect(result.length).toBe(1);
		expect(result[0].message).not.toContain("/Users/");
	});

	test("sanitises /tmp paths", () => {
		const result = parseTabErrors(
			"Can't open /tmp/tabbo-abc123/input.tab",
		);
		expect(result[0].message).not.toContain("/tmp/");
	});

	test("sanitises Windows paths", () => {
		const result = parseTabErrors(
			"Can't open C:\\Users\\test\\project\\input.tab",
		);
		expect(result[0].message).not.toContain("C:\\Users");
	});

	test("sanitises UUID-based filenames", () => {
		const result = parseTabErrors(
			"Error in a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.tab",
		);
		expect(result[0].message).toContain("input.tab");
	});

	test("handles Bad character with match pattern", () => {
		const result = parseTabErrors("Bad character-z-5");
		expect(result).toEqual([
			{
				line: undefined,
				message:
					"Invalid character 'z'. Hint: Use letters a-p for frets, 1-9 for Italian style, or space for unplayed strings.",
			},
		]);
	});

	test("handles Bad character with line number", () => {
		const result = parseTabErrors("line 7: Bad character-x-3");
		expect(result[0].line).toBe(7);
		expect(result[0].message).toContain("Invalid character 'x'");
	});

	test("handles Bad character without match pattern", () => {
		const result = parseTabErrors("Bad character in input");
		expect(result[0].message).toBe("Bad character in input");
	});

	test("handles get_width error", () => {
		const result = parseTabErrors("get_width: overflow on line 12");
		expect(result[0].line).toBe(12);
		expect(result[0].message).toContain("Tablature too wide");
		expect(result[0].message).toContain("Hint:");
	});

	test("handles not found error", () => {
		const result = parseTabErrors("value not found at line 3");
		expect(result[0].line).toBe(3);
		expect(result[0].message).toContain("Hint: Check that all referenced values");
	});

	test("handles end of file error", () => {
		const result = parseTabErrors("unexpected end of file");
		expect(result[0].message).toContain('Add "e" on a new line');
	});

	test("handles EOF error", () => {
		const result = parseTabErrors("EOF before expected");
		expect(result[0].message).toContain('Add "e" on a new line');
	});

	test("handles grid error", () => {
		const result = parseTabErrors("invalid grid specification");
		expect(result[0].message).toContain("Grids start with #");
	});

	test("handles Grid (capitalised) error", () => {
		const result = parseTabErrors("Grid error on line 5");
		expect(result[0].line).toBe(5);
		expect(result[0].message).toContain("Grids start with #");
	});

	test("handles font error", () => {
		const result = parseTabErrors("font lute9 missing");
		expect(result[0].message).toContain("TABFONTS");
	});

	test("handles Font (capitalised) error", () => {
		const result = parseTabErrors("Font not loaded");
		expect(result[0].message).toContain("TABFONTS");
	});

	test("handles system error with number", () => {
		const result = parseTabErrors("error in system 3");
		expect(result[0].message).toContain("(in system 3)");
	});

	test("handles system error without number", () => {
		const result = parseTabErrors("system error occurred");
		expect(result[0].message).not.toContain("(in system");
	});

	test("handles barline error", () => {
		const result = parseTabErrors("invalid barline");
		expect(result[0].message).toContain('Use "b" for barline');
	});

	test("handles bar line (two words) error", () => {
		const result = parseTabErrors("bad bar line on line 8");
		expect(result[0].line).toBe(8);
		expect(result[0].message).toContain('Use "b" for barline');
	});

	test("handles flag error", () => {
		const result = parseTabErrors("invalid flag value");
		expect(result[0].message).toContain("Flags are 0-5");
	});

	test("strips Error: prefix", () => {
		const result = parseTabErrors("Error: something went wrong");
		expect(result[0].message).toBe("something went wrong");
	});

	test("strips Warning: prefix", () => {
		const result = parseTabErrors("Warning: minor issue");
		expect(result[0].message).toBe("minor issue");
	});

	test("parses multiple errors", () => {
		const input = [
			"3:5 first error",
			"7:1 second error",
			"Bad character-q-2",
		].join("\n");

		const result = parseTabErrors(input);
		expect(result).toHaveLength(3);
		expect(result[0].line).toBe(3);
		expect(result[1].line).toBe(7);
		expect(result[2].message).toContain("Invalid character 'q'");
	});

	test("skips informational lines among real errors", () => {
		const input = [
			"tab 4.3.108 copyright 1995-2025 by Wayne Cripps",
			"3:5 actual error",
			"setting filename to input.tab",
		].join("\n");

		const result = parseTabErrors(input);
		expect(result).toHaveLength(1);
		expect(result[0].line).toBe(3);
	});

	test("extracts line number from 'line N' in generic errors", () => {
		const result = parseTabErrors("unknown problem at line 42");
		expect(result[0].line).toBe(42);
	});

	test("collapses whitespace in output", () => {
		const result = parseTabErrors("too    many     spaces");
		expect(result[0].message).toBe("too many spaces");
	});
});
