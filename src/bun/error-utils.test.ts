import { describe, expect, test } from "bun:test";
import { toErrorMessage } from "./error-utils";

describe("toErrorMessage", () => {
	test("returns Error.message for Error instances", () => {
		expect(toErrorMessage(new Error("boom"))).toBe("boom");
	});

	test("returns the string verbatim for bare-string throws", () => {
		expect(toErrorMessage("Can't focus window. Window no longer exists")).toBe(
			"Can't focus window. Window no longer exists",
		);
	});

	test("stringifies non-Error, non-string thrown values", () => {
		expect(toErrorMessage(42)).toBe("42");
		expect(toErrorMessage(undefined)).toBe("undefined");
		expect(toErrorMessage(null)).toBe("null");
	});

	test("preserves subclass message", () => {
		class CustomError extends Error {}
		expect(toErrorMessage(new CustomError("custom"))).toBe("custom");
	});
});
