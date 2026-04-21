/**
 * End-to-end reproducer for the waterfall collapse/expand bug.
 *
 * Strategy:
 * 1. Seed a deterministic trace with a parent span and three leaf children
 *    into a fresh SQLite database.
 * 2. Launch the motel TUI under tuistory pointing at that database.
 * 3. Drive keys to navigate onto the parent span, capture a baseline snapshot.
 * 4. Press `h` (collapse) then `l` (expand). Capture again.
 * 5. Assert: the visible waterfall body before === after. Today this fails
 *    because the first child silently disappears from the visible list after
 *    a collapse/expand cycle.
 *
 * Skipped automatically when `tuistory` is not installed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TUISTORY_BIN = "tuistory"
const SESSION = `motel-repro-${Date.now()}`

// ---------------------------------------------------------------------------
// tuistory wrappers
// ---------------------------------------------------------------------------

const hasTuistory = async () => {
	try {
		const proc = Bun.spawn({
			cmd: ["which", TUISTORY_BIN],
			stdout: "pipe",
			stderr: "ignore",
		})
		const code = await proc.exited
		return code === 0
	} catch {
		return false
	}
}

const tui = async (
	args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
	const proc = Bun.spawn({
		cmd: [TUISTORY_BIN, ...args],
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	const code = await proc.exited
	return { code, stdout, stderr }
}

const snapshot = async () =>
	(await tui(["snapshot", "--session", SESSION])).stdout

const press = async (...keys: string[]) => {
	await tui(["press", "--session", SESSION, ...keys])
	// small settle so the next snapshot reflects the keypress
	await Bun.sleep(120)
}

// Slice out just the waterfall body region from a snapshot. The waterfall
// always sits between the last two horizontal dividers (the one just below
// the trace meta / pane header, and the one above the footer). Using the
// *last* pair makes the helper robust to layout changes that add or remove
// header dividers (breadcrumbs, split-divider junctions, etc.).
//
// In wide (side-by-side) mode each line also contains the trace list on the
// left half separated by `│`. The list renders relative ages like "6s / 7s"
// that drift between snapshots; strip everything left of the first `│` so
// only the waterfall contributes to the comparison.
const waterfallBody = (snap: string): readonly string[] => {
	const lines = snap.split("\n")
	const dividerIdxs: number[] = []
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("─")) dividerIdxs.push(i)
	}
	if (dividerIdxs.length < 2) return []
	const start = dividerIdxs[dividerIdxs.length - 2]! + 1
	const end = dividerIdxs[dividerIdxs.length - 1]!
	return lines.slice(start, end).map((line) => {
		const barIdx = line.indexOf("\u2502")
		const sliced = barIdx >= 0 ? line.slice(barIdx) : line
		return sliced.replace(/\s+$/g, "")
	})
}

// ---------------------------------------------------------------------------
// Test fixture: temp DB with a deterministic trace
// ---------------------------------------------------------------------------

// Structure (kept in sync with src/ui/waterfallNav.repro.seed.ts):
//   root.op
//   ├─ siblingBefore.op
//   ├─ parent.op            <- the one we collapse / expand
//   │  ├─ childA.op (1st)   <- the one that used to disappear after a cycle
//   │  ├─ childB.op
//   │  ├─ childC.op
//   │  ├─ childD.op
//   │  ├─ childE.op
//   │  └─ childF.op
//   ├─ siblingAfter.op
//   └─ tail.op
//      └─ tailChild.op
//         └─ tailGrandchild.op
const SERVICE_NAME = "waterfall-repro"

describe("waterfall collapse/expand (end-to-end TUI)", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-repro-"))
	const dbPath = join(tempDir, "telemetry.sqlite")
	const lastServicePath = join(tempDir, "last-service.txt")
	let canRun = false

	beforeAll(async () => {
		canRun = await hasTuistory()
		if (!canRun) return

		// Pin selected service so the TUI lands on our seeded trace immediately.
		writeFileSync(lastServicePath, SERVICE_NAME)

		// Seed the DB in a child process. Doing it in-process collides with
		// other tests that imported config.ts first (databasePath is captured at
		// module load time and ESM cache busts on the runtime entry alone do not
		// invalidate the transitively cached config module).
		const seed = Bun.spawn({
			cmd: ["bun", "run", "src/ui/waterfallNav.repro.seed.ts"],
			cwd: process.cwd(),
			env: {
				...process.env,
				MOTEL_OTEL_DB_PATH: dbPath,
				MOTEL_OTEL_RETENTION_HOURS: "24",
				MOTEL_OTEL_ENABLED: "false",
			},
			stdout: "pipe",
			stderr: "pipe",
		})
		const seedCode = await seed.exited
		if (seedCode !== 0) {
			const [out, err] = await Promise.all([
				new Response(seed.stdout).text(),
				new Response(seed.stderr).text(),
			])
			throw new Error(
				`Seed subprocess failed (${seedCode})\nstdout: ${out}\nstderr: ${err}`,
			)
		}

		// Make sure no stale session is hanging around with the same name.
		await tui(["close", "--session", SESSION])

		// Launch the TUI. We use a dedicated entry point (src/index.tsx) and a
		// generous viewport so the waterfall isn't truncated.
		const launch = await tui([
			"launch",
			"bun run src/index.tsx",
			"--session",
			SESSION,
			"--cols",
			"160",
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
		if (launch.code !== 0) {
			throw new Error(
				`tuistory launch failed: ${launch.stderr || launch.stdout}`,
			)
		}

		// Wait for the trace row to appear.
		const waitResult = await tui([
			"wait",
			"root.op",
			"--session",
			SESSION,
			"--timeout",
			"10000",
		])
		if (waitResult.code !== 0) {
			const snap = (await tui(["snapshot", "--session", SESSION])).stdout
			throw new Error(
				`Trace did not appear in TUI after seed.\nstderr: ${waitResult.stderr}\nstdout: ${waitResult.stdout}\nSnapshot:\n${snap}`,
			)
		}
		await tui(["wait-idle", "--session", SESSION, "--timeout", "5000"])
	}, 60_000)

	afterAll(async () => {
		if (canRun) {
			await tui(["close", "--session", SESSION])
		}
		try {
			rmSync(tempDir, { recursive: true, force: true })
		} catch {}
	})

	it("collapse → expand cycle preserves the visible span list", async () => {
		if (!canRun) return // tuistory unavailable: skip

		// Enter the span navigation pane.
		await press("return")
		// Visible order: root, siblingBefore, parent, childA..F, siblingAfter, tail, tailChild, tailGrandchild
		// Move down to parent.op (index 2): two j presses.
		await press("j")
		await press("j")

		const before = waterfallBody(await snapshot())
		const beforeText = before.join("\n")
		// Sanity: every operation should be visible.
		for (const op of [
			"parent.op",
			"childA.op",
			"childB.op",
			"childC.op",
			"childD.op",
			"childE.op",
			"childF.op",
			"siblingBefore.op",
			"siblingAfter.op",
			"tail.op",
			"tailChild.op",
			"tailGrandchild.op",
		]) {
			expect(beforeText).toContain(op)
		}

		// Collapse parent.op
		await press("h")
		const collapsedText = waterfallBody(await snapshot()).join("\n")
		expect(collapsedText).toContain("parent.op")
		for (const child of [
			"childA.op",
			"childB.op",
			"childC.op",
			"childD.op",
			"childE.op",
			"childF.op",
		]) {
			expect(collapsedText).not.toContain(child)
		}

		// Expand parent.op
		await press("l")
		const after = waterfallBody(await snapshot())
		const afterText = after.join("\n")

		// Every child must reappear after expand.
		for (const child of [
			"childA.op",
			"childB.op",
			"childC.op",
			"childD.op",
			"childE.op",
			"childF.op",
		]) {
			expect(afterText).toContain(child)
		}
		// Sibling structure must remain intact.
		expect(afterText).toContain("siblingBefore.op")
		expect(afterText).toContain("siblingAfter.op")
		expect(afterText).toContain("tailGrandchild.op")

		// And the waterfall body should be byte-identical to baseline.
		expect(after).toEqual(before)
	}, 60_000)

	it("a SINGLE collapse/expand cycle does not drift the visible list", async () => {
		if (!canRun) return

		await press("escape")
		await press("escape")
		await press("return")
		await press("j")
		await press("j")

		const baseline = waterfallBody(await snapshot())
		await press("h")
		await press("l")
		const after = waterfallBody(await snapshot())
		expect(after).toEqual(baseline)
	}, 60_000)

	it("repeated h/l cycles do not drift the visible list", async () => {
		if (!canRun) return

		// Reset by re-entering nav: esc out of any sub-mode then re-enter.
		await press("escape")
		await press("escape")
		await press("return")
		await press("j") // siblingBefore
		await press("j") // parent

		const baseline = waterfallBody(await snapshot())

		for (let i = 0; i < 5; i++) {
			await press("h")
			await press("l")
		}

		const after = waterfallBody(await snapshot())
		expect(after).toEqual(baseline)
	}, 60_000)
})
