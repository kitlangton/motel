import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { gzipSync } from "node:zlib"
import { createDaemonManager } from "./daemon.js"
import { MOTEL_SERVICE_ID } from "./registry.js"

const repoRoot = path.resolve(import.meta.dir, "..")

const randomPort = () => 29000 + Math.floor(Math.random() * 2000)

interface Harness {
	readonly runtimeDir: string
	readonly port: number
	readonly databasePath: string
	readonly manager: ReturnType<typeof createDaemonManager>
}

const makeHarness = (): Harness => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "motel-daemon-test-"))
	const port = randomPort()
	const databasePath = path.join(runtimeDir, "telemetry.sqlite")
	const manager = createDaemonManager({
		repoRoot,
		runtimeDir,
		databasePath,
		port,
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
	test("warm-start via registry is fast even when HTTP health is slow", async () => {
		// The failure mode we're preventing: a fully-healthy motel daemon
		// is alive for our cwd, but its /api/health response queues
		// behind heavy OTLP ingest traffic and takes >1s (seen on this
		// machine: /api/health taking 4s under real load). With an
		// HTTP-only probe the TUI would stall for seconds on every
		// launch; the registry-based fast path should close in <100ms.
		const harness = makeHarness()
		activeHarnesses.push(harness)

		// Scope the motel registry to the harness's runtime dir so we
		// neither read nor pollute the user's real ~/.local/state/motel.
		const registryRoot = path.join(harness.runtimeDir, "state")
		const originalXdg = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = registryRoot
		const registryInstancesDir = path.join(registryRoot, "motel", "instances")
		fs.mkdirSync(registryInstancesDir, { recursive: true })

		// Seed an entry that points at THIS test process. It's alive
		// (we're executing), so isAlive(pid) will report true — the
		// supervisor's fast path will adopt without ever issuing an
		// HTTP request.
		const entryPath = path.join(registryInstancesDir, `${process.pid}.json`)
		fs.writeFileSync(entryPath, JSON.stringify({
			pid: process.pid,
			url: `http://127.0.0.1:${harness.port}`,
			workdir: process.cwd(),
			startedAt: new Date().toISOString(),
			version: "0.0.0-test",
			databasePath: harness.databasePath,
		}), "utf8")

		// Park a real-but-slow listener on the port. If the supervisor
		// ever falls back to HTTP we'd wait out the 5s delay; a passing
		// test proves the fast path took over.
		const fake = startFakeDaemon({
			port: harness.port,
			databasePath: harness.databasePath,
			delayMs: 5_000,
		})

		try {
			const start = performance.now()
			const status = await Effect.runPromise(harness.manager.ensure)
			const elapsed = performance.now() - start
			expect(status.running).toBe(true)
			expect(status.managed).toBe(true)
			expect(status.pid).toBe(process.pid)
			// Generous — real-world is <10ms. Primarily guarding against
			// a future regression that silently reintroduces an HTTP probe
			// on the hot path.
			expect(elapsed).toBeLessThan(500)
		} finally {
			fake.stop()
			fs.rmSync(entryPath, { force: true })
			if (originalXdg === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = originalXdg
		}
	})

	test("adopts a slow-to-respond healthy daemon instead of spawning a duplicate", async () => {
		// Reproduces the `bun dev` EADDRINUSE flake. A real daemon is alive
		// and holds the port, but its /api/health response takes longer
		// than the supervisor's 750ms fetch timeout (e.g. the daemon is
		// backfilling FTS or the SQLite writer lock is held). The buggy
		// behaviour: supervisor thinks the port is free, spawns a fresh
		// daemon child, the child tries to bind() → EADDRINUSE → child
		// exits → supervisor throws "exited before becoming healthy".
		//
		// Correct behaviour: supervisor retries the health probe with a
		// longer budget before declaring the port empty, finds the
		// (slow) healthy motel on it, and adopts.
		const harness = makeHarness()
		activeHarnesses.push(harness)
		const fake = startFakeDaemon({
			port: harness.port,
			databasePath: harness.databasePath,
			delayMs: 1_500,
		})
		try {
			const status = await Effect.runPromise(harness.manager.ensure)
			expect(status.running).toBe(true)
			expect(status.managed).toBe(true)
			// PID belongs to the fake test server, not a newly-spawned daemon.
			expect(status.pid).toBe(process.pid)
		} finally {
			fake.stop()
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

	test("becomes healthy even if trace summary rebuild hits a write lock", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)

		const firstStart = await Effect.runPromise(harness.manager.ensure)
		expect(firstStart.running).toBe(true)
		await Effect.runPromise(harness.manager.stop)

		const locker = new Database(harness.databasePath)
		locker.exec("BEGIN IMMEDIATE")
		try {
			const startedAt = performance.now()
			const restarted = await Effect.runPromise(harness.manager.ensure)
			const elapsed = performance.now() - startedAt
			expect(restarted.running).toBe(true)
			expect(restarted.managed).toBe(true)
			expect(elapsed).toBeLessThan(10_000)
		} finally {
			locker.exec("ROLLBACK")
			locker.close()
		}
	}, 20_000)

	test("starts for the caller cwd even when motel is installed elsewhere", async () => {
		const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "motel-daemon-project-")))
		const databasePath = path.join(projectDir, ".motel-data", "telemetry.sqlite")
		let manager: ReturnType<typeof createDaemonManager> | null = null

		try {
			await withCwd(projectDir, async () => {
				manager = createDaemonManager({
					repoRoot,
					port: randomPort(),
				})

				const started = await Effect.runPromise(manager.ensure)
				expect(started.running).toBe(true)
				expect(started.managed).toBe(true)
				expect(started.workdir).toBe(projectDir)
				expect(started.sameWorkdir).toBe(true)
				expect(started.databasePath).toBe(databasePath)
				expect(started.logPath).toBe(path.join(projectDir, ".motel-data", "daemon.log"))

				const reused = await Effect.runPromise(manager.ensure)
				expect(reused.pid).toBe(started.pid)

				const stopped = await Effect.runPromise(manager.stop)
				expect(stopped.running).toBe(false)
			})
		} finally {
			await withCwd(projectDir, async () => {
				if (manager) {
					await Effect.runPromise(manager.stop).catch(() => undefined)
				}
			})
			fs.rmSync(projectDir, { recursive: true, force: true })
		}
	})
})

describe("OTLP ingest", () => {
	test("accepts gzip-compressed trace payloads", async () => {
		const harness = makeHarness()
		activeHarnesses.push(harness)
		await Effect.runPromise(harness.manager.ensure)

		const payload = {
			resourceSpans: [
				{
					resource: {
						attributes: [{ key: "service.name", value: { stringValue: "test" } }],
					},
					scopeSpans: [{ spans: [{ traceId: "abc", spanId: "def", name: "test" }] }],
				},
			],
		}

		const compressed = gzipSync(Buffer.from(JSON.stringify(payload)))

		const res = await fetch(`http://127.0.0.1:${harness.port}/v1/traces`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: compressed,
		})

		expect(res.status).toBe(200)
	})
})
