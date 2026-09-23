import { dlopen, FFIType, ptr } from "bun:ffi"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import packageJson from "../package.json" with { type: "json" }

export const MOTEL_VERSION = packageJson.version
export const MOTEL_SERVICE_ID = "motel-local-server"

const stateHome = () =>
	process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state")

/**
 * The shared, machine-global motel state directory. Holds the SQLite
 * database, daemon log, daemon lock, and the per-pid instance registry.
 * One motel daemon serves every project on this machine — there is no
 * per-cwd state.
 */
export const motelStateDir = () => process.env.MOTEL_RUNTIME_DIR?.trim() || path.join(stateHome(), "motel")

export const registryDir = (runtimeDir = motelStateDir()) => path.join(runtimeDir, "instances")

export type RegistryEntry = {
	readonly pid: number
	readonly url: string
	readonly workdir: string
	readonly startedAt: string
	readonly version: string
	readonly instanceId?: string
	readonly processIdentity?: string
	/**
	 * The SQLite database path the daemon is serving. Optional because
	 * older daemon builds omit it; consumers should treat a missing
	 * value as "unknown" and fall back to whatever validation path
	 * they would have used before this field existed (typically an
	 * HTTP /api/health probe).
	 */
	readonly databasePath?: string
}

const entryPath = (pid: number, runtimeDir = motelStateDir()) => path.join(registryDir(runtimeDir), `${pid}.json`)

export const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

// Win32 BOOL is a 4-byte int, not a 1-byte C bool, so it is declared as i32.
const openKernel32 = () =>
	dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	}).symbols
let kernel32: ReturnType<typeof openKernel32> | undefined

/**
 * Windows has no `ps -o lstart`, so read the process creation time
 * (a FILETIME, 100ns ticks since 1601) straight from the kernel.
 * Spawning PowerShell instead would cost hundreds of milliseconds per
 * call, and this runs inside daemon polling loops.
 */
const windowsProcessStartTime = (pid: number): string | null => {
	kernel32 ??= openKernel32()
	const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
	if (!handle) return null
	try {
		const creation = new BigUint64Array(1)
		// GetProcessTimes requires exit/kernel/user outputs too; they are write-only, so one buffer serves all three.
		const ignored = new BigUint64Array(1)
		const ok = kernel32.GetProcessTimes(handle, ptr(creation), ptr(ignored), ptr(ignored), ptr(ignored))
		return ok !== 0 ? creation[0].toString() : null
	} finally {
		kernel32.CloseHandle(handle)
	}
}

export const processIdentity = (pid: number): string | null => {
	try {
		if (process.platform === "win32") return windowsProcessStartTime(pid)
		const result = Bun.spawnSync({ cmd: ["ps", "-p", String(pid), "-o", "lstart="] })
		if (result.exitCode !== 0) return null
		const identity = result.stdout.toString().trim()
		return identity.length > 0 ? identity : null
	} catch {
		return null
	}
}

export const isManagedDaemonProcess = (entry: RegistryEntry): boolean => {
	return Boolean(entry.instanceId && entry.processIdentity && processIdentity(entry.pid) === entry.processIdentity)
}

export const listAliveEntries = (runtimeDir = motelStateDir()): RegistryEntry[] => {
	const dir = registryDir(runtimeDir)
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
			if (entry.instanceId && entry.processIdentity ? isManagedDaemonProcess(entry) : isAlive(entry.pid)) {
				alive.push(entry)
			} else {
				try { fs.unlinkSync(full) } catch {}
			}
		} catch {
			try { fs.unlinkSync(full) } catch {}
		}
	}
	return alive
}

export const writeRegistryEntry = (entry: RegistryEntry, runtimeDir = motelStateDir()) => {
	fs.mkdirSync(registryDir(runtimeDir), { recursive: true })
	const file = entryPath(entry.pid, runtimeDir)
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
export const removeRegistryEntry = (pid: number, runtimeDir = motelStateDir()) => {
	try {
		fs.unlinkSync(entryPath(pid, runtimeDir))
	} catch {
		// Already gone — another cleanup path won the race, or the entry
		// was never written.
	}
}
