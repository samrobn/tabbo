/// <reference types="vitest/config" />
import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
	plugins: [vue()],
	resolve: {
		alias: electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
	},
	root: "src/mainview",
	// Vue component tests (bun run test:vue). Vitest reads this config, so the
	// SFC pipeline is the same one the app builds with. root above scopes
	// discovery to src/mainview - worktrees under .claude/ are never scanned.
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
	},
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
