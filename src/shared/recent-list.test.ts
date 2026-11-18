import { describe, expect, test } from "bun:test";
import { addRecent, applyRecentsChange, migrateLastOpened } from "./recent-list";

describe("addRecent", () => {
  test("prepends a new dir", () => {
    expect(addRecent(["/a"], "/b")).toEqual(["/b", "/a"]);
  });
  test("moves an existing dir to the front (dedupe)", () => {
    expect(addRecent(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });
  test("caps the list length (default 5)", () => {
    expect(addRecent(["/a", "/b", "/c", "/d", "/e"], "/f")).toEqual([
      "/f", "/a", "/b", "/c", "/d",
    ]);
  });
  test("respects an explicit cap", () => {
    expect(addRecent(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });
});

describe("applyRecentsChange", () => {
	const current = { recentFiles: ["/u/test/a.tab", "/u/test/b.tab"], recentSaveDirs: ["/u/test"] };

	test("adds an opened file to the front of the stored list, whatever the webview holds", () => {
		expect(applyRecentsChange(current, { addFile: "/u/test/c.tab" }).recentFiles).toEqual(["/u/test/c.tab", "/u/test/a.tab", "/u/test/b.tab"]);
	});

	test("removes a missing file and leaves the rest", () => {
		expect(applyRecentsChange(current, { removeFile: "/u/test/a.tab" })).toEqual({ recentFiles: ["/u/test/b.tab"], recentSaveDirs: ["/u/test"] });
	});

	test("a save records the file and its folder", () => {
		const after = applyRecentsChange(current, { addFile: "/u/test/x/d.tab", addSaveDir: "/u/test/x" });
		expect(after.recentFiles[0]).toBe("/u/test/x/d.tab");
		expect(after.recentSaveDirs).toEqual(["/u/test/x", "/u/test"]);
	});
});

describe("migrateLastOpened", () => {
	test("seeds an empty recent list from the old last-opened file and drops the key", () => {
		expect(migrateLastOpened({ lastOpenedFile: "/u/test/a.tab", fontSize: 12 })).toEqual({ recentFiles: ["/u/test/a.tab"], fontSize: 12 });
	});

	test("leaves an existing recent list alone", () => {
		expect(migrateLastOpened({ lastOpenedFile: "/u/test/a.tab", recentFiles: ["/u/test/b.tab"] })).toEqual({ recentFiles: ["/u/test/b.tab"] });
	});
});

