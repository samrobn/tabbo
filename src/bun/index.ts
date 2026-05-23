import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { getEngineWorker } from "./engine-worker";
import { openTabFile, saveTabFile, exportPdfFromContent, getCapturesDir } from "./file-manager";
import { loadSettings, updateSettings } from "./settings";
import { setupMenu } from "./menu";
import type { TabboRPC, MenuAction } from "../shared/rpc-types";
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

const rpc = BrowserView.defineRPC<TabboRPC>({
	maxRequestTime: 15_000,
	handlers: {
		requests: {
			getLayout: async ({ content }) => getEngineWorker().getLayout(content),
			compileToPdf: async ({ content, filename }) =>
				exportPdfFromContent(content, filename),
			openFile: async () => openTabFile(),
			saveFile: async ({ content, filename }) =>
				saveTabFile(content, filename),
			getSettings: async () => loadSettings(),
			updateSettings: async (partial) => updateSettings(partial),
			checkForUpdate: async () => checkForUpdate(),
			startUpdateDownload: async () => {
				// Fire-and-forget: progress events arrive via updateStatusChanged
				startUpdateDownload();
				return {};
			},
			applyDownloadedUpdate: async () => {
				// On success the process replaces itself and never resolves;
				// on failure the rejection propagates to the webview's catch
				// so the Restart button can recover from a stuck-applying state.
				await applyDownloadedUpdate();
				return {};
			},
		},
		messages: {
			titleChanged: ({ title }) => {
				mainWindow.setTitle(title);
			},
		},
	},
});

const channel = await Updater.localInfo.channel();
const url = await getMainViewUrl(channel);

const mainWindow = new BrowserWindow({
	title: "Tabbo",
	url,
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
	rpc,
});

// Push update lifecycle events to the webview. Registered after mainWindow
// exists so rpc.send is available; the webview triggers checkForUpdate from
// onMounted and drives the update flow from there.
subscribeToUpdateStatus((status) => {
	rpc.send.updateStatusChanged({ status });
});

// Map menu actions to webview messages
const menuActionMap: Record<string, MenuAction> = {
	"file:open": "open",
	"file:save": "save",
	"file:exportPdf": "exportPdf",
	"help:syntax": "showHelp",
};

setupMenu((action) => {
	const menuAction = menuActionMap[action];
	if (menuAction) {
		rpc.send.menuAction({ action: menuAction });
	}
});

// Persist last opened file on startup
const settings = await loadSettings();
if (settings.lastOpenedFile) {
	console.log(`Last opened: ${settings.lastOpenedFile}`);
}

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
