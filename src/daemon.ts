import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { listAliveEntries, MOTEL_SERVICE_ID, type RegistryEntry, isAlive } from "./registry.js"

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dir, "..")
const DEFAULT_RUNTIME_DIR = path.join(DEFAULT_REPO_ROOT, ".motel-data")
const DEFAULT_DATABASE_PATH = path.join(DEFAULT_RUNTIME_DIR, "telemetry.sqlite")
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 27686
const START_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 10_000
const LOCK_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 150

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
	const runtimeDir = path.resolve(options.runtimeDir ?? DEFAULT_RUNTIME_DIR)
	const databasePath = path.resolve(options.databasePath ?? path.join(runtimeDir, "telemetry.sqlite"))
	const host = options.host ?? DEFAULT_HOST
	const port = options.port ?? DEFAULT_PORT
	return {
		repoRoot,
		runtimeDir,
		databasePath,
		logPath: path.join(runtimeDir, "daemon.log"),
		lockPath: path.join(runtimeDir, "daemon.lock"),
		host,
		port,
		baseUrl: `http://${host}:${port}`,
	}
}

const cwdMatches = (workdir: string) => {
	const cwd = process.cwd()
	const normalizedCwd = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`
	const normalizedWorkdir = workdir.endsWith(path.sep) ? workdir : `${workdir}${path.sep}`
	return normalizedCwd === normalizedWorkdir || normalizedCwd.startsWith(normalizedWorkdir)
}

const pickByCwd = (entries: readonly RegistryEntry[]) => {
	const cwd = process.cwd()
	const withSep = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`
	return entries
		.filter((entry) => {
			const workdir = entry.workdir.endsWith(path.sep) ? entry.workdir : `${entry.workdir}${path.sep}`
			return withSep === workdir || withSep.startsWith(workdir)
		})
		.sort((a, b) => b.workdir.length - a.workdir.length)[0] ?? null
}

const readRegistryEntry = () => pickByCwd(listAliveEntries())

const expectedEnv = (config: DaemonConfig) => ({
	MOTEL_OTEL_BASE_URL: config.baseUrl,
	MOTEL_OTEL_QUERY_URL: config.baseUrl,
	MOTEL_OTEL_HOST: config.host,
	MOTEL_OTEL_PORT: String(config.port),
	MOTEL_OTEL_DB_PATH: config.databasePath,
	MOTEL_OTEL_EXPORTER_URL: `${config.baseUrl}/v1/traces`,
	MOTEL_OTEL_LOGS_EXPORTER_URL: `${config.baseUrl}/v1/logs`,
})

export const createDaemonManager = (options: DaemonOptions = {}): DaemonManager => {
	const config = resolveConfig(options)
	const mapError = (error: unknown) => new DaemonError(error instanceof Error ? error.message : String(error))

	const fetchHealth = async (): Promise<HealthShape | null> => {
		try {
			const response = await fetch(`${config.baseUrl}/api/health`, { signal: AbortSignal.timeout(750) })
			if (!response.ok) return null
			return await response.json() as HealthShape
		} catch {
			return null
		}
	}

	const describeManagedMismatch = (health: HealthShape) => {
		if (health.service !== MOTEL_SERVICE_ID) {
			return `Port ${config.port} is in use by ${health.service}, not ${MOTEL_SERVICE_ID}.`
		}
		if (!cwdMatches(health.workdir)) {
			return `Port ${config.port} is serving motel for ${health.workdir}, not ${process.cwd()}.`
		}
		if (health.databasePath !== config.databasePath) {
			return `Port ${config.port} is serving motel with ${health.databasePath}, expected ${config.databasePath}.`
		}
		return null
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
				const contents = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies LockShape)
				await handle.writeFile(contents, "utf8")
				return {
					release: async () => {
						await handle.close().catch(() => undefined)
						await fsp.rm(config.lockPath, { force: true }).catch(() => undefined)
					},
				}
			} catch (error) {
				const errno = error as NodeJS.ErrnoException
				if (errno.code !== "EEXIST") throw error
				if (await removeStaleLock()) continue
				await sleep(POLL_INTERVAL_MS)
			}
		}

		throw new Error(`Timed out waiting for daemon startup lock at ${config.lockPath}`)
	}

	const openLogFile = async () => {
		await fsp.mkdir(config.runtimeDir, { recursive: true })
		return fs.openSync(config.logPath, "a")
	}

	const waitForHealthy = async (pid: number) => {
		const deadline = Date.now() + START_TIMEOUT_MS
		while (Date.now() < deadline) {
			const health = await fetchHealth()
			if (health) {
				const mismatch = describeManagedMismatch(health)
				if (!mismatch) return health
				throw new Error(mismatch)
			}
			if (!isAlive(pid)) {
				throw new Error(`Daemon process ${pid} exited before becoming healthy. See ${config.logPath}.`)
			}
			await sleep(POLL_INTERVAL_MS)
		}
		throw new Error(`Timed out waiting for daemon health at ${config.baseUrl}/api/health. See ${config.logPath}.`)
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
			if (!health || health.pid !== pid) return
			await sleep(POLL_INTERVAL_MS)
		}

		throw new Error(`Timed out waiting for daemon ${pid} to stop.`)
	}

	const getStatus = async (): Promise<DaemonStatus> => {
		const registry = readRegistryEntry()
		const health = await fetchHealth()
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
				sameWorkdir: registry ? cwdMatches(registry.workdir) : false,
				reason: registry ? "Registry entry exists but daemon is not healthy." : null,
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
			sameWorkdir: cwdMatches(health.workdir),
			reason: mismatch,
			logPath: config.logPath,
			lockPath: config.lockPath,
			registryPid: registry?.pid ?? null,
		}
	}

	const ensure = async (): Promise<DaemonStatus> => {
		const existing = await getStatus()
		if (existing.managed && existing.running) return existing
		if (existing.service !== null && existing.reason) {
			throw new Error(existing.reason)
		}

		const lock = await acquireStartupLock()
		let spawnedPid: number | null = null
		try {
			const rechecked = await getStatus()
			if (rechecked.managed && rechecked.running) return rechecked
			if (rechecked.service !== null && rechecked.reason) {
				throw new Error(rechecked.reason)
			}

			const logFd = await openLogFile()
			try {
				const proc = Bun.spawn({
					cmd: [process.execPath, "run", "src/server.ts"],
					cwd: config.repoRoot,
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

			const health = await waitForHealthy(spawnedPid)
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
				sameWorkdir: cwdMatches(health.workdir),
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
			throw new Error(`Refusing to stop non-motel service ${status.service} on ${status.url}.`)
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
		getStatus: Effect.fn("DaemonManager.getStatus")(() =>
			Effect.tryPromise({
				try: getStatus,
				catch: mapError,
			}),
		)(),
		ensure: Effect.fn("DaemonManager.ensure")(() =>
			Effect.tryPromise({
				try: ensure,
				catch: mapError,
			}),
		)(),
		stop: Effect.fn("DaemonManager.stop")(() =>
			Effect.tryPromise({
				try: stop,
				catch: mapError,
			}),
		)(),
	}
}

const defaultManager = createDaemonManager()

export const applyManagedDaemonEnv = defaultManager.applyEnv
export const getManagedDaemonStatus = defaultManager.getStatus
export const ensureManagedDaemon = defaultManager.ensure
export const stopManagedDaemon = defaultManager.stop
