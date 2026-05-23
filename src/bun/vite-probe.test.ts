import { describe, expect, test } from "bun:test";
import { looksLikeViteEntry, probeViteServer } from "./vite-probe";

describe("looksLikeViteEntry", () => {
	test("recognises Vite's typical ESM entry", () => {
		expect(looksLikeViteEntry("import App from './App.vue'")).toBe(true);
	});

	test("recognises entry with leading whitespace", () => {
		expect(looksLikeViteEntry("\n  import { foo } from 'bar'")).toBe(true);
	});

	test("rejects foreign HTML server response", () => {
		expect(
			looksLikeViteEntry("<html><head><title>Foo</title></head>..."),
		).toBe(false);
	});
});

function fakeFetch(impl: () => Promise<Response> | Response): typeof fetch {
	return (async () => impl()) as unknown as typeof fetch;
}

describe("probeViteServer", () => {
	test("returns 'absent' when fetch rejects (port closed)", async () => {
		const result = await probeViteServer(
			fakeFetch(() => {
				throw new Error("ECONNREFUSED");
			}),
		);
		expect(result).toBe("absent");
	});

	test("returns 'absent' when fetch times out", async () => {
		const result = await probeViteServer(
			fakeFetch(() => {
				const err = new Error("The operation was aborted");
				err.name = "TimeoutError";
				throw err;
			}),
		);
		expect(result).toBe("absent");
	});

	test("returns 'foreign' on non-OK status", async () => {
		const result = await probeViteServer(
			fakeFetch(() => new Response("not found", { status: 404 })),
		);
		expect(result).toBe("foreign");
	});

	test("returns 'foreign' on 200 with non-ESM body", async () => {
		const result = await probeViteServer(
			fakeFetch(() => new Response("<!DOCTYPE html><html>...</html>")),
		);
		expect(result).toBe("foreign");
	});

	test("returns 'tabbo' on 200 with ESM body", async () => {
		const result = await probeViteServer(
			fakeFetch(() =>
				new Response("import App from './App.vue';\nimport './main.css';"),
			),
		);
		expect(result).toBe("tabbo");
	});

	test("returns 'tabbo' on 200 with leading whitespace before import", async () => {
		const result = await probeViteServer(
			fakeFetch(() => new Response("\n\n  import { x } from 'y';")),
		);
		expect(result).toBe("tabbo");
	});
});
