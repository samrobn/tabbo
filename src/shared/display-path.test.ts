import { describe, expect, test } from "bun:test";
import { basename, dirname } from "./display-path";

describe("display-path", () => {
	test("basename and dirname split a path at its last slash", () => {
		expect(basename("/u/test/scores/Song.tab")).toBe("Song.tab");
		expect(dirname("/u/test/scores/Song.tab")).toBe("/u/test/scores");
	});

	test("dirname of a root-level file is the root, and of a bare name is empty", () => {
		expect(dirname("/Song.tab")).toBe("/");
		expect(dirname("Song.tab")).toBe("");
	});
});
