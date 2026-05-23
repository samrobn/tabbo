import { ApplicationMenu, Utils } from "electrobun/bun";
import type { ApplicationMenuItemConfig } from "electrobun/bun";

const DOCS_URL = "https://www.cs.dartmouth.edu/~wbc/lute/AboutTab.html";

const menuTemplate: ApplicationMenuItemConfig[] = [
	{
		label: "Tabbo",
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "File",
		submenu: [
			{ label: "Open...", action: "file:open", accelerator: "Cmd+O" },
			{ type: "separator" },
			{ label: "Save", action: "file:save", accelerator: "Cmd+S" },
			{
				label: "Export PDF",
				action: "file:exportPdf",
				accelerator: "Cmd+Shift+E",
			},
			{ type: "separator" },
			{ role: "close" },
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
		],
	},
	{
		label: "Help",
		submenu: [
			{ label: "Tablature Syntax Help", action: "help:syntax" },
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
