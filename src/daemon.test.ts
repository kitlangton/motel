import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import rootModule from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createDaemonManager } from "./daemon.js"
import { MOTEL_SERVICE_ID } from "./registry.js"

const repoRoot = path.resolve(import.meta.dir, "..")

const randomPort = () => 29000 + Math.floor(Math.random() * 2000)

const protobufRoot = rootModule as unknown as {
	readonly opentelemetry: {
		readonly proto: {
			readonly collector: {
				readonly logs: { readonly v1: { readonly ExportLogsServiceRequest: { encode: (message: unknown) => { finish: () => Uint8Array } } } }
			}
		}
	}
}

interface Harness {
	readonly runtimeDir: string
	readonly port: number
	readonly databasePath: string
	readonly manager: ReturnType<typeof createDaemonManager>
}

const makeHarness = (options: { readonly startTimeoutMs?: number; readonly gracefulStopTimeoutMs?: number; readonly forceStopTimeoutMs?: number } = {}): Harness => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "motel-daemon-test-"))
	const port = randomPort()
	const databasePath = path.join(runtimeDir, "telemetry.sqlite")
	const manager = createDaemonManager({
		repoRoot,
		runtimeDir,
		databasePath,
		port,
		...options,
	})
	return { runtimeDir, port, databasePath, manager }
}

const withCwd = async <A>(cwd: string, f: () => Promise<A>): Promise<A> => {
	const previous = process.cwd()
	process.chdir(cwd)
	try {
		return await f()
	} finally {
		process.chdir(previous)
	}
}

/**
 * Start a motel-shaped HTTP server on a test port that answers
 * /api/health with an arbitrary delay. Used to simulate a real daemon
 * that's alive + holding the port but currently slow — the exact
 * scenario that makes `bun dev` fail with EADDRINUSE when the
 * supervisor's health probe times out and it tries to spawn a
 * duplicate. Returns a stop() that releases the port.
 */
const startFakeDaemon = (opts: {
	readonly port: number
	readonly databasePath: string
	readonly delayMs: number
}) => {
	const startedAt = new Date().toISOString()
	const server = Bun.serve({
		port: opts.port,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url)
			if (url.pathname !== "/api/health") {
				return new Response("not found", { status: 404 })
			}
			if (opts.delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
			}
			return Response.json({
				ok: true,
				service: MOTEL_SERVICE_ID,
				databasePath: opts.databasePath,
				pid: process.pid,
				url: `http://127.0.0.1:${opts.port}`,
				workdir: process.cwd(),
				startedAt,
				version: "0.0.0-test",
			})
		},
	})
	return { stop: () => server.stop(true) }
}

const activeHarnesses: Array<ReturnType<typeof makeHarness>> = []

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await Effect.runPromise(harness.manager.stop).catch(() => undefined)
		fs.rmSync(harness.runtimeDir, { recursive: true, force: true })
	}
})

describe("daemon manager", () => {
	test("does not report a registry-only daemon as healthy", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)

		// Scope the motel registry to the harness's runtime dir so we
		// neither read nor pollute the user's real ~/.local/state/motel.
		const registryRoot = path.join(harness.runtimeDir, "state")
		const originalXdg = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = registryRoot
		const registryInstancesDir = path.join(harness.runtimeDir, "instances")
		fs.mkdirSync(registryInstancesDir, { recursive: true })

		// Seed an alive registry entry whose HTTP listener cannot answer
		// within the health deadline. PID liveness must not imply readiness.
		const entryPath = path.join(registryInstancesDir, `${process.pid}.json`)
		fs.writeFileSync(entryPath, JSON.stringify({
			pid: process.pid,
			url: `http://127.0.0.1:${harness.port}`,
			workdir: process.cwd(),
			startedAt: new Date().toISOString(),
			version: "0.0.0-test",
			databasePath: harness.databasePath,
		}), "utf8")

		const fake = startFakeDaemon({
			port: harness.port,
			databasePath: harness.databasePath,
			delayMs: 5_000,
		})

		try {
			const start = performance.now()
			const status = await Effect.runPromise(harness.manager.getStatus)
			const elapsed = performance.now() - start
			expect(status.running).toBe(false)
			expect(status.managed).toBe(false)
			expect(status.pid).toBe(process.pid)
			expect(elapsed).toBeGreaterThan(500)
			expect(elapsed).toBeLessThan(2_000)
		} finally {
			fake.stop()
			fs.rmSync(entryPath, { force: true })
			if (originalXdg === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = originalXdg
		}
	})

	test("refuses to adopt a responsive but unmanaged motel server", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		const fake = startFakeDaemon({
			port: harness.port,
			databasePath: harness.databasePath,
			delayMs: 1_500,
		})
		try {
			await expect(Effect.runPromise(harness.manager.ensure)).rejects.toThrow("not an identity-verified managed daemon")
		} finally {
			fake.stop()
		}
	})

	test("validates legacy registry entries before adopting a shared daemon", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		const stateRoot = path.join(harness.runtimeDir, "legacy-state")
		const originalXdg = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateRoot
		const instancesDir = path.join(harness.runtimeDir, "instances")
		fs.mkdirSync(instancesDir, { recursive: true })
		const entryPath = path.join(instancesDir, `${process.pid}.json`)
		fs.writeFileSync(entryPath, JSON.stringify({
			pid: process.pid,
			url: `http://127.0.0.1:${harness.port}`,
			workdir: "/tmp/legacy-project",
			startedAt: new Date().toISOString(),
			version: "0.0.0-legacy",
		}), "utf8")

		const fake = startFakeDaemon({
			port: harness.port,
			databasePath: path.join(harness.runtimeDir, "legacy.sqlite"),
			delayMs: 0,
		})

		try {
			const status = await Effect.runPromise(harness.manager.getStatus)
			expect(status.running).toBe(false)
			expect(status.managed).toBe(false)
			expect(status.reason).toContain("expected")
			expect(status.databasePath).toBe(path.join(harness.runtimeDir, "legacy.sqlite"))
		} finally {
			fake.stop()
			fs.rmSync(entryPath, { force: true })
			if (originalXdg === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = originalXdg
		}
	})

	test("starts once, reuses the same daemon, and stops cleanly", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)

		const initial = await Effect.runPromise(harness.manager.getStatus)
		expect(initial.running).toBe(false)

		const started = await Effect.runPromise(harness.manager.ensure)
		expect(started.running).toBe(true)
		expect(started.managed).toBe(true)
		expect(typeof started.pid).toBe("number")
		expect(started.databasePath).toBe(path.join(harness.runtimeDir, "telemetry.sqlite"))

		const reused = await Effect.runPromise(harness.manager.ensure)
		expect(reused.running).toBe(true)
		expect(reused.pid).toBe(started.pid)

		const stopped = await Effect.runPromise(harness.manager.stop)
		expect(stopped.running).toBe(false)

		const finalStatus = await Effect.runPromise(harness.manager.getStatus)
		expect(finalStatus.running).toBe(false)
	})

	test("health responds while ingest readiness waits for a write lock", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)

		const firstStart = await Effect.runPromise(harness.manager.ensure)
		expect(firstStart.running).toBe(true)
		await Effect.runPromise(harness.manager.stop)

		const locker = new Database(harness.databasePath)
		locker.exec("BEGIN IMMEDIATE")
		let settled = false
		const restarting = Effect.runPromise(harness.manager.ensure).then((status) => {
			settled = true
			return status
		})
		try {
			const startedAt = performance.now()
			let response: Response | null = null
			while (performance.now() - startedAt < 2_000 && !response?.ok) {
				response = await fetch(`http://127.0.0.1:${harness.port}/api/health`, { signal: AbortSignal.timeout(250) }).catch(() => null)
			}
			const elapsed = performance.now() - startedAt
			expect(response?.ok).toBe(true)
			expect(elapsed).toBeLessThan(2_000)
			expect(settled).toBe(false)
		} finally {
			locker.exec("ROLLBACK")
			locker.close()
		}
		const restarted = await restarting
		expect(restarted.running).toBe(true)
	}, 20_000)

	// Windows has no SIGSTOP, so there is no way to freeze the daemon into ignoring SIGTERM.
	test.skipIf(process.platform === "win32")("force-kills an identity-verified daemon that ignores graceful shutdown", async () => {
		const harness = makeHarness({ gracefulStopTimeoutMs: 250, forceStopTimeoutMs: 1_000 })
		activeHarnesses.push(harness)
		const started = await Effect.runPromise(harness.manager.ensure)
		if (started.pid === null) throw new Error("Expected managed daemon pid")
		process.kill(started.pid, "SIGSTOP")

		const startedAt = performance.now()
		const stopped = await Effect.runPromise(harness.manager.stop)
		expect(stopped.running).toBe(false)
		expect(performance.now() - startedAt).toBeLessThan(2_000)
	})

	test("does not write response logs for ingest endpoints", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		await Effect.runPromise(harness.manager.ensure)
		for (let index = 0; index < 10; index++) {
			await fetch(`http://127.0.0.1:${harness.port}/v1/logs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			})
		}
		await fetch(`http://127.0.0.1:${harness.port}/api/services`)
		await Bun.sleep(100)
		const log = fs.readFileSync(path.join(harness.runtimeDir, "daemon.log"), "utf8")
		expect(log).not.toContain("/v1/logs")
		expect(log).toContain("/api/services")
	})

	test("accepts OTLP protobuf log payloads", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		await Effect.runPromise(harness.manager.ensure)
		const payload = protobufRoot.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest.encode({
			resourceLogs: [{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "protobuf-fixture" } }] },
				scopeLogs: [{ logRecords: [{
					timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
					severityText: "INFO",
					body: { stringValue: "protobuf log" },
				}] }],
			}],
		}).finish()
		const response = await fetch(`http://127.0.0.1:${harness.port}/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: payload.buffer instanceof ArrayBuffer
				? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
				: Uint8Array.from(payload).buffer,
		})
		expect(response.status).toBe(200)
		await Bun.sleep(100)
		const probe = new Database(harness.databasePath, { readonly: true })
		try {
			const log = probe.query(`SELECT service_name, body FROM logs WHERE body = 'protobuf log'`).get() as { service_name: string; body: string } | null
			expect(log).toEqual({ service_name: "protobuf-fixture", body: "protobuf log" })
		} finally {
			probe.close()
		}
	})

	test("repeated ingest does not recursively create Motel telemetry", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		await Effect.runPromise(harness.manager.ensure)
		const nowNanos = String(BigInt(Date.now()) * 1_000_000n)
		const payload = JSON.stringify({
			resourceLogs: [{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "recursion-fixture" } }] },
				scopeLogs: [{ logRecords: [{ timeUnixNano: nowNanos, body: { stringValue: "one source log" } }] }],
			}],
		})
		for (let index = 0; index < 10; index++) {
			await fetch(`http://127.0.0.1:${harness.port}/v1/logs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: index === 0 ? payload : "{}",
			})
		}
		await Bun.sleep(250)
		const probe = new Database(harness.databasePath, { readonly: true })
		try {
			const total = (probe.query(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c
			const motel = (probe.query(`SELECT COUNT(*) AS c FROM logs WHERE service_name = 'motel-otel-tui'`).get() as { c: number }).c
			expect(total).toBe(1)
			expect(motel).toBe(0)
		} finally {
			probe.close()
		}
	})

	test("large retained schema maintenance cannot block health", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		await Effect.runPromise(harness.manager.ensure)
		await Effect.runPromise(harness.manager.stop)

		const fixture = new Database(harness.databasePath)
		fixture.exec(`DROP INDEX IF EXISTS idx_spans_service_time; DROP INDEX IF EXISTS idx_spans_trace_time; DROP INDEX IF EXISTS idx_spans_span_id; DROP INDEX IF EXISTS idx_spans_status_time; BEGIN`)
		const insert = fixture.query(`INSERT INTO spans VALUES (?, ?, NULL, 'large-fixture', NULL, 'op', NULL, ?, ?, 1, 'ok', ?, '{}', '[]')`)
		const blob = JSON.stringify({ blob: "x".repeat(512) })
		for (let index = 0; index < 50_000; index++) insert.run(`large-trace-${index}`, `large-span-${index}`, index, index + 1, blob)
		fixture.exec(`COMMIT; PRAGMA wal_checkpoint(TRUNCATE)`)
		fixture.close()

		const startedAt = performance.now()
		const restarting = Effect.runPromise(harness.manager.ensure)
		let response: Response | null = null
		while (performance.now() - startedAt < 1_500 && !response?.ok) {
			response = await fetch(`http://127.0.0.1:${harness.port}/api/health`, { signal: AbortSignal.timeout(200) }).catch(() => null)
		}
		expect(response?.ok).toBe(true)
		expect(performance.now() - startedAt).toBeLessThan(1_500)
		const restarted = await restarting
		expect(restarted.running).toBe(true)
	}, 30_000)

	test("an expensive retained-database query cannot block health", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		await Effect.runPromise(harness.manager.ensure)
		await Effect.runPromise(harness.manager.stop)

		const fixture = new Database(harness.databasePath)
		const insert = fixture.query(`INSERT INTO trace_summaries VALUES (?, 'query-pressure', 'op', ?, ?, 0, ?, 1, 0)`)
		const now = Date.now()
		fixture.exec("BEGIN")
		for (let index = 0; index < 500_000; index++) insert.run(`query-trace-${index}`, now - index, now - index + 1, index % 1_000)
		fixture.exec(`COMMIT; PRAGMA wal_checkpoint(TRUNCATE)`)
		fixture.close()
		await Effect.runPromise(harness.manager.ensure)

		const query = fetch(`http://127.0.0.1:${harness.port}/api/traces/stats?groupBy=service&agg=p95_duration&lookback=1440`)
		await Bun.sleep(5)
		const healthStartedAt = performance.now()
		const health = await fetch(`http://127.0.0.1:${harness.port}/api/health`, { signal: AbortSignal.timeout(250) })
		expect(health.ok).toBe(true)
		expect(performance.now() - healthStartedAt).toBeLessThan(250)
		expect((await query).ok).toBe(true)
	}, 30_000)

	test("configured size retention evicts oldest logs first", async () => {
		const previousMax = process.env.MOTEL_OTEL_MAX_DB_SIZE_MB
		const previousBatch = process.env.MOTEL_OTEL_RETENTION_LOG_BATCH
		const previousInterval = process.env.MOTEL_OTEL_RETENTION_INTERVAL_SECONDS
		process.env.MOTEL_OTEL_MAX_DB_SIZE_MB = "3"
		process.env.MOTEL_OTEL_RETENTION_LOG_BATCH = "2"
		process.env.MOTEL_OTEL_RETENTION_INTERVAL_SECONDS = "1"
		const harness = makeHarness()
		activeHarnesses.push(harness)
		try {
			await Effect.runPromise(harness.manager.ensure)
			const baseNanos = BigInt(Date.now()) * 1_000_000n
			for (let index = 0; index < 10; index++) {
				const payload = JSON.stringify({
					resourceLogs: [{
						resource: { attributes: [{ key: "service.name", value: { stringValue: "size-retention" } }] },
						scopeLogs: [{ logRecords: [{
							timeUnixNano: String(baseNanos + BigInt(index)),
							body: { stringValue: `retention-${index}-${String(index).repeat(300_000)}` },
						}] }],
					}],
				})
				await fetch(`http://127.0.0.1:${harness.port}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: payload })
			}

			let bodies: string[] = []
			const deadline = Date.now() + 6_000
			while (Date.now() < deadline) {
				const probe = new Database(harness.databasePath, { readonly: true })
				try {
					bodies = (probe.query(`SELECT body FROM logs WHERE service_name = 'size-retention' ORDER BY timestamp_ms ASC, id ASC`).all() as Array<{ body: string }>).map((row) => row.body)
				} finally {
					probe.close()
				}
				if (bodies.length < 10) break
				await Bun.sleep(200)
			}
			expect(bodies.length).toBeLessThan(10)
			expect(bodies.some((body) => body.startsWith("retention-0-"))).toBe(false)
			expect(bodies.some((body) => body.startsWith("retention-9-"))).toBe(true)
		} finally {
			await Effect.runPromise(harness.manager.stop).catch(() => undefined)
			if (previousMax === undefined) delete process.env.MOTEL_OTEL_MAX_DB_SIZE_MB
			else process.env.MOTEL_OTEL_MAX_DB_SIZE_MB = previousMax
			if (previousBatch === undefined) delete process.env.MOTEL_OTEL_RETENTION_LOG_BATCH
			else process.env.MOTEL_OTEL_RETENTION_LOG_BATCH = previousBatch
			if (previousInterval === undefined) delete process.env.MOTEL_OTEL_RETENTION_INTERVAL_SECONDS
			else process.env.MOTEL_OTEL_RETENTION_INTERVAL_SECONDS = previousInterval
		}
	}, 20_000)

	test("cleans a stale registry pid identity without signaling it", async () => {
		const harness = makeHarness({ gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 100 })
		activeHarnesses.push(harness)
		const sentinel = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], stdout: "ignore", stderr: "ignore" })
		await Bun.sleep(50)
		const instances = path.join(harness.runtimeDir, "instances")
		fs.mkdirSync(instances, { recursive: true })
		fs.writeFileSync(path.join(instances, `${sentinel.pid}.json`), JSON.stringify({
			pid: sentinel.pid,
			url: `http://127.0.0.1:${harness.port}`,
			workdir: process.cwd(),
			startedAt: new Date().toISOString(),
			version: "test",
			databasePath: harness.databasePath,
			instanceId: "stale-instance",
			processIdentity: "stale-process",
		}), "utf8")

		try {
			const stopped = await Effect.runPromise(harness.manager.stop)
			expect(stopped.running).toBe(false)
			expect(fs.existsSync(path.join(instances, `${sentinel.pid}.json`))).toBe(false)
			expect(sentinel.exitCode).toBeNull()
		} finally {
			sentinel.kill("SIGKILL")
			await sentinel.exited
		}
	})

	test("uses the shared global state dir regardless of caller cwd", async () => {
		const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "motel-daemon-project-")))
		const otherProjectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "motel-daemon-other-project-")))
		const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "motel-daemon-state-"))
		const expectedRuntimeDir = path.join(stateRoot, "motel")
		const expectedDatabasePath = path.join(expectedRuntimeDir, "telemetry.sqlite")
		const originalXdg = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateRoot
		let manager: ReturnType<typeof createDaemonManager> | null = null
		const port = randomPort()

		try {
			await withCwd(projectDir, async () => {
				manager = createDaemonManager({
					repoRoot,
					port,
				})

				const started = await Effect.runPromise(manager.ensure)
				expect(started.running).toBe(true)
				expect(started.managed).toBe(true)
				expect(started.workdir).toBe(projectDir)
				expect(started.sameWorkdir).toBe(true)
				expect(started.databasePath).toBe(expectedDatabasePath)
				expect(started.logPath).toBe(path.join(expectedRuntimeDir, "daemon.log"))
				expect(fs.existsSync(path.join(projectDir, ".motel-data"))).toBe(false)

				const reused = await Effect.runPromise(manager.ensure)
				expect(reused.pid).toBe(started.pid)

				await withCwd(otherProjectDir, async () => {
					const otherManager = createDaemonManager({
						repoRoot,
						port,
					})
					const adopted = await Effect.runPromise(otherManager.ensure)
					expect(adopted.running).toBe(true)
					expect(adopted.managed).toBe(true)
					expect(adopted.pid).toBe(started.pid)
					expect(adopted.workdir).toBe(projectDir)
					expect(adopted.sameWorkdir).toBe(false)
					expect(adopted.reason).toBe(null)
					const stopped = await Effect.runPromise(otherManager.stop)
					expect(stopped.running).toBe(false)
				})

				const stopped = await Effect.runPromise(manager.getStatus)
				expect(stopped.running).toBe(false)
			})
		} finally {
			await withCwd(projectDir, async () => {
				if (manager) {
					await Effect.runPromise(manager.stop).catch(() => undefined)
				}
			})
			fs.rmSync(projectDir, { recursive: true, force: true })
			fs.rmSync(otherProjectDir, { recursive: true, force: true })
			fs.rmSync(stateRoot, { recursive: true, force: true })
			if (originalXdg === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = originalXdg
		}
	})
})
