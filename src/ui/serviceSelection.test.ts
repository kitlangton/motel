import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("initial TUI service selection", () => {
	for (const remembered of [undefined, "svc-b", " \n"]) {
		for (const explicit of [undefined, "", " \t ", "svc-a", " svc-a ", "motel-otel-tui"]) {
			test(`env=${JSON.stringify(explicit)}, remembered=${JSON.stringify(remembered)}`, () => {
				const dir = mkdtempSync(join(tmpdir(), "motel-service-selection-"))
				try {
					if (remembered !== undefined) writeFileSync(join(dir, "last-service.txt"), remembered)
					const env = { ...process.env }
					for (const key of Object.keys(env)) {
						if (key.startsWith("MOTEL_")) delete env[key]
					}
					env.MOTEL_RUNTIME_DIR = dir
					env.MOTEL_OTEL_DB_PATH = join(dir, "telemetry.sqlite")
					if (explicit !== undefined) env.MOTEL_OTEL_SERVICE_NAME = explicit

					// Fresh processes exercise import-time config and persistence without module-cache leakage.
					const result = Bun.spawnSync([process.execPath, "--no-env-file", "--eval", `
						import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
						import { config } from "./src/config.ts"
						import { selectedTraceServiceAtom } from "./src/ui/atoms.ts"
						const registry = AtomRegistry.make()
						const initial = registry.get(selectedTraceServiceAtom)
						registry.set(selectedTraceServiceAtom, "switched-service")
						console.log(JSON.stringify({
							initial,
							serviceName: config.otel.serviceName,
							switched: registry.get(selectedTraceServiceAtom),
						}))
						registry.dispose()
					`], { cwd: join(import.meta.dir, "../.."), env, timeout: 5_000 })

					expect(result.exitCode).toBe(0)
					expect(result.stderr.toString()).toBe("")
					expect(JSON.parse(result.stdout.toString())).toEqual({
						initial: explicit?.trim() || remembered?.trim() || "motel-otel-tui",
						serviceName: explicit?.trim() || "motel-otel-tui",
						switched: "switched-service",
					})
				} finally {
					rmSync(dir, { recursive: true, force: true })
				}
			})
		}
	}
})
