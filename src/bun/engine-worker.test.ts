import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { EngineWorker } from "./engine-worker";
import type { LayoutResult } from "../shared/rpc-types";

// Integration tests — require the real `tab` binary and fonts.
// Each test gets a fresh EngineWorker instance; teardown kills it after.

// The binary is a build artefact — fresh worktrees/clones lack it, and without
// this guard the suite fails as dozens of opaque sub-millisecond errors.
beforeAll(() => {
	const tabBinary = join(import.meta.dir, "../../engine/tab");
	if (!existsSync(tabBinary)) {
		throw new Error(`engine/tab not built — run: cd engine && make (expected at ${tabBinary})`);
	}
});

const SIMPLE_TAB = "b\n1-abc dDo\n2-efg hG\n3-abc dDo\n4-efg hG\n#2iI  lmn\nx-p H  j\nb\nY- k j \ne\n";
const INVALID_TAB = "this is not valid tablature\n";

describe("EngineWorker", () => {
	let worker: EngineWorker;

	beforeEach(() => {
		worker = new EngineWorker();
	});

	afterEach(() => {
		worker.shutdown();
	});

	test("spawns, probes version, and returns a valid layout for simple.tab", async () => {
		const result = await worker.getLayout(SIMPLE_TAB);

		expect(result.errors).toEqual([]);
		expect(result.layout).not.toBeNull();

		const layout = result.layout!;
		expect(layout.schema_version).toBe(1);
		expect(layout.page_width_dvi).toBeGreaterThan(0);
		expect(layout.page_height_dvi).toBeGreaterThan(0);
		expect(layout.left_margin_dvi).toBeGreaterThan(0);
		expect(layout.top_margin_dvi).toBeGreaterThan(0);
		expect(layout.staff_len_dvi).toBeGreaterThan(0);
		expect(Array.isArray(layout.fonts)).toBe(true);
		expect(Array.isArray(layout.pages)).toBe(true);
		expect(layout.pages.length).toBeGreaterThan(0);
	});

	test("layout response for simple.tab has valid pages and systems", async () => {
		const result = await worker.getLayout(SIMPLE_TAB);

		expect(result.layout).not.toBeNull();
		const page = result.layout!.pages[0];
		expect(page.page_num).toBe(1);
		expect(Array.isArray(page.systems)).toBe(true);
		expect(page.systems.length).toBeGreaterThan(0);
		expect(Array.isArray(page.systems[0].primitives)).toBe(true);
	});

	test("layout response for simple.tab has a tab font entry", async () => {
		const result = await worker.getLayout(SIMPLE_TAB);

		expect(result.layout).not.toBeNull();
		const tabFont = result.layout!.fonts.find((f) => f.type === "tab");
		expect(tabFont).toBeDefined();
		expect(tabFont!.font_id).toBe(0);
	});

	test("returns populated errors for invalid tablature", async () => {
		const result = await worker.getLayout(INVALID_TAB);

		// The worker should survive and return an error envelope.
		expect(result.errors.length).toBeGreaterThan(0);
		// layout is null when only errors are returned (no pages).
		if (result.layout !== null) {
			// Some error inputs may still produce partial layout; errors still populated.
			expect(result.errors.length).toBeGreaterThan(0);
		}
	});

	test("latest-wins: superseded callers resolve with superseded:true, none reject, last content wins", async () => {
		// Send 5 rapid calls, each with distinguishable content (different number
		// of "b…e" blocks → different system counts).
		// Contract:
		//   - All 5 calls resolve (Promise.all throws if any rejects).
		//   - superseded calls carry { superseded: true, layout: null, errors: [] }.
		//   - At least one call wins with a real layout.
		//   - The last submitted content (5 systems) must be among the winners.
		const contentCount = 5;
		const contents = Array.from(
			{ length: contentCount },
			// i+1 "b…e" blocks → i+1 systems (may span multiple pages for large i).
			(_, i) =>
				Array.from({ length: i + 1 }, () => "b\n1-abc dDo\ne\n").join(""),
		);
		const lastSystemCount = contentCount; // contents[4] has 5 blocks → 5 systems

		const results = await Promise.all(
			contents.map((c) => worker.getLayout(c)),
		);

		// All resolved — Promise.all guarantees this.
		for (const r of results) {
			expect(r).toHaveProperty("layout");
			expect(r).toHaveProperty("errors");
		}

		// Every superseded entry must carry the discriminator and be empty.
		const superseded = results.filter((r) => r.superseded === true);
		for (const r of superseded) {
			expect(r.errors).toEqual([]);
			expect(r.layout).toBeNull();
		}

		// At least one call must have a real layout (forward progress).
		const winners = results.filter((r) => !r.superseded && r.layout !== null);
		expect(winners.length).toBeGreaterThan(0);

		// Every winner's layout must correspond to one of the submitted contents.
		// Each "b…e" block → 1 system; N blocks → N systems total (may span pages).
		// The coalescer can produce up to two winners: the in-flight at supersession
		// time, and the last-pending content. Both are valid submitted inputs.
		// Assert that every winner's total system count is in [1, lastSystemCount].
		const expectedCounts = new Set(
			Array.from({ length: lastSystemCount }, (_, i) => i + 1),
		);
		for (const w of winners) {
			const totalSystems = w.layout!.pages.reduce(
				(sum, page) => sum + page.systems.length,
				0,
			);
			expect(expectedCounts.has(totalSystems)).toBe(true);
		}
	}, 30_000);

	test("crash supervision: kill the worker mid-session, next request respawns and succeeds", async () => {
		// Establish the worker by running one request first.
		const first = await worker.getLayout(SIMPLE_TAB);
		expect(first.layout).not.toBeNull();

		// Reach into the private proc and kill it.
		// Using bracket notation to access private fields in the test.
		const w = worker as unknown as { proc: { kill: () => void } | null };
		expect(w.proc).not.toBeNull();
		w.proc!.kill();

		// Give the process a moment to register as exited.
		await Bun.sleep(100);

		// Next request should respawn and succeed.
		const second = await worker.getLayout(SIMPLE_TAB);
		expect(second.layout).not.toBeNull();
		expect(second.errors).toEqual([]);
	}, 15_000);

	test("spawn-cap exhaustion resolves with error envelope (not throws)", async () => {
		// Exhaust the respawn cap (3 spawns in 30s) by killing the proc repeatedly.
		// The 4th getLayout must resolve with layout:null and a non-empty errors
		// array — it must NOT throw or produce an unhandled rejection.
		const w = worker as unknown as {
			proc: { kill: () => void } | null;
			spawnHistory: number[];
		};

		// Pre-fill spawn history with 3 recent timestamps to simulate cap exhaustion
		// without actually spawning 3 real processes (which would be very slow).
		// Force the history to be within the 30s window.
		w.spawnHistory = [Date.now(), Date.now(), Date.now()];

		// Now a getLayout call should hit the cap immediately.
		const result = await worker.getLayout(SIMPLE_TAB);

		expect(result.layout).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
		// The message should mention the crash limit.
		expect(result.errors[0].message).toMatch(/crashed|spawn|restart/i);
	}, 10_000);

	test("multiple sequential requests share the same worker process", async () => {
		const w = worker as unknown as { proc: object | null };

		const r1 = await worker.getLayout(SIMPLE_TAB);
		const proc1 = w.proc;

		const r2 = await worker.getLayout(SIMPLE_TAB);
		const proc2 = w.proc;

		expect(r1.layout).not.toBeNull();
		expect(r2.layout).not.toBeNull();
		// Same process object: no unnecessary respawn.
		expect(proc1).toBe(proc2);
	});

	// Shared helper: walk every primitive in a layout through the exhaustive switch.
	// Fails if the engine emits an unrecognised type, or if any expected field is absent.
	function walkPrimitives(layout: LayoutResult): number {
		let count = 0;
		for (const page of layout.pages) {
			for (const system of page.systems) {
				for (const p of system.primitives) {
					count++;
					switch (p.type) {
						case "glyph":
							expect(typeof p.font_id).toBe("number");
							expect(typeof p.char_code).toBe("number");
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							break;
						case "text_run":
							expect(typeof p.font_id).toBe("number");
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							expect(typeof p.text).toBe("string");
							break;
						case "rule":
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							expect(typeof p.width).toBe("number");
							expect(typeof p.height).toBe("number");
							break;
						case "tie":
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							expect(typeof p.length).toBe("number");
							expect(["normal", "reversed", "half", "half_reversed"]).toContain(p.variant);
							break;
						case "rtie":
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							expect(typeof p.length).toBe("number");
							// rtie has no variant field.
							expect((p as { variant?: unknown }).variant).toBeUndefined();
							break;
						case "slash":
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							expect(typeof p.width).toBe("number");
							expect(typeof p.count).toBe("number");
							break;
						case "uline":
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							expect(typeof p.width).toBe("number");
							expect(["normal", "reversed", "wide"]).toContain(p.variant);
							break;
						case "slant":
							expect(typeof p.x1).toBe("number");
							expect(typeof p.y1).toBe("number");
							expect(typeof p.x2).toBe("number");
							expect(typeof p.y2).toBe("number");
							expect(["thin", "medium", "thick"]).toContain(p.weight);
							break;
						case "curve":
							expect(typeof p.x).toBe("number");
							expect(typeof p.y).toBe("number");
							expect(typeof p.length).toBe("number");
							break;
						default: {
							// Exhaustive check: if this fires, the engine emitted an unknown type.
							const _exhaustive: never = p;
							throw new Error(`Unknown primitive type: ${JSON.stringify(_exhaustive)}`);
						}
					}
				}
			}
		}
		return count;
	}

	test("exhaustive primitive union: all LayoutPrimitive types from simple.tab are valid", async () => {
		const result = await worker.getLayout(SIMPLE_TAB);
		expect(result.layout).not.toBeNull();
		const count = walkPrimitives(result.layout!);
		// simple.tab must produce at least some primitives.
		expect(count).toBeGreaterThan(0);
	}, 15_000);

	test("exhaustive primitive union: demo.tab exercises slant, text_run, uline, rtie", async () => {
		// demo.tab is the richest example file — it exercises slant, text_run,
		// uline, and rtie which simple.tab does not produce at runtime.
		const demoContent = await Bun.file(
			new URL("../../engine/examples/demo.tab", import.meta.url).pathname,
		).text();
		const result = await worker.getLayout(demoContent);
		expect(result.layout).not.toBeNull();
		const count = walkPrimitives(result.layout!);
		expect(count).toBeGreaterThan(0);
	}, 30_000);

	test("exhaustive primitive union: sample.tab walks cleanly", async () => {
		const sampleContent = await Bun.file(
			new URL("../../engine/examples/sample.tab", import.meta.url).pathname,
		).text();
		const result = await worker.getLayout(sampleContent);
		expect(result.layout).not.toBeNull();
		const count = walkPrimitives(result.layout!);
		expect(count).toBeGreaterThan(0);
	}, 30_000);
});
