/**
 * Seed script for traceSortNav.repro.test.ts. Invoked as a child process so
 * `config.ts` picks up our test DB path at module-load time.
 */

import { Effect } from "effect"
import { storeRuntime } from "../runtime.ts"
import { TelemetryStore } from "../services/TelemetryStore.ts"

const SERVICE_NAME = "sort-nav-repro"
const base = BigInt(Date.now()) * 1_000_000n
const ms = (n: number) => String(base + BigInt(n) * 1_000_000n)

// A is the oldest, E is the newest. Durations are arranged so the three
// sort orders we care about all differ:
//   recent   = [E, D, C, B, A]
//   slowest  = [D, B, E, A, C]
//   errors   = none set, falls back to recency
// Enough traces that the list scrolls in a typical 40-row terminal, and
// enough duration spread that `slowest` order is meaningfully different
// from `recent`.
const specs: ReadonlyArray<{
	id: string
	op: string
	startMsAgo: number
	durMs: number
}> = [
	{ id: "a", op: "opA", startMsAgo: 1500, durMs: 10 },
	{ id: "b", op: "opB", startMsAgo: 1400, durMs: 50 },
	{ id: "c", op: "opC", startMsAgo: 1300, durMs: 5 },
	{ id: "d", op: "opD", startMsAgo: 1200, durMs: 100 },
	{ id: "e", op: "opE", startMsAgo: 1100, durMs: 25 },
	{ id: "f", op: "opF", startMsAgo: 1000, durMs: 75 },
	{ id: "g", op: "opG", startMsAgo: 900, durMs: 3 },
	{ id: "h", op: "opH", startMsAgo: 800, durMs: 200 },
	{ id: "i", op: "opI", startMsAgo: 700, durMs: 15 },
	{ id: "j", op: "opJ", startMsAgo: 600, durMs: 60 },
	{ id: "k", op: "opK", startMsAgo: 500, durMs: 1 },
	{ id: "l", op: "opL", startMsAgo: 400, durMs: 150 },
	{ id: "m", op: "opM", startMsAgo: 300, durMs: 40 },
	{ id: "n", op: "opN", startMsAgo: 200, durMs: 20 },
	{ id: "o", op: "opO", startMsAgo: 100, durMs: 7 },
]

const resourceSpans = specs.map((spec) => ({
	resource: {
		attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
	},
	scopeSpans: [
		{
			scope: { name: "s" },
			spans: [
				{
					traceId: spec.id.repeat(32),
					spanId: spec.id.repeat(16),
					name: spec.op,
					kind: 1,
					startTimeUnixNano: ms(-spec.startMsAgo),
					endTimeUnixNano: ms(-spec.startMsAgo + spec.durMs),
				},
			],
		},
	],
}))

await storeRuntime.runPromise(
	Effect.flatMap(TelemetryStore.asEffect(), (store) =>
		store.ingestTraces({ resourceSpans }),
	),
)
process.exit(0)
