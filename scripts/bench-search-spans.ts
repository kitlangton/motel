import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, References } from "effect"
import type { OtlpTraceExportRequest } from "../src/otlp.js"

type Sample = {
	readonly elapsedMs: number
	readonly resultCount: number
}

type LoadedRuntime = Awaited<ReturnType<typeof loadRuntime>>

const parseNumberArg = (name: string, fallback: number) => {
	const index = process.argv.indexOf(name)
	if (index === -1) return fallback
	const value = Number(process.argv[index + 1])
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

const median = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!
}

const mad = (values: readonly number[]) => {
	const center = median(values)
	const deviations = values.map((value) => Math.abs(value - center))
	return median(deviations)
}

const traces = parseNumberArg("--traces", 250)
const spansPerTrace = parseNumberArg("--spans-per-trace", 48)
const warmups = parseNumberArg("--warmups", 1)
const iterations = parseNumberArg("--iterations", 7)
const batchSize = parseNumberArg("--batch-size", 25)

const oneSecondNanos = 1_000_000_000n

const makeTraceBatch = (startTrace: number, traceCount: number, startedAtNanos: bigint): OtlpTraceExportRequest => ({
	resourceSpans: [
		{
			resource: {
				attributes: [
					{ key: "service.name", value: { stringValue: "bench-api" } },
					{ key: "deployment.environment.name", value: { stringValue: "bench" } },
				],
			},
			scopeSpans: [
				{
					scope: { name: "bench" },
					spans: Array.from({ length: traceCount }, (_, traceOffset) => {
						const traceIndex = startTrace + traceOffset
						const traceId = `bench-trace-${traceIndex}`
						const traceStart = startedAtNanos + BigInt(traceIndex * spansPerTrace) * oneSecondNanos

						const spans = [
							{
								traceId,
								spanId: `${traceId}-root`,
								name: "request.root",
								kind: 2,
								startTimeUnixNano: String(traceStart),
								endTimeUnixNano: String(traceStart + BigInt(spansPerTrace) * oneSecondNanos),
								attributes: [
									{ key: "trace.kind", value: { stringValue: "bench" } },
								],
							},
						]

						for (let spanIndex = 1; spanIndex < spansPerTrace; spanIndex++) {
							const spanId = `${traceId}-span-${spanIndex}`
							const parentSpanId = spanIndex <= 6 ? `${traceId}-${spanIndex === 1 ? "root" : `span-${spanIndex - 1}`}` : `${traceId}-root`
							const isTarget = spanIndex === 7
							spans.push({
								traceId,
								spanId,
								parentSpanId,
								name: isTarget ? "search.target" : `worker.step.${spanIndex % 5}`,
								kind: 1,
								startTimeUnixNano: String(traceStart + BigInt(spanIndex) * oneSecondNanos),
								endTimeUnixNano: String(traceStart + BigInt(spanIndex + 1) * oneSecondNanos),
								attributes: [
									{ key: "tenant", value: { stringValue: `tenant-${traceIndex % 10}` } },
									{ key: "workflow", value: { stringValue: `workflow-${traceIndex % 4}` } },
									...(isTarget ? [{ key: "target", value: { stringValue: "yes" } }] : []),
								],
							})
						}

						return spans
					}).flat(),
				},
			],
		},
	],
})

const loadRuntime = async (dbPath: string) => {
	process.env.MOTEL_OTEL_DB_PATH = dbPath
	process.env.MOTEL_OTEL_RETENTION_HOURS = "24"
	const suffix = `?bench=${Date.now()}-${Math.random().toString(36).slice(2)}`
	const runtime = await import(`../src/runtime.ts${suffix}`)
	const storeModule = await import(`../src/services/TelemetryStore.ts${suffix}`)
	const traceModule = await import(`../src/services/TraceQueryService.ts${suffix}`)
	return {
		storeRuntime: runtime.storeRuntime,
		queryRuntime: runtime.queryRuntime,
		TelemetryStore: storeModule.TelemetryStore,
		TraceQueryService: traceModule.TraceQueryService,
	}
}

const seedStore = async (
	storeRuntime: Awaited<ReturnType<typeof loadRuntime>>["storeRuntime"],
	TelemetryStore: Awaited<ReturnType<typeof loadRuntime>>["TelemetryStore"],
) => {
	const startedAtNanos = BigInt(Date.now() - traces * spansPerTrace * 10) * 1_000_000n
	for (let start = 0; start < traces; start += batchSize) {
		const traceCount = Math.min(batchSize, traces - start)
		const payload = makeTraceBatch(start, traceCount, startedAtNanos)
		await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore, (store) => store.ingestTraces(payload)).pipe(
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		)
	}
}

const runOne = async (loaded: LoadedRuntime): Promise<Sample> => {
	const startedAt = performance.now()
	const result = await loaded.queryRuntime.runPromise(
		Effect.flatMap(loaded.TraceQueryService, (store) =>
			store.searchSpans({
				serviceName: "bench-api",
				operation: "search.target",
				parentOperation: "request.root",
				limit: 100,
			}),
		).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
	)

	return {
		elapsedMs: performance.now() - startedAt,
		resultCount: result.length,
	}
}

const summarize = (label: string, values: readonly number[]) => {
	const bestMs = Math.min(...values)
	const worstMs = Math.max(...values)
	const medianMs = median(values)
	const meanMs = mean(values)
	const madMs = mad(values)

	console.log(`${label}:`)
	console.log(`  median ${medianMs.toFixed(1)}ms`)
	console.log(`  mean   ${meanMs.toFixed(1)}ms`)
	console.log(`  best   ${bestMs.toFixed(1)}ms`)
	console.log(`  worst  ${worstMs.toFixed(1)}ms`)
	console.log(`  mad    ${madMs.toFixed(1)}ms`)

	return { bestMs, worstMs, medianMs, meanMs, madMs }
}

const main = async () => {
	const totalRuns = warmups + iterations
	const samples: Sample[] = []
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "motel-bench-search-spans-"))
	const dbPath = path.join(runtimeDir, "telemetry.sqlite")

	try {
		const loaded = await loadRuntime(dbPath)
		try {
			console.log(`Seeding searchSpans benchmark (${traces} traces, ${spansPerTrace} spans/trace)...`)
			await seedStore(loaded.storeRuntime, loaded.TelemetryStore)

			console.log(`Benchmarking searchSpans (${warmups} warmup, ${iterations} measured)`)
			for (let index = 0; index < totalRuns; index++) {
				const sample = await runOne(loaded)
				samples.push(sample)
				const phase = index < warmups ? "warmup" : `run ${index - warmups + 1}`
				console.log(`${phase}: ${sample.elapsedMs.toFixed(1)}ms (${sample.resultCount} results)`)
			}

			const measured = samples.slice(warmups)
			const elapsed = summarize("searchSpans", measured.map((sample) => sample.elapsedMs))
			const resultCount = measured[0]?.resultCount ?? 0

			console.log("")
			console.log(`METRIC search_spans_ms=${elapsed.medianMs.toFixed(3)}`)
			console.log(`METRIC search_spans_mad_ms=${elapsed.madMs.toFixed(3)}`)
			console.log(`METRIC search_spans_results=${resultCount}`)
			console.log(`METRIC search_spans_seeded_traces=${traces}`)
			console.log(`METRIC search_spans_seeded_spans_per_trace=${spansPerTrace}`)
		} finally {
			await loaded.storeRuntime.dispose().catch(() => undefined)
			await loaded.queryRuntime.dispose().catch(() => undefined)
		}
	} finally {
		fs.rmSync(runtimeDir, { recursive: true, force: true })
	}
}

await main()
