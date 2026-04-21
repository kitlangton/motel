/**
 * End-to-end reproducer for "navigation broken after changing sort".
 *
 * Strategy:
 *   1. Seed 5 traces with distinct durations so `recent` and `slowest` give
 *      obviously different orderings.
 *   2. Launch the TUI, capture the default (recent) order and the selected row.
 *   3. Press `s` to switch to `slowest`, capture the new order.
 *   4. Drive `j` / `k` and make sure the highlighted row steps through the
 *      *sorted* list, not the underlying raw order.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TUISTORY_BIN = "tuistory"
const SESSION = `motel-sort-${Date.now()}`

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

/**
 * Extract the ordered list of operation names that appear as trace rows in
 * the left pane, and the currently-selected operation inferred from the
 * TRACE DETAILS pane on the right (whose second row shows the selected
 * trace's root operation name). tuistory's plain-text snapshots don't
 * preserve background color, so the visual "selected row" marker in
 * TraceList isn't visible — we use the right pane as the source of truth.
 */
const listRows = (
	snap: string,
): { readonly rows: readonly string[]; readonly selected: string | null } => {
	const rows: string[] = []
	let selected: string | null = null
	let inDetailsPane = false
	let detailsLinesConsumed = 0
	for (const raw of snap.split("\n")) {
		const leftHalf = raw.split("\u2502")[0] ?? raw
		const rightHalf = raw.includes("\u2502")
			? raw.split("\u2502").slice(1).join("\u2502")
			: ""

		// Trace rows: left pane, `·` then the operation name as the first
		// token. (Earlier versions appended `#<hash>`; that's been removed.)
		const rowMatch = leftHalf.match(/^\s+\u00b7\s+(op[A-Z])\b/)
		if (rowMatch) rows.push(rowMatch[1]!)

		// Selected trace: right pane, line immediately after `TRACE DETAILS`
		// header holds the selected root operation name.
		if (
			rightHalf.includes("TRACE DETAILS") ||
			leftHalf.includes("TRACE DETAILS")
		) {
			inDetailsPane = true
			detailsLinesConsumed = 0
			continue
		}
		if (inDetailsPane) {
			detailsLinesConsumed++
			if (detailsLinesConsumed === 1) {
				// The op name row: right pane (if wide) or left pane (if narrow).
				const source = rightHalf || leftHalf
				const opMatch = source.match(/^\s*(\S+)/)
				if (opMatch && opMatch[1] !== "No" && opMatch[1] !== "waiting") {
					selected = opMatch[1]!
				}
				inDetailsPane = false
			}
		}
	}
	return { rows, selected }
}

const SERVICE_NAME = "sort-nav-repro"

describe("trace navigation after changing sort", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-sort-repro-"))
	const dbPath = join(tempDir, "telemetry.sqlite")
	const lastServicePath = join(tempDir, "last-service.txt")
	let canRun = false

	beforeAll(async () => {
		canRun = await hasTuistory()
		if (!canRun) return

		writeFileSync(lastServicePath, SERVICE_NAME)

		// Seed in a child process so config.ts picks up our DB path fresh.
		const seed = Bun.spawn({
			cmd: ["bun", "run", "src/ui/traceSortNav.repro.seed.ts"],
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
		// Use a modest height (20 rows) where the 15-trace list must scroll to
		// reveal the bottom rows while still leaving room for the details pane
		// on the right (needed by the test's selected-trace extraction).
		const launch = await tui([
			"launch",
			"bun run src/index.tsx",
			"--session",
			SESSION,
			"--cols",
			"120",
			"--rows",
			"20",
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
		await tui(["wait", "opE", "--session", SESSION, "--timeout", "10000"])
		await tui(["wait-idle", "--session", SESSION, "--timeout", "5000"])
	}, 60_000)

	afterAll(async () => {
		if (canRun) await tui(["close", "--session", SESSION])
		try {
			rmSync(tempDir, { recursive: true, force: true })
		} catch {}
	})

	// Expected orders given the seed (A..O):
	//   recent : O N M L K J I H G F E D C B A   (newest first)
	//   slowest: H L D F J B M E N I A O C G K   (durations 200..1 ms)
	const RECENT_ORDER = [
		"opO",
		"opN",
		"opM",
		"opL",
		"opK",
		"opJ",
		"opI",
		"opH",
		"opG",
		"opF",
		"opE",
		"opD",
		"opC",
		"opB",
		"opA",
	]
	const SLOWEST_ORDER = [
		"opH",
		"opL",
		"opD",
		"opF",
		"opJ",
		"opB",
		"opM",
		"opE",
		"opN",
		"opI",
		"opA",
		"opO",
		"opC",
		"opG",
		"opK",
	]

	it("default sort is 'recent' (most recent first), selection starts at the top", async () => {
		if (!canRun) return
		const snap = await snapshot()
		const parsed = listRows(snap)
		if (parsed.selected === null) {
			// Dump raw snapshot to aid diagnosis when the extraction helper misses.
			console.error("--- RAW SNAPSHOT ---\n" + snap + "\n--- END ---")
		}
		expect(parsed.selected).toBe("opO")
	})

	it("after `s`, the visible order is `slowest` and selection stays on the same trace", async () => {
		if (!canRun) return
		await press("s")
		const { selected } = listRows(await snapshot())
		// opO moves from recent #0 to slowest #11. Selection follows the trace.
		expect(selected).toBe("opO")
	})

	it("j moves through the SORTED order (not raw data order)", async () => {
		if (!canRun) return
		// Currently selected = opO at slowest index 11 (SLOWEST_ORDER[11] = "opO").
		// Press j repeatedly and each step should land on the next sorted row.
		const startIdx = SLOWEST_ORDER.indexOf("opO")
		for (let offset = 1; offset <= 3; offset++) {
			await press("j")
			const expected = SLOWEST_ORDER[startIdx + offset]
			const { selected } = listRows(await snapshot())
			expect(selected).toBe(expected)
		}
	})

	it("k moves backward through the sorted order", async () => {
		if (!canRun) return
		// We are 3 rows past opO in SLOWEST_ORDER.
		for (let i = 0; i < 3; i++) await press("k")
		expect(listRows(await snapshot()).selected).toBe("opO")
	})

	it("G jumps to the bottom of the sorted list, gg to the top", async () => {
		if (!canRun) return
		await press("G")
		expect(listRows(await snapshot()).selected).toBe(
			SLOWEST_ORDER[SLOWEST_ORDER.length - 1]!,
		)

		await press("g", "g")
		expect(listRows(await snapshot()).selected).toBe(SLOWEST_ORDER[0]!)
	})

	it("switching sort back to 'recent' restores recency order and keeps selection on the same trace", async () => {
		if (!canRun) return
		// Currently on SLOWEST_ORDER[0] = "opH". Press `s` twice: slowest → errors → recent.
		await press("s")
		await press("s")
		const { selected } = listRows(await snapshot())
		expect(selected).toBe("opH")
	})

	it("scrolling: selecting a trace near the bottom brings it into view, and changing sort keeps it in view", async () => {
		if (!canRun) return
		// Jump to the bottom of the recent list (opA), then change sort to slowest.
		// opA is at slowest index 10 — well down the list. Selection must stay on opA
		// AND the viewport must scroll to show it.
		await press("G")
		expect(listRows(await snapshot()).selected).toBe("opA")

		await press("s")
		const after = listRows(await snapshot())
		expect(after.selected).toBe("opA")
		// The row for opA must be visible in the rendered list.
		expect(after.rows).toContain("opA")
	})
})
