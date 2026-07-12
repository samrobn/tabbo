// Regenerates icon.iconset/ from assets/icon/icon.svg.
//
// Run after editing the master SVG: `bun run scripts/build-iconset.ts`
// Then rebuild the .icns via `iconutil -c icns icon.iconset -o icon.icns`
// (electrobun's build does this itself when build.mac.icons points at
// icon.iconset, per electrobun.config.ts).
//
// Uses @napi-rs/canvas (already a devDependency for the tab typesetting
// engine) to rasterise the SVG - no extra dependency needed.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, Image } from "@napi-rs/canvas";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svgPath = join(root, "assets/icon/icon.svg");
const outDir = join(root, "icon.iconset");

const svg = readFileSync(svgPath);

// Apple's standard 10-entry iconset: base size + its @2x render.
const sizes = [16, 32, 128, 256, 512];

mkdirSync(outDir, { recursive: true });

for (const size of sizes) {
	for (const scale of [1, 2] as const) {
		const px = size * scale;
		const img = new Image();
		img.src = svg;
		const canvas = createCanvas(px, px);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(img, 0, 0, px, px);
		const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
		writeFileSync(join(outDir, name), canvas.toBuffer("image/png"));
		console.log(`wrote ${name} (${px}x${px})`);
	}
}
