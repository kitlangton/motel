import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import * as Effect from "effect/Effect"
import {
	isAlive,
	listAliveEntries,
	MOTEL_SERVICE_ID,
	MOTEL_VERSION,
	type RegistryEntry,
} from "./registry.js"

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dir, "..")
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 27686
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000
const LOCK_TIMEOUT_MS = 10_000
const START_POLL_INTERVAL_MS = 25
const POLL_INTERVAL_MS = 150
/** Fast probe used inside the waitForHealthy poll loop — we call it
 *  every POLL_INTERVAL_MS, so a generous budget would stall the loop. */
const HEALTH_FAST_TIMEOUT_MS = 750
/** Patient probe used on critical paths: the first getStatus() call
 *  in ensure(), and the final pre-throw check after a spawned child
 *  dies. A real daemon with a busy SQLite writer (FTS backfill, big
 *  DB) can easily take 1-2s to answer /api/health — if we declare
 *  the port empty at 750ms we'll spawn a duplicate and collide with
 *  EADDRINUSE. 3s is long enough to tolerate a slow healthy daemon
 *  and short enough that a truly-down daemon is still detected
 *  before START_TIMEOUT_MS fires. */
const HEALTH_PATIENT_TIMEOUT_MS = 3_000

type HealthShape = {
	readonly ok: boolean
	readonly service: string
	readonly databasePath: string
	readonly pid: number
	readonly url: string
	readonly workdir: string
	readonly startedAt: string
	readonly version: string
}

type LockShape = {
	readonly pid: number
	readonly createdAt: string
}

type DaemonConfig = {
	readonly repoRoot: string
	readonly serverEntry: string
	readonly workdir: string
	readonly runtimeDir: string
	readonly databasePath: string
	readonly logPath: string
	readonly lockPath: string
	readonly host: string
	readonly port: number
	readonly baseUrl: string
}

export type DaemonStatus = {
	readonly running: boolean
	readonly managed: boolean
	readonly service: string | null
	readonly pid: number | null
	readonly url: string
	readonly databasePath: string
	readonly workdir: string | null
	readonly startedAt: string | null
	readonly version: string | null
	readonly sameWorkdir: boolean
	readonly reason: string | null
	readonly logPath: string
	readonly lockPath: string
	readonly registryPid: number | null
}

export type DaemonManager = {
	readonly applyEnv: Effect.Effect<void>
	readonly getStatus: Effect.Effect<DaemonStatus, DaemonError>
	readonly ensure: Effect.Effect<DaemonStatus, DaemonError>
	readonly stop: Effect.Effect<DaemonStatus, DaemonError>
}

type DaemonOptions = {
	readonly repoRoot?: string
	readonly workdir?: string
	readonly runtimeDir?: string
	readonly databasePath?: string
	readonly host?: string
	readonly port?: number
}

export class DaemonError extends Error {
	readonly _tag = "DaemonError"
	constructor(message: string) {
		super(message)
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const resolveConfig = (options: DaemonOptions = {}): DaemonConfig => {
	const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT)
	const workdir = path.resolve(options.workdir ?? process.cwd())
	const runtimeDir = path.resolve(
		options.runtimeDir ?? path.join(workdir, ".motel-data"),
	)
	const databasePath = path.resolve(
		options.databasePath ?? path.join(runtimeDir, "telemetry.sqlite"),
	)
	const host = options.host ?? DEFAULT_HOST
	const port = options.port ?? DEFAULT_PORT
	return {
		repoRoot,
		serverEntry: path.join(repoRoot, "src/server.ts"),
		workdir,
		runtimeDir,
		databasePath,
		logPath: path.join(runtimeDir, "daemon.log"),
		lockPath: path.join(runtimeDir, "daemon.lock"),
		host,
		port,
		baseUrl: `http://${host}:${port}`,
	}
}

const workdirMatches = (targetWorkdir: string, daemonWorkdir: string) => {
	const normalizedTarget = targetWorkdir.endsWith(path.sep)
		? targetWorkdir
		: `${targetWorkdir}${path.sep}`
	const normalizedDaemon = daemonWorkdir.endsWith(path.sep)
		? daemonWorkdir
		: `${daemonWorkdir}${path.sep}`
	return (
		normalizedTarget === normalizedDaemon ||
		normalizedTarget.startsWith(normalizedDaemon)
	)
}

const pickByWorkdir = (
	entries: readonly RegistryEntry[],
	targetWorkdir: string,
) => {
	const withSep = targetWorkdir.endsWith(path.sep)
		? targetWorkdir
		: `${targetWorkdir}${path.sep}`
	return (
		entries
			.filter((entry) => {
				const workdir = entry.workdir.endsWith(path.sep)
					? entry.workdir
					: `${entry.workdir}${path.sep}`
				return withSep === workdir || withSep.startsWith(workdir)
			})
			.sort((a, b) => b.workdir.length - a.workdir.length)[0] ?? null
	)
}

const expectedEnv = (config: DaemonConfig) => ({
	MOTEL_OTEL_BASE_URL: config.baseUrl,
	MOTEL_OTEL_QUERY_URL: config.baseUrl,
	MOTEL_OTEL_HOST: config.host,
	MOTEL_OTEL_PORT: String(config.port),
	MOTEL_OTEL_DB_PATH: config.databasePath,
	MOTEL_OTEL_EXPORTER_URL: `${config.baseUrl}/v1/traces`,
	MOTEL_OTEL_LOGS_EXPORTER_URL: `${config.baseUrl}/v1/logs`,
})

export const createDaemonManager = (
	options: DaemonOptions = {},
): DaemonManager => {
	const config = resolveConfig(options)
	const mapError = (error: unknown) =>
		new DaemonError(error instanceof Error ? error.message : String(error))
	const readRegistryEntry = () =>
		pickByWorkdir(listAliveEntries(), config.workdir)

	const fetchHealth = async (
		timeoutMs: number = HEALTH_FAST_TIMEOUT_MS,
	): Promise<HealthShape | null> => {
		try {
			const response = await fetch(`${config.baseUrl}/api/health`, {
				signal: AbortSignal.timeout(timeoutMs),
			})
			if (!response.ok) return null
			return (await response.json()) as HealthShape
		} catch {
			return null
		}
	}

	const startupMarkers = [
		`Listening on ${config.baseUrl}`,
		`motel local telemetry server listening on ${config.baseUrl}`,
	]

	const readLogSince = async (offset: number) => {
		try {
			const raw = await fsp.readFile(config.logPath, "utf8")
			return raw.slice(offset)
		} catch {
			return ""
		}
	}

	const detectStartedFromLog = async (
		pid: number,
		offset: number,
	): Promise<HealthShape | null> => {
		if (!isAlive(pid)) return null
		const tail = await readLogSince(offset)
		if (!startupMarkers.some((marker) => tail.includes(marker))) return null
		return {
			ok: true,
			service: MOTEL_SERVICE_ID,
			databasePath: config.databasePath,
			pid,
			url: config.baseUrl,
			workdir: config.workdir,
			startedAt: new Date().toISOString(),
			version: MOTEL_VERSION,
		}
	}

	const describeManagedMismatch = (health: HealthShape) => {
		if (health.service !== MOTEL_SERVICE_ID) {
			return `Port ${config.port} is in use by ${health.service}, not ${MOTEL_SERVICE_ID}.`
		}
		if (!workdirMatches(config.workdir, health.workdir)) {
			return `Port ${config.port} is serving motel for ${health.workdir}, not ${config.workdir}.`
		}
		if (health.databasePath !== config.databasePath) {
			return `Port ${config.port} is serving motel with ${health.databasePath}, expected ${config.databasePath}.`
		}
		return null
	}

	/**
	 * Mismatch check against a registry entry — mirrors describeManagedMismatch
	 * but drives off the registry file instead of an HTTP health response.
	 * Used on the fast path in getStatus so warm-start doesn't need to wait
	 * on an HTTP round-trip that may queue behind heavy OTLP ingest.
	 *
	 * The service-id check is implicit: any entry living in the motel
	 * registry dir is by construction a motel daemon. databasePath is
	 * optional for back-compat with entries written by older builds;
	 * when absent we skip the DB check rather than refusing to adopt.
	 */
	const describeRegistryMismatch = (entry: RegistryEntry): string | null => {
		if (!workdirMatches(config.workdir, entry.workdir)) {
			return `Port ${config.port} is serving motel for ${entry.workdir}, not ${config.workdir}.`
		}
		if (entry.databasePath && entry.databasePath !== config.databasePath) {
			return `Port ${config.port} is serving motel with ${entry.databasePath}, expected ${config.databasePath}.`
		}
		return null
	}

	/**
	 * Build a DaemonStatus from a live registry entry. Returns null when
	 * there's no entry for our cwd, the registered pid isn't running, or
	 * the entry is for a differently-configured daemon (different port).
	 * This is the fast path: no HTTP, no event-loop round-trip, just a
	 * directory read and a process.kill(pid, 0) liveness probe.
	 */
	const getStatusFromRegistry = (): DaemonStatus | null => {
		const entry = readRegistryEntry()
		if (!entry) return null
		// Port discriminator: a motel registry shared across several
		// daemons (e.g., user running two instances on different
		// ports from the same workdir, or a test harness on a random
		// port) would otherwise have us adopt an unrelated daemon.
		// URL match is a fast, unambiguous identity check.
		if (entry.url !== config.baseUrl) return null
		const mismatch = describeRegistryMismatch(entry)
		return {
			running: mismatch === null,
			managed: mismatch === null,
			service: MOTEL_SERVICE_ID,
			pid: entry.pid,
			url: entry.url,
			databasePath: entry.databasePath ?? config.databasePath,
			workdir: entry.workdir,
			startedAt: entry.startedAt,
			version: entry.version,
			sameWorkdir: workdirMatches(config.workdir, entry.workdir),
			reason: mismatch,
			logPath: config.logPath,
			lockPath: config.lockPath,
			registryPid: entry.pid,
		}
	}

	const readLock = async (): Promise<LockShape | null> => {
		try {
			const raw = await fsp.readFile(config.lockPath, "utf8")
			return JSON.parse(raw) as LockShape
		} catch {
			return null
		}
	}

	const removeStaleLock = async () => {
		const current = await readLock()
		if (!current) {
			await fsp.rm(config.lockPath, { force: true })
			return true
		}
		if (isAlive(current.pid)) return false
		await fsp.rm(config.lockPath, { force: true })
		return true
	}

	const acquireStartupLock = async () => {
		const deadline = Date.now() + LOCK_TIMEOUT_MS
		await fsp.mkdir(config.runtimeDir, { recursive: true })

		while (Date.now() < deadline) {
			try {
				const handle = await fsp.open(config.lockPath, "wx")
				const contents = JSON.stringify({
					pid: process.pid,
					createdAt: new Date().toISOString(),
				} satisfies LockShape)
				await handle.writeFile(contents, "utf8")
				return {
					release: async () => {
						await handle.close().catch(() => undefined)
						await fsp
							.rm(config.lockPath, { force: true })
							.catch(() => undefined)
					},
				}
			} catch (error) {
				const errno = error as NodeJS.ErrnoException
				if (errno.code !== "EEXIST") throw error
				if (await removeStaleLock()) continue
				await sleep(POLL_INTERVAL_MS)
			}
		}

		throw new Error(
			`Timed out waiting for daemon startup lock at ${config.lockPath}`,
		)
	}

	const openLogFile = async () => {
		await fsp.mkdir(config.runtimeDir, { recursive: true })
		return fs.openSync(config.logPath, "a")
	}

	const waitForHealthy = async (pid: number, logOffset: number) => {
		const deadline = Date.now() + START_TIMEOUT_MS
		while (Date.now() < deadline) {
			const health = await fetchHealth()
			if (health) {
				const mismatch = describeManagedMismatch(health)
				if (!mismatch) return health
				throw new Error(mismatch)
			}
			const started = await detectStartedFromLog(pid, logOffset)
			if (started) return started
			if (!isAlive(pid)) {
				// The spawned child is gone. Before declaring failure,
				// do one patient probe: the child may have died from
				// EADDRINUSE because another healthy motel is alive on
				// the port but was answering /api/health too slowly for
				// our fast poll. If that's the case, adopt it.
				const patient = await fetchHealth(HEALTH_PATIENT_TIMEOUT_MS)
				if (patient) {
					const mismatch = describeManagedMismatch(patient)
					if (!mismatch) return patient
					throw new Error(mismatch)
				}
				throw new Error(
					`Daemon process ${pid} exited before becoming healthy. See ${config.logPath}.`,
				)
			}
			await sleep(START_POLL_INTERVAL_MS)
		}
		throw new Error(
			`Timed out waiting for daemon health at ${config.baseUrl}/api/health. See ${config.logPath}.`,
		)
	}

	const stopPid = async (pid: number) => {
		try {
			process.kill(pid, "SIGTERM")
		} catch (error) {
			const errno = error as NodeJS.ErrnoException
			if (errno.code !== "ESRCH") throw error
		}

		const deadline = Date.now() + STOP_TIMEOUT_MS
		while (Date.now() < deadline) {
			if (!isAlive(pid)) return
			const health = await fetchHealth()
			if (health && health.pid !== pid) return
			const registry = readRegistryEntry()
			if (!health && (!registry || registry.pid !== pid)) return
			await sleep(POLL_INTERVAL_MS)
		}

		throw new Error(`Timed out waiting for daemon ${pid} to stop.`)
	}

	const getStatus = async (
		timeoutMs: number = HEALTH_FAST_TIMEOUT_MS,
	): Promise<DaemonStatus> => {
		// Fast path: trust the local filesystem registry. When a motel
		// daemon started on this machine it wrote an entry for its pid
		// + cwd + databasePath; if that entry is still there and the pid
		// is alive, the daemon is almost certainly the one we want to
		// adopt. HTTP health is skipped because the daemon's health
		// endpoint can queue behind heavy OTLP ingest traffic, making
		// the probe unreliable exactly when the daemon is busy.
		const registryStatus = getStatusFromRegistry()
		if (registryStatus) return registryStatus

		// No local evidence → fall back to HTTP. Covers the edge cases
		// where: a motel daemon is running but was started before this
		// registry-first path shipped; OR the port is held by something
		// entirely unrelated (the mismatch check turns that into a
		// human-readable reason).
		const registry = readRegistryEntry()
		const health = await fetchHealth(timeoutMs)
		if (!health) {
			return {
				running: false,
				managed: false,
				service: null,
				pid: registry?.pid ?? null,
				url: config.baseUrl,
				databasePath: config.databasePath,
				workdir: registry?.workdir ?? null,
				startedAt: registry?.startedAt ?? null,
				version: registry?.version ?? null,
				sameWorkdir: registry
					? workdirMatches(config.workdir, registry.workdir)
					: false,
				reason: registry
					? "Registry entry exists but daemon is not healthy."
					: null,
				logPath: config.logPath,
				lockPath: config.lockPath,
				registryPid: registry?.pid ?? null,
			}
		}

		const mismatch = describeManagedMismatch(health)
		return {
			running: mismatch === null,
			managed: mismatch === null,
			service: health.service,
			pid: health.pid,
			url: health.url,
			databasePath: health.databasePath,
			workdir: health.workdir,
			startedAt: health.startedAt,
			version: health.version,
			sameWorkdir: workdirMatches(config.workdir, health.workdir),
			reason: mismatch,
			logPath: config.logPath,
			lockPath: config.lockPath,
			registryPid: registry?.pid ?? null,
		}
	}

	const ensure = async (): Promise<DaemonStatus> => {
		// Use the patient timeout for the initial probe — this is the
		// critical "is there already a daemon here?" check. A false
		// negative here drops us into the spawn path and collides with
		// any slow-but-healthy daemon sitting on the port.
		const existing = await getStatus(HEALTH_PATIENT_TIMEOUT_MS)
		if (existing.managed && existing.running) return existing
		if (existing.service !== null && existing.reason) {
			throw new Error(existing.reason)
		}

		const lock = await acquireStartupLock()
		let spawnedPid: number | null = null
		try {
			// Same reasoning for the post-lock re-check: another ensure()
			// may have spawned a daemon between our first probe and the
			// lock grant, and its initial health response can be slow
			// while the runtime warms up.
			const rechecked = await getStatus(HEALTH_PATIENT_TIMEOUT_MS)
			if (rechecked.managed && rechecked.running) return rechecked
			if (rechecked.service !== null && rechecked.reason) {
				throw new Error(rechecked.reason)
			}

			const logFd = await openLogFile()
			const logOffset = fs.fstatSync(logFd).size
			try {
				const proc = Bun.spawn({
					cmd: [process.execPath, "run", config.serverEntry],
					cwd: config.workdir,
					detached: true,
					env: {
						...process.env,
						...expectedEnv(config),
					},
					stdio: ["ignore", logFd, logFd],
				})
				spawnedPid = proc.pid
				proc.unref()
			} finally {
				fs.closeSync(logFd)
			}

			if (spawnedPid === null) {
				throw new Error("Daemon failed to spawn.")
			}

			const health = await waitForHealthy(spawnedPid, logOffset)
			return {
				running: true,
				managed: true,
				service: health.service,
				pid: health.pid,
				url: health.url,
				databasePath: health.databasePath,
				workdir: health.workdir,
				startedAt: health.startedAt,
				version: health.version,
				sameWorkdir: workdirMatches(config.workdir, health.workdir),
				reason: null,
				logPath: config.logPath,
				lockPath: config.lockPath,
				registryPid: health.pid,
			}
		} catch (error) {
			if (spawnedPid !== null) {
				await stopPid(spawnedPid).catch(() => undefined)
			}
			throw error
		} finally {
			await lock.release()
		}
	}

	const stop = async (): Promise<DaemonStatus> => {
		const status = await getStatus()
		if (status.pid === null) return status
		if (!status.sameWorkdir) {
			throw new Error(`Refusing to stop motel owned by ${status.workdir}.`)
		}
		if (status.service !== null && status.service !== MOTEL_SERVICE_ID) {
			throw new Error(
				`Refusing to stop non-motel service ${status.service} on ${status.url}.`,
			)
		}
		await stopPid(status.pid)
		return await getStatus()
	}

	return {
		applyEnv: Effect.sync(() => {
			for (const [key, value] of Object.entries(expectedEnv(config))) {
				process.env[key] = value
			}
		}),
		getStatus: Effect.tryPromise({
			// Wrapped so Effect.tryPromise only sees the no-arg call
			// signature — the optional timeoutMs parameter is an
			// internal detail used by ensure()'s critical probes.
			try: () => getStatus(),
			catch: mapError,
		}).pipe(Effect.withSpan("DaemonManager.getStatus")),
		ensure: Effect.tryPromise({
			try: ensure,
			catch: mapError,
		}).pipe(Effect.withSpan("DaemonManager.ensure")),
		stop: Effect.tryPromise({
			try: stop,
			catch: mapError,
		}).pipe(Effect.withSpan("DaemonManager.stop")),
	}
}

export const applyManagedDaemonEnv = Effect.suspend(
	() => createDaemonManager().applyEnv,
)
export const getManagedDaemonStatus = Effect.suspend(
	() => createDaemonManager().getStatus,
)
export const ensureManagedDaemon = Effect.suspend(
	() => createDaemonManager().ensure,
)
export const stopManagedDaemon = Effect.suspend(
	() => createDaemonManager().stop,
)
