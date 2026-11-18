import Electrobun, { BrowserView, BrowserWindow, Screen, Updater, Utils } from "electrobun/main";
import { fileURLToPath } from "node:url";
import { getEngineWorker } from "./engine-worker";
import { openTabFile, saveTabFile, fileExists, readTabFile, previewSaveTarget, chooseFolder, exportPdfFromContent, getCapturesDir } from "./file-manager";
import { loadSettings, updateRecents, updateSettings } from "./settings";
import { setupMenu } from "./menu";
import { DEFAULT_WINDOW_FRAME, fillsADisplay, isRestorable, usableFrame } from "./window-frame";
import type { TabboRPC, MenuAction } from "../shared/rpc-types";
import { RPC_MAX_REQUEST_MS } from "../shared/rpc-types";
import { DEV_SERVER_PORT, DEV_SERVER_URL, probeViteServer } from "./vite-probe";
import {
	checkForUpdate,
	startUpdateDownload,
	applyDownloadedUpdate,
	subscribeToUpdateStatus,
} from "./updater";

async function getMainViewUrl(channel: string): Promise<string> {
	if (channel === "dev") {
		switch (await probeViteServer()) {
			case "tabbo":
				console.log(`HMR enabled: Tabbo Vite dev server at ${DEV_SERVER_URL}`);
				return DEV_SERVER_URL;
			case "foreign":
				console.error(
					`[tabbo] Port ${DEV_SERVER_PORT} is occupied by a foreign server - not Tabbo's Vite. ` +
					`HMR mode disabled, using built view. Kill the process on :${DEV_SERVER_PORT} ` +
					`(lsof -i :${DEV_SERVER_PORT}) before running 'bun run dev:hmr'.`,
				);
				break;
			case "absent":
				console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.");
				break;
		}
	}
	return "views://mainview/index.html";
}

// A document open that arrives before the webview has asked for one (the open
// that launched the app) waits here, so it never depends on a push landing
// after the page has loaded. See the open-url handler.
let pendingExternalOpen: string | null = null;
let webviewTookPendingOpen = false;

const rpc = BrowserView.defineRPC<TabboRPC>({
	maxRequestTime: RPC_MAX_REQUEST_MS,
	handlers: {
		requests: {
			getLayout: async ({ content }) => getEngineWorker().getLayout(content),
			compileToPdf: async ({ content, filename }) =>
				exportPdfFromContent(content, filename),
			openFile: async () => openTabFile(),
			saveFile: ({ content, filename, currentPath, confirmOverwrite, targetDir }) =>
				saveTabFile(content, filename, currentPath, confirmOverwrite ?? false, targetDir ?? null),
			fileExists: ({ path }) => fileExists(path),
			previewSaveTarget: ({ filename, currentPath, targetDir }) => previewSaveTarget(filename, currentPath, targetDir ?? null),
			chooseFolder: () => chooseFolder(),
			readFile: ({ path }) => readTabFile(path),
			getSettings: async () => loadSettings(),
			updateSettings: async (partial) => updateSettings(partial),
			updateRecents: async (change) => updateRecents(change),
			checkForUpdate: async () => checkForUpdate(),
			startUpdateDownload: async () => {
				// Fire-and-forget: progress events arrive via updateStatusChanged
				startUpdateDownload();
				return {};
			},
			applyDownloadedUpdate: async () => {
				// On success the app quits and the helper relaunches it; on
				// failure the rejection propagates to the webview's catch so
				// the Restart button can recover from a stuck-applying state.
				await applyDownloadedUpdate();
				return {};
			},
			takePendingExternalOpen: async () => {
				webviewTookPendingOpen = true;
				const path = pendingExternalOpen;
				pendingExternalOpen = null;
				return { path };
			},
		},
		messages: {
			windowActionResponse: ({ proceed }) => {
				// Utils.quit() runs Electrobun's full shutdown sequence (before-quit event,
				// native stop, force-exit).
				if (proceed) Utils.quit();
			},
		},
	},
});

// Electrobun 2.x rejects here if its native updater can't be configured; that
// must not stop the window opening, so fall back to the channel with no dev tools.
const channel = await Updater.localInfo.channel().catch((error: unknown) => {
	console.error("[tabbo] Could not read the update channel:", error);
	return "stable";
});
const url = await getMainViewUrl(channel);

const settings = await loadSettings();

const displayWorkAreas = () => Screen.getAllDisplays().map((display) => display.workArea);
const displayBounds = () => Screen.getAllDisplays().map((display) => display.bounds);

const savedFrame = usableFrame(settings.windowFrame);

const mainWindow = new BrowserWindow({
	title: "Tabbo",
	url,
	frame: savedFrame ?? DEFAULT_WINDOW_FRAME,
	rpc,
});

// Display geometry is read only once the window exists. Electrobun reads it with
// AppKit off the main thread, and doing that before the first window can win a
// race for the window-server connection and leave the window deaf to all input
// (electrobun issue 598, measured on 2.0.5; 1.18 calls the same native display
// function straight from bun, so it is assumed to share the race). A saved
// frame on a display that has gone moves to the default - without saving the
// default over it, so the window returns there when the display does.
let showingFallbackFrame = false;
if (savedFrame && !isRestorable(savedFrame, displayWorkAreas())) {
	const { x, y, width, height } = DEFAULT_WINDOW_FRAME;
	showingFallbackFrame = true;
	mainWindow.setFrame(x, y, width, height);
}

// Save the frame once a resize or drag settles, so a crash or force-quit keeps it too.
const FRAME_SAVE_DELAY_MS = 500;
let frameSaveTimer: ReturnType<typeof setTimeout> | null = null;
const saveFrameSoon = (): void => {
	if (frameSaveTimer) clearTimeout(frameSaveTimer);
	frameSaveTimer = setTimeout(() => {
		const frame = mainWindow.getFrame();
		// Never save a frame the next launch would reject or a fullscreen frame
		// (entering fullscreen fires a resize), which would replace the last
		// windowed one; nor the fallback frame until the user moves the window.
		if (!isRestorable(frame, displayWorkAreas()) || fillsADisplay(frame, displayBounds())) return;
		const { x, y, width, height } = DEFAULT_WINDOW_FRAME;
		if (showingFallbackFrame && frame.x === x && frame.y === y && frame.width === width && frame.height === height) return;
		showingFallbackFrame = false;
		void updateSettings({ windowFrame: frame }).catch((error) =>
			console.warn("[tabbo] could not save the window frame:", error),
		);
	}, FRAME_SAVE_DELAY_MS);
};
mainWindow.on("resize", saveFrameSoon);
mainWindow.on("move", saveFrameSoon);

// Push update lifecycle events to the webview. Registered after mainWindow
// exists so rpc.send is available; the webview triggers checkForUpdate from
// onMounted and drives the update flow from there.
subscribeToUpdateStatus((status) => {
	rpc.send.updateStatusChanged({ status });
});

// Whether the webview has received at least one focus event.
// Before first focus, RPC send was unreliable (Electrobun's first-focus gate,
// last observed on 1.16), so quit/close are dispatched directly without asking
// the webview.
let hasFocused = false;
mainWindow.on("focus", () => {
	hasFocused = true;
});

// Map menu actions to webview messages
const menuActionMap: Record<string, MenuAction> = {
	"file:new": "new",
	"file:newFromTemplate": "newFromTemplate",
	"file:open": "open",
	"file:save": "save",
	"file:revert": "revert",
	"file:exportPdf": "exportPdf",
	"file:close": "close",
	"help:syntax": "showHelp",
	"help:shortcuts": "showShortcuts",
	"app:checkForUpdates": "checkForUpdates",
	"edit:find": "find",
};

setupMenu((action) => {
	// Intercept quit before the generic map forward.
	// If the webview hasn't focused yet, quit directly (nothing to lose).
	// Once focused, ask the webview so it can confirm any unsaved-changes guard.
	if (action === "app:quit") {
		if (!hasFocused) {
			Utils.quit();
			return;
		}
		rpc.send.menuAction({ action: "quitRequested" });
		return;
	}

	const menuAction = menuActionMap[action];
	if (menuAction) {
		rpc.send.menuAction({ action: menuAction });
	}
});

// OS document opens (Finder double-click / Open With / drag onto the Dock
// icon). macOS delivers these through application:openURLs:, which Electrobun
// bridges to the open-url event as a file:// URL. On Electrobun 2.0.7-beta.24 a
// document open that launches the app arrives about 0.9-1.3s after bun starts,
// after this handler is registered, with the right URL (5 of 5 cold opens by
// `open -a`, Open With, and a drop on the app icon, 2026-11-18, probe registered
// at the top of this file), so the welcome screen shows briefly before the
// document. Until the webview has asked (takePendingExternalOpen) the path is
// held rather than pushed, so a slower page load can't lose it and it lands
// after the crash-restore prompt. On 1.18.1 the open arrived about 7ms after
// start, flushed from Electrobun's native buffer before this handler existed,
// with garbage in place of the URL. That flush is unchanged in 2.x - our
// reading: setURLOpenHandler in nativeWrapper.mm hands a threadsafe JSCallback
// a c_str() from a local vector freed before the callback runs - so an open
// that ever lands before the SDK registers its native handler would still
// arrive garbled. The fix for that belongs upstream.
Electrobun.events.on("open-url", (event: { data: { url: string } }) => {
	const url = event.data?.url ?? "";
	if (!url.startsWith("file://")) return; // no custom URL schemes in use
	let path: string;
	try {
		path = fileURLToPath(url); // handles %-encoding and literal ?/# safely
	} catch {
		return;
	}
	// Gate on the same extensions the open dialog allows - the UTI declaration
	// only filters Finder's association list, not what a caller can hand this
	// handler at runtime.
	if (!/\.(tab|txt)$/i.test(path)) return;
	// Pass just the path; the webview reads it through the existing readFile
	// RPC so read failures surface as its usual toast.
	if (webviewTookPendingOpen) rpc.send.openExternalFile({ path });
	else pendingExternalOpen = path;
});

// Graceful engine-worker shutdown on app exit.
// SIGPIPE from the parent dying usually suffices, but explicit teardown is cleaner.
// SIGTERM/SIGINT don't fire "exit" in Bun without explicit process.exit(0), so wire them.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("exit", () => {
	getEngineWorker().shutdown();
});

console.log("Tabbo started");

// Capture server: dev-only. Lets an external process (curl, eval pipeline)
// trigger live-preview captures for visual diffing against engine goldens.
// Dynamic import keeps the @napi-rs/canvas Skia native binding (~26 MB) out of
// the production bundle — the module is only loaded when channel === "dev".
if (channel === "dev") {
	const { startCaptureServer } = await import("./capture-server");
	startCaptureServer(getCapturesDir(), async (content) => {
		const response = await getEngineWorker().getLayout(content);
		if (response.layout === null) {
			const msg = response.errors[0]?.message ?? "Engine returned no layout";
			throw new Error(msg);
		}
		return response.layout;
	});
}
