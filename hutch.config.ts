// Keep bun.lock authoritative: without this, Hutch's own resolver ignores
// bun.lock and writes hutch.lock.
export default {
	packageManager: "bun",
};
