import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const MOTEL_VERSION = "0.1.0"
export const MOTEL_SERVICE_ID = "motel-local-server"

const stateHome = () =>
	process.env.XDG_STATE_HOME?.trim() ||
	path.join(os.homedir(), ".local", "state")

export const registryDir = () => path.join(stateHome(), "motel", "instances")

export type RegistryEntry = {
	readonly pid: number
	readonly url: string
	readonly workdir: string
	readonly startedAt: string
	readonly version: string
	/**
	 * The SQLite database path the daemon is serving. Optional because
	 * older daemon builds omit it; consumers should treat a missing
	 * value as "unknown" and fall back to whatever validation path
	 * they would have used before this field existed (typically an
	 * HTTP /api/health probe).
	 */
	readonly databasePath?: string
}

const entryPath = (pid: number) => path.join(registryDir(), `${pid}.json`)

export const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

export const listAliveEntries = (): RegistryEntry[] => {
	const dir = registryDir()
	let files: string[]
	try {
		files = fs.readdirSync(dir)
	} catch {
		return []
	}
	const alive: RegistryEntry[] = []
	for (const f of files) {
		if (!f.endsWith(".json")) continue
		const full = path.join(dir, f)
		try {
			const entry = JSON.parse(fs.readFileSync(full, "utf8")) as RegistryEntry
			if (isAlive(entry.pid)) {
				alive.push(entry)
			} else {
				try {
					fs.unlinkSync(full)
				} catch {}
			}
		} catch {
			try {
				fs.unlinkSync(full)
			} catch {}
		}
	}
	return alive
}

export const writeRegistryEntry = (entry: RegistryEntry) => {
	fs.mkdirSync(registryDir(), { recursive: true })
	const file = entryPath(entry.pid)
	fs.writeFileSync(file, JSON.stringify(entry, null, 2), "utf8")
}

/**
 * Remove this daemon's registry entry. Intended to be called from a
 * Layer release so the scope-managed server shutdown removes the entry
 * in the same finalizer chain that stops the socket. Historically this
 * was done via ad-hoc process-signal handlers installed here that ran
 * `process.exit(0)` — which races with the Effect runtime's own SIGINT
 * handling and short-circuits the Bun server's graceful stop. The
 * server (via BunRuntime.runMain) now owns signal handling; registry
 * cleanup rides along on scope release.
 */
export const removeRegistryEntry = (pid: number) => {
	try {
		fs.unlinkSync(entryPath(pid))
	} catch {
		// Already gone — another cleanup path won the race, or the entry
		// was never written.
	}
}
