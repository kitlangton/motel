/**
 * End-to-end reproducer for waterfall underfilling the trace-details pane.
 *
 * Strategy:
 * 1. Seed a deterministic trace into a fresh SQLite database.
 * 2. Launch the motel TUI under tuistory in narrow mode so trace details take
 *    the full screen width.
 * 3. Drill into the trace details view.
 * 4. Assert the root waterfall row reaches the right-side duration column
 *    instead of stopping several cells early.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TUISTORY_BIN = "tuistory"
const SESSION = `motel-trace-width-${Date.now()}`

const hasTuistory = async () => {
	try {
		const proc = Bun.spawn({
			cmd: ["which", TUISTORY_BIN],
			stdout: "pipe",
			stderr: "ignore",
		})
		return (await proc.exited) === 0
	} catch {
		return false
	}
}

const tui = async (args: readonly string[]) => {
	const proc = Bun.spawn({
		cmd: [TUISTORY_BIN, ...args],
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	return { code: await proc.exited, stdout, stderr }
}

const snapshot = async () =>
	(await tui(["snapshot", "--session", SESSION])).stdout

const press = async (...keys: string[]) => {
	await tui(["press", "--session", SESSION, ...keys])
	await Bun.sleep(120)
}

const dividerWidth = (snap: string) =>
	snap.split("\n").find((line) => line.startsWith("─"))?.length ?? 0

const rootWaterfallRow = (snap: string) =>
	snap
		.split("\n")
		.find(
			(line) =>
				line.startsWith(" ▾ root.op") ||
				line.startsWith(" ▸ root.op") ||
				line.startsWith(" · root.op"),
		) ?? null

describe("trace details waterfall width (end-to-end TUI)", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-trace-width-"))
	const dbPath = join(tempDir, "telemetry.sqlite")
	const lastServicePath = join(tempDir, "last-service.txt")
	let canRun = false

	beforeAll(async () => {
		canRun = await hasTuistory()
		if (!canRun) return

		writeFileSync(lastServicePath, "waterfall-repro")

		const seed = Bun.spawn({
			cmd: ["bun", "run", "src/ui/waterfallNav.repro.seed.ts"],
			cwd: process.cwd(),
			env: {
				...process.env,
				MOTEL_OTEL_DB_PATH: dbPath,
				MOTEL_OTEL_ENABLED: "false",
			},
			stdout: "pipe",
			stderr: "pipe",
		})
		const seedCode = await seed.exited
		if (seedCode !== 0) {
			const err = await new Response(seed.stderr).text()
			throw new Error(`seed failed: ${err}`)
		}

		await tui(["close", "--session", SESSION])
		const launch = await tui([
			"launch",
			"bun run src/index.tsx",
			"--session",
			SESSION,
			"--cols",
			"96",
			"--rows",
			"40",
			"--cwd",
			process.cwd(),
			"--env",
			`MOTEL_OTEL_DB_PATH=${dbPath}`,
			"--env",
			"MOTEL_OTEL_ENABLED=false",
			"--timeout",
			"15000",
		])
		if (launch.code !== 0) throw new Error(`launch failed: ${launch.stderr}`)
		await tui(["wait", "root.op", "--session", SESSION, "--timeout", "10000"])
		await tui(["wait-idle", "--session", SESSION, "--timeout", "5000"])
	}, 60_000)

	afterAll(async () => {
		if (canRun) await tui(["close", "--session", SESSION])
		try {
			rmSync(tempDir, { recursive: true, force: true })
		} catch {}
	})

	it("fills the full-width trace details pane in narrow mode", async () => {
		if (!canRun) return

		await press("return")
		const snap = await snapshot()
		const divider = dividerWidth(snap)
		const row = rootWaterfallRow(snap)

		expect(divider).toBe(96)
		expect(row).not.toBeNull()
		expect(row!.length).toBeGreaterThanOrEqual(divider - 1)
	}, 60_000)
})
