const EPOCH_KEY = "__motelStartupEpoch"

type GlobalWithStartupEpoch = typeof globalThis & {
	[EPOCH_KEY]?: number
}

const globalWithEpoch = globalThis as GlobalWithStartupEpoch

if (globalWithEpoch[EPOCH_KEY] === undefined) {
	globalWithEpoch[EPOCH_KEY] = performance.now()
}

export const startupBenchEnabled =
	process.env.MOTEL_BENCH_STARTUP_PHASES === "1"

export const startupBenchMark = (phase: string) => {
	if (!startupBenchEnabled) return
	const elapsedMs =
		performance.now() - (globalWithEpoch[EPOCH_KEY] ?? performance.now())
	process.stderr.write(`[motel-startup] ${phase} ${elapsedMs.toFixed(3)}ms\n`)
}
