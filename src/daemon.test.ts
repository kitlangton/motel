import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createDaemonManager } from "./daemon.js"

const repoRoot = path.resolve(import.meta.dir, "..")

const randomPort = () => 29000 + Math.floor(Math.random() * 2000)

const makeHarness = () => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "motel-daemon-test-"))
	const manager = createDaemonManager({
		repoRoot,
		runtimeDir,
		databasePath: path.join(runtimeDir, "telemetry.sqlite"),
		port: randomPort(),
	})
	return {
		runtimeDir,
		manager,
	}
}

const activeHarnesses: Array<ReturnType<typeof makeHarness>> = []

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await Effect.runPromise(harness.manager.stop).catch(() => undefined)
		fs.rmSync(harness.runtimeDir, { recursive: true, force: true })
	}
})

describe("daemon manager", () => {
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
})
