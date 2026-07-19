import { ApplicationMenu, Utils } from "electrobun/bun";
import type { ApplicationMenuItemConfig } from "electrobun/bun";

// Wayne Cripps's Dartmouth lute pages were retired (the whole ~wbc/ path 403s);
// point at the archive.org snapshot, which preserves the original AboutTab.html.
const DOCS_URL =
	"https://web.archive.org/web/20260420024741/https://www.cs.dartmouth.edu/~wbc/lute/AboutTab.html";

const menuTemplate: ApplicationMenuItemConfig[] = [
	{
		label: "Tabbo",
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ label: "Check for Updates…", action: "app:checkForUpdates" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			{ type: "separator" },
			{ label: "Quit Tabbo", action: "app:quit", accelerator: "Cmd+Q" },
		],
	},
	{
		label: "File",
		submenu: [
			{ label: "New", action: "file:new", accelerator: "Cmd+N" },
			{ label: "New from Template...", action: "file:newFromTemplate" },
			{ label: "Open...", action: "file:open", accelerator: "Cmd+O" },
			{ label: "Close File", action: "file:close", accelerator: "Cmd+W" },
			{ type: "separator" },
			{ label: "Save", action: "file:save", accelerator: "Cmd+S" },
			{ label: "Discard Changes", action: "file:revert" },
			{
				label: "Export PDF",
				action: "file:exportPdf",
				accelerator: "Cmd+Shift+E",
			},
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
			{ type: "separator" },
			{ label: "Find", action: "edit:find", accelerator: "Cmd+F" },
		],
	},
	{
		label: "Help",
		submenu: [
			{ label: "Tablature Syntax Help", action: "help:syntax" },
			{ label: "Keyboard Shortcuts", action: "help:shortcuts", accelerator: "Cmd+Shift+/" },
			{ type: "separator" },
			{ label: "Tab Documentation", action: "help:docs" },
		],
	},
];

export type MenuCallback = (action: string) => void;

export function setupMenu(onAction: MenuCallback): void {
	ApplicationMenu.setApplicationMenu(menuTemplate);

	ApplicationMenu.on("application-menu-clicked", (event: { data: { action: string } }) => {
		const action = event.data?.action;
		if (!action) return;

		if (action === "help:docs") {
			Utils.openExternal(DOCS_URL);
			return;
		}

		onAction(action);
	});
}
