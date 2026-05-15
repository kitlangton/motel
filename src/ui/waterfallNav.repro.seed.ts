/**
 * Seed a deterministic trace into the SQLite store. Invoked as a child process
 * by the reproducer test so it gets a fresh module graph (config.ts caches the
 * DB path at module-load time).
 *
 * Usage:
 *   bun run src/ui/waterfallNav.repro.seed.ts
 *
 * Reads MOTEL_OTEL_DB_PATH from the environment.
 */

import { Effect } from "effect"
import { storeRuntime } from "../runtime.ts"
import { TelemetryStore } from "../services/TelemetryStore.ts"

const SERVICE_NAME = "waterfall-repro"
const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const ROOT = "1111111111111111"
const SIB_BEFORE = "2222222222222222"
const PARENT = "3333333333333333"
const CHILD_A = "aaaaaaaaaaaaaaaa"
const CHILD_B = "bbbbbbbbbbbbbbbb"
const CHILD_C = "cccccccccccccccc"
const CHILD_D = "dddddddddddddddd"
const CHILD_E = "eeeeeeeeeeeeeeee"
const CHILD_F = "ffffffffffffffff"
const SIB_AFTER = "4444444444444444"
const TAIL = "5555555555555555"
const TAIL_CHILD = "6666666666666666"
const TAIL_GRAND = "7777777777777777"

const nowNanos = BigInt(Date.now()) * 1_000_000n
const ms = (n: number) => String(nowNanos + BigInt(n) * 1_000_000n)

const span = (
	spanId: string,
	parent: string | null,
	name: string,
	startMs: number,
	endMs: number,
) => ({
	traceId: TRACE_ID,
	spanId,
	parentSpanId: parent ?? undefined,
	name,
	kind: 1,
	startTimeUnixNano: ms(startMs),
	endTimeUnixNano: ms(endMs),
})

const program = Effect.flatMap(TelemetryStore, (store) =>
	store.ingestTraces({
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: SERVICE_NAME } },
					],
				},
				scopeSpans: [
					{
						scope: { name: "test-scope" },
						spans: [
							span(ROOT, null, "root.op", 0, 100),
							span(SIB_BEFORE, ROOT, "siblingBefore.op", 1, 2),
							span(PARENT, ROOT, "parent.op", 5, 60),
							span(CHILD_A, PARENT, "childA.op", 6, 8),
							span(CHILD_B, PARENT, "childB.op", 10, 12),
							span(CHILD_C, PARENT, "childC.op", 14, 18),
							span(CHILD_D, PARENT, "childD.op", 20, 25),
							span(CHILD_E, PARENT, "childE.op", 28, 35),
							span(CHILD_F, PARENT, "childF.op", 40, 55),
							span(SIB_AFTER, ROOT, "siblingAfter.op", 65, 68),
							span(TAIL, ROOT, "tail.op", 70, 95),
							span(TAIL_CHILD, TAIL, "tailChild.op", 72, 90),
							span(TAIL_GRAND, TAIL_CHILD, "tailGrandchild.op", 75, 85),
						],
					},
				],
			},
		],
	}),
)

await storeRuntime.runPromise(program)
process.exit(0)
