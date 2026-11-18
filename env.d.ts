/// <reference types="vite/client" />

declare module "*.vue" {
	import type { DefineComponent } from "vue";
	const component: DefineComponent<object, object, unknown>;
	export default component;
}

// electrobun ships its bun API as .ts source (so skipLibCheck can't skip it),
// and that source imports three.js, which has no bundled types. Tabbo never uses
// three, so an untyped stub beats adding @types/three.
declare module "three";
