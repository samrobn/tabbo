import { describe, expect, test } from "bun:test";
import { parseChangelog } from "./changelog-parser";

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

- Something in progress

## [1.2.0] - 2024-06-01

### Added
- New feature A
- New feature B

### Fixed
- Bug fix C

## [1.1.0] - 2024-05-01

Some content for 1.1.0.

## 1.0.0

Initial release.
`;

describe("parseChangelog", () => {
	test("returns section body for bracketed version", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG, "1.2.0");
		expect(result).not.toBeNull();
		expect(result).toContain("New feature A");
		expect(result).toContain("Bug fix C");
	});

	test("does not include content from the next version section", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG, "1.2.0");
		expect(result).not.toContain("Some content for 1.1.0");
	});

	test("returns section body for non-bracketed version heading", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG, "1.0.0");
		expect(result).toBe("Initial release.");
	});

	test("returns section body for middle version", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG, "1.1.0");
		expect(result).toBe("Some content for 1.1.0.");
	});

	test("returns null when version is not present", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG, "9.9.9");
		expect(result).toBeNull();
	});

	test("returns null for empty markdown", () => {
		const result = parseChangelog("", "1.0.0");
		expect(result).toBeNull();
	});

	test("returns null when matching heading has no body before next heading", () => {
		const markdown = `## [1.0.0]\n\n## [0.9.0]\n\nOlder.`;
		const result = parseChangelog(markdown, "1.0.0");
		expect(result).toBeNull();
	});

	test("handles pre-release versions with hyphens (alpha/beta)", () => {
		const markdown = `## [1.0.0-alpha.1] - 2024-01-01\n\nFirst alpha.\n\n## [0.9.0]\n\nOlder.`;
		const result = parseChangelog(markdown, "1.0.0-alpha.1");
		expect(result).toBe("First alpha.");
	});

	test("handles pre-release version in non-bracketed heading", () => {
		const markdown = `## 0.1.0-alpha.1\n\nAlpha notes.\n\n## 0.0.1\n\nOlder.`;
		const result = parseChangelog(markdown, "0.1.0-alpha.1");
		expect(result).toBe("Alpha notes.");
	});

	test("strips leading and trailing blank lines from body", () => {
		const markdown = `## [2.0.0]\n\n\nBody text.\n\n\n## [1.0.0]\n\nOlder.`;
		const result = parseChangelog(markdown, "2.0.0");
		expect(result).toBe("Body text.");
	});

	test("does not match a pre-release when searching for the base version", () => {
		// Regression: lookahead used to include `-`, so `1.0.0` matched
		// `## [1.0.0-alpha.1]` and returned the pre-release body.
		const markdown = `## [1.0.0-alpha.1] - 2024-01-01\n\nFirst alpha.\n\n## [0.9.0]\n\nOlder.`;
		const result = parseChangelog(markdown, "1.0.0");
		expect(result).toBeNull();
	});

	test("prefers exact-match stable over a pre-release of the same base", () => {
		const markdown = `## [1.0.0] - 2024-02-01\n\nStable.\n\n## [1.0.0-alpha.1]\n\nAlpha.\n\n## [0.9.0]\n\nOlder.`;
		const result = parseChangelog(markdown, "1.0.0");
		expect(result).toBe("Stable.");
	});
});
