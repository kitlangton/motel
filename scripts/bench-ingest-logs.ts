import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, ManagedRuntime, References } from "effect"
import type { OtlpLogExportRequest } from "../src/otlp.js"

type Sample = {
	readonly elapsedMs: number
	readonly insertedLogs: number
}

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

const logs = parseNumberArg("--logs", 8000)
const warmups = parseNumberArg("--warmups", 1)
const iterations = parseNumberArg("--iterations", 5)
const childRun = process.argv.includes("--child")
const childSeed = parseNumberArg("--seed", 0)

const oneMillisecondNanos = 1_000_000n

const makePayload = (seed: number): OtlpLogExportRequest => {
	const startedAtNanos = BigInt(Date.now() + seed * logs * 10) * 1_000_000n
	return {
		resourceLogs: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "bench-api" } },
						{ key: "deployment.environment.name", value: { stringValue: "bench" } },
						{ key: "host.name", value: { stringValue: "bench-host" } },
					],
				},
				scopeLogs: [
					{
						scope: { name: "bench" },
						logRecords: Array.from({ length: logs }, (_, index) => {
							const traceId = `bench-trace-${seed}-${Math.floor(index / 8)}`
							const spanId = `${traceId}-span-${index % 8}`
							return {
								timeUnixNano: String(startedAtNanos + BigInt(index) * oneMillisecondNanos),
								severityText: index % 11 === 0 ? "ERROR" : "INFO",
								traceId,
								spanId,
								body: {
									stringValue: index % 9 === 0
										? `log ${index} search target with payload text`
										: `log ${index} regular payload body`,
								},
								attributes: [
									{ key: "tenant", value: { stringValue: `tenant-${index % 10}` } },
									{ key: "tool", value: { stringValue: index % 9 === 0 ? "search" : "none" } },
									{ key: "sessionID", value: { stringValue: `session-${Math.floor(index / 8)}` } },
								],
							}
						}),
					},
				],
			},
		],
	}
}

const loadRuntime = async (dbPath: string) => {
	process.env.MOTEL_OTEL_DB_PATH = dbPath
	process.env.MOTEL_OTEL_RETENTION_HOURS = "24"
	const suffix = `?bench=${Date.now()}-${Math.random().toString(36).slice(2)}`
	const storeModule = await import(`../src/services/TelemetryStore.ts${suffix}`)
	return {
		storeRuntime: ManagedRuntime.make(storeModule.TelemetryStoreWorkerLive),
		TelemetryStore: storeModule.TelemetryStore,
	}
}

const runOne = async (seed: number): Promise<Sample> => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "motel-bench-ingest-logs-"))
	const dbPath = path.join(runtimeDir, "telemetry.sqlite")

	try {
		const loaded = await loadRuntime(dbPath)
		try {
			const payload = makePayload(seed)
			const startedAt = performance.now()
			const result = await loaded.storeRuntime.runPromise(
				Effect.flatMap(loaded.TelemetryStore, (store) => store.ingestLogs(payload)).pipe(
					Effect.provideService(References.MinimumLogLevel, "None"),
				),
			)
			return {
				elapsedMs: performance.now() - startedAt,
				insertedLogs: result.insertedLogs,
			}
		} finally {
			await loaded.storeRuntime.dispose().catch(() => undefined)
		}
	} finally {
		fs.rmSync(runtimeDir, { recursive: true, force: true })
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

const repoRoot = path.resolve(import.meta.dir, "..")
const childMetricPattern = /^CHILD\s+(\d+(?:\.\d+)?)\s+(\d+)$/m

const runChild = async (seed: number): Promise<Sample> => {
	const proc = Bun.spawn({
		cmd: [
			process.execPath,
			"run",
			path.join(repoRoot, "scripts/bench-ingest-logs.ts"),
			"--child",
			"--seed",
			String(seed),
			"--logs",
			String(logs),
		],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])

	if (exitCode !== 0) {
		throw new Error(`Ingest logs child run failed (${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
	}

	const match = stdout.match(childMetricPattern)
	if (!match) {
		throw new Error(`Could not parse child ingest log metrics.\nstdout:\n${stdout}\nstderr:\n${stderr}`)
	}

	return {
		elapsedMs: Number(match[1]),
		insertedLogs: Number(match[2]),
	}
}

const main = async () => {
	if (childRun) {
		const sample = await runOne(childSeed)
		console.log(`CHILD ${sample.elapsedMs.toFixed(3)} ${sample.insertedLogs}`)
		return
	}

	const totalRuns = warmups + iterations
	const samples: Sample[] = []

	console.log(`Benchmarking ingestLogs (${logs} logs, ${warmups} warmup, ${iterations} measured)`)
	for (let index = 0; index < totalRuns; index++) {
		const sample = await runChild(index)
		samples.push(sample)
		const phase = index < warmups ? "warmup" : `run ${index - warmups + 1}`
		console.log(`${phase}: ${sample.elapsedMs.toFixed(1)}ms (${sample.insertedLogs} logs)`)
	}

	const measured = samples.slice(warmups)
	const elapsed = summarize("ingestLogs", measured.map((sample) => sample.elapsedMs))
	const insertedLogs = measured[0]?.insertedLogs ?? 0

	console.log("")
	console.log(`METRIC ingest_logs_ms=${elapsed.medianMs.toFixed(3)}`)
	console.log(`METRIC ingest_logs_mad_ms=${elapsed.madMs.toFixed(3)}`)
	console.log(`METRIC ingest_logs_inserted_logs=${insertedLogs}`)
	console.log(`METRIC ingest_logs_seeded_logs=${logs}`)
}

await main()
