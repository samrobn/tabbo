import { describe, expect, test } from "bun:test";
import type { UpdateStatusEntry } from "electrobun/main";
import type { UpdateStatus } from "../shared/rpc-types";
import { createStatusRelay, type StatusSource } from "./update-relay";

type Listener = (entry: UpdateStatusEntry) => void;

// Models one behaviour of Electrobun 2.x's UpdaterClient: entries that arrive
// while no listener is set are queued and replayed to the next listener. It
// does not model the client's initialize() or its event/state read order -
// the relay no longer depends on either, because outcomes come from state.
function fakeSource() {
	let listener: Listener | null = null;
	const queued: UpdateStatusEntry[] = [];
	return {
		onStatusChange(next: Listener | null) {
			listener = next;
			if (next) for (const entry of queued.splice(0)) next(entry);
		},
		emit(entry: UpdateStatusEntry) {
			if (listener) listener(entry);
			else queued.push(entry);
		},
		listening: () => listener !== null,
	} satisfies StatusSource & Record<string, unknown>;
}

const entry = (status: UpdateStatusEntry["status"], details?: UpdateStatusEntry["details"], message = ""): UpdateStatusEntry => ({
	status,
	message,
	timestamp: 0,
	...(details ? { details } : {}),
});

function setup() {
	const source = fakeSource();
	const sent: UpdateStatus[] = [];
	const relay = createStatusRelay(source);
	relay.setSender((status) => sent.push(status));
	return { source, sent, relay };
}

describe("createStatusRelay", () => {
	test("relays progress while an operation runs", async () => {
		const { source, sent, relay } = setup();
		await relay.around(async () => source.emit(entry("downloading")));
		expect(sent).toEqual([{ phase: "downloading", progress: null }]);
	});

	test("an operation's error event stays silent - its outcome comes from state", async () => {
		const { source, sent, relay } = setup();
		await relay.around(async () => source.emit(entry("error", { errorMessage: "offline" }, "Failed to check for updates: offline")));
		expect(sent).toEqual([]);
	});

	test("a failed install found on relaunch is shown when it replays to the first listener", async () => {
		const { source, sent, relay } = setup();
		source.emit(entry("error", { currentHash: "a", latestHash: "b", errorMessage: "denied" }, "Update to 1.2.3 failed during replace: denied"));
		await relay.around(async () => {});
		expect(sent).toEqual([{ phase: "error", message: "Update to 1.2.3 failed during replace: denied" }]);
	});

	test("listens only while an operation runs", async () => {
		const { source, relay } = setup();
		let listeningDuring = false;
		await relay.around(async () => {
			listeningDuring = source.listening();
		});
		expect(listeningDuring).toBe(true);
		expect(source.listening()).toBe(false);
	});

	test("an overlapping operation keeps the listener until both end", async () => {
		const { source, relay } = setup();
		let finishDownload: () => void = () => {};
		const download = relay.around(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
		await relay.around(async () => {});
		expect(source.listening()).toBe(true);
		finishDownload();
		await download;
		expect(source.listening()).toBe(false);
	});
});
