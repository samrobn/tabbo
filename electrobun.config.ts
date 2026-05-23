import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

// Suffix the bundle identifier per channel so dev/canary/stable installs
// don't collide. Without this, AppleScript `tell application id "..."` and
// LaunchServices both pick whichever instance is frontmost when multiple
// channels are installed - which is the wrong one in dev workflows.
// `electrobun dev` implies channel=dev; `electrobun build --env=<x>` is
// explicit; everything else falls through to stable.
const VALID_CHANNELS = ["dev", "canary", "stable"] as const;
type Channel = (typeof VALID_CHANNELS)[number];

function detectChannel(): Channel {
	if (process.argv[2] === "dev") return "dev";
	const envArg = process.argv.find((arg) => arg.startsWith("--env="))?.split("=")[1];
	return VALID_CHANNELS.includes(envArg as Channel) ? (envArg as Channel) : "stable";
}

const channel = detectChannel();
const identifier = channel === "stable" ? "dev.tabbo.app" : `dev.tabbo.app.${channel}`;

export default {
	app: {
		name: "Tabbo",
		identifier,
		version: pkg.version,
	},
	build: {
		// Vite builds Vue app to dist/, copy into views for Electrobun
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// WOFF2 tab fonts for the SVG renderer (served as /fonts/*.woff2 by the webview)
			"dist/fonts": "views/mainview/fonts",
			// Body-text WOFF2 (TabboBody → Tinos), served as /body-fonts/Tinos-Regular.woff2 by the webview
			"dist/body-fonts": "views/mainview/body-fonts",
			// Font files for the tab typesetting engine (84 files, 3.3M)
			"engine/fonts": "resources/fonts",
			// Body-text font for Skia rasteriser — separate from engine/fonts (lute glyphs only).
			// OFL.txt ships alongside per OFL 1.1 §4 (font binaries must be accompanied by the licence).
			"assets/fonts/Tinos-Regular.woff2": "resources/body-fonts/Tinos-Regular.woff2",
			"assets/fonts/OFL.txt": "resources/body-fonts/OFL.txt",
			// Tab binary (C++ typesetter)
			"engine/tab": "resources/bin/tab",
			// Ghostscript binary (PS-to-PDF, self-contained with compiled-in init)
			"gs/gs-minimal": "resources/bin/gs",
			// Eval fixtures (small .tab files) consumed by the dev capture-server's
			// `?source=<fixture>` flow. Bundled into all builds since `build.copy`
			// is build-time only; the capture-server itself is dev-channel-gated.
			"evals/fixtures": "resources/fixtures",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	release: {
		baseUrl: "https://github.com/samrobn/tabbo/releases/latest/download",
	},
	scripts: {
		postBuild: "./postbuild.ts",
	},
} satisfies ElectrobunConfig;
