import type { UpdateStatusEntry } from "electrobun/main";
import type { UpdateStatus } from "../shared/rpc-types";
import { electrobunStatusToPhase, shouldRelayEntry } from "./updater-status";

type StatusSender = (status: UpdateStatus) => void;

/** The part of Electrobun's `Updater` the relay uses. */
export interface StatusSource {
	onStatusChange(listener: ((entry: UpdateStatusEntry) => void) | null): void;
}

/**
 * Relays Electrobun update statuses to the webview while a check, download, or
 * apply runs. Electrobun 2.x polls its native core every 50 ms for as long as a
 * status listener is set, so an always-on listener would poll for the life of
 * the app; the listener is set only around operations. Which entries pass is
 * `shouldRelayEntry`'s call: operation outcomes come from updater state, not
 * from this stream.
 */
export function createStatusRelay(source: StatusSource) {
	let send: StatusSender | null = null;
	let running = 0;

	function relay(entry: UpdateStatusEntry): void {
		if (send === null || !shouldRelayEntry(entry)) return;
		const mapped = electrobunStatusToPhase(entry.status, entry.details, entry.message);
		if (mapped !== null) send(mapped);
	}

	return {
		setSender(next: StatusSender): void {
			send = next;
		},
		/** Push a status read from updater state rather than the event stream. */
		push(status: UpdateStatus): void {
			send?.(status);
		},
		async around<T>(run: () => Promise<T>): Promise<T> {
			running += 1;
			source.onStatusChange(relay);
			try {
				return await run();
			} finally {
				running -= 1;
				if (running === 0) source.onStatusChange(null);
			}
		},
	};
}
