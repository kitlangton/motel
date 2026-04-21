import { Effect, Layer, Ref, Context } from "effect"
import {
	listAliveEntries,
	MOTEL_SERVICE_ID,
	type RegistryEntry,
} from "./registry.js"

export class LocatorError extends Error {
	readonly _tag = "LocatorError"
	constructor(readonly detail: string) {
		super(detail)
	}
}

const ambiguousDetail = (candidates: readonly RegistryEntry[]) =>
	`Multiple motel instances running and none match cwd. Set MOTEL_URL to choose one:\n` +
	candidates
		.map((c) => `  - ${c.url}  (workdir=${c.workdir}, pid=${c.pid})`)
		.join("\n")

type Resolved = {
	readonly url: string
	readonly pid: number
	readonly workdir: string
	readonly version: string
	readonly cwdMatch: boolean
	readonly instanceCount: number
	readonly source: "env" | "registry"
}

type HealthShape = {
	readonly ok: boolean
	readonly service: string
	readonly pid: number
	readonly url: string
	readonly workdir: string
	readonly version: string
}

const handshake = (url: string): Effect.Effect<HealthShape, LocatorError> =>
	Effect.tryPromise({
		try: async () => {
			const res = await fetch(new URL("/api/health", url), {
				signal: AbortSignal.timeout(1500),
			})
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			const body = (await res.json()) as HealthShape
			if (body.service !== MOTEL_SERVICE_ID) {
				throw new Error(
					`service=${body.service} (expected ${MOTEL_SERVICE_ID})`,
				)
			}
			return body
		},
		catch: (err) =>
			new LocatorError(
				`Handshake with ${url} failed: ${(err as Error).message}`,
			),
	})

const pickByCwd = (entries: readonly RegistryEntry[], cwd: string) => {
	const withSep = cwd.endsWith("/") ? cwd : cwd + "/"
	const matching = entries
		.filter((e) => {
			const workdir = e.workdir.endsWith("/") ? e.workdir : e.workdir + "/"
			return withSep === workdir || withSep.startsWith(workdir)
		})
		.sort((a, b) => b.workdir.length - a.workdir.length)
	return matching[0] ?? null
}

const discover = Effect.fn("Locator.discover")(function* () {
	const envUrl = process.env.MOTEL_URL?.trim()
	if (envUrl) {
		const health = yield* handshake(envUrl)
		return {
			url: envUrl,
			pid: health.pid,
			workdir: health.workdir,
			version: health.version,
			cwdMatch: process.cwd().startsWith(health.workdir),
			instanceCount: 1,
			source: "env" as const,
		}
	}

	const all = listAliveEntries()

	if (all.length === 0) {
		return yield* Effect.fail(
			new LocatorError(
				"No motel instance found. Start one with `bun run server` from your project root, then retry.",
			),
		)
	}

	const cwd = process.cwd()
	const byCwd = pickByCwd(all, cwd)
	const chosen = byCwd ?? (all.length === 1 ? all[0]! : null)

	if (!chosen) {
		return yield* Effect.fail(new LocatorError(ambiguousDetail(all)))
	}

	const health = yield* handshake(chosen.url)

	if (health.pid !== chosen.pid) {
		return yield* Effect.fail(
			new LocatorError(
				`Registry entry pid=${chosen.pid} but server at ${chosen.url} reports pid=${health.pid}. Stale entry — next discovery will prune it.`,
			),
		)
	}

	return {
		url: chosen.url,
		pid: health.pid,
		workdir: health.workdir,
		version: health.version,
		cwdMatch: cwd.startsWith(chosen.workdir),
		instanceCount: all.length,
		source: "registry" as const,
	}
})

export class Locator extends Context.Service<
	Locator,
	{
		readonly resolve: Effect.Effect<Resolved, LocatorError>
		readonly invalidate: Effect.Effect<void>
	}
>()("motel/Locator") {}

export const LocatorLive = Layer.effect(
	Locator,
	Effect.gen(function* () {
		const cache = yield* Ref.make<Resolved | null>(null)
		return {
			resolve: Effect.gen(function* () {
				const cached = yield* Ref.get(cache)
				if (cached) return cached
				const resolved = yield* discover()
				yield* Ref.set(cache, resolved)
				return resolved
			}),
			invalidate: Ref.set(cache, null),
		}
	}),
)
