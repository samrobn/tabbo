import { describe, expect, test } from "bun:test";
import { addRecentDir } from "./recent-dirs";

describe("addRecentDir", () => {
  test("prepends a new dir", () => {
    expect(addRecentDir(["/a"], "/b")).toEqual(["/b", "/a"]);
  });
  test("moves an existing dir to the front (dedupe)", () => {
    expect(addRecentDir(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });
  test("caps the list length (default 5)", () => {
    expect(addRecentDir(["/a", "/b", "/c", "/d", "/e"], "/f")).toEqual([
      "/f", "/a", "/b", "/c", "/d",
    ]);
  });
  test("respects an explicit cap", () => {
    expect(addRecentDir(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });
});
