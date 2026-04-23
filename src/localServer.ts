import { promises as fs } from "node:fs"
import path from "node:path"
import { Duration, Effect, Layer } from "effect"
import { config } from "./config.js"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpStaticServer from "effect/unstable/http/HttpStaticServer"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { MotelHttpApi, NotFoundError } from "./httpApi.js"
import {
	attributeFiltersFromEntries,
	attributeContainsFiltersFromEntries,
} from "./queryFilters.js"
import {
	MOTEL_SERVICE_ID,
	MOTEL_VERSION,
	removeRegistryEntry,
	writeRegistryEntry,
} from "./registry.js"
import { AsyncIngest, AsyncIngestLive } from "./services/AsyncIngest.js"
import {
	LogQueryService,
	LogQueryServiceLive,
} from "./services/LogQueryService.js"
import {
	TelemetryStore,
	TelemetryStoreLive,
	TelemetryStoreReadonlyLive,
} from "./services/TelemetryStore.js"
import {
	TraceQueryService,
	TraceQueryServiceLive,
} from "./services/TraceQueryService.js"
import type { LogItem, TraceItem, TraceSummaryItem } from "./domain.js"
import { lifecycleLabel } from "./ui/format.js"
import { HttpServerRequest } from "effect/unstable/http"

// Set by the RegistryLayer acquisition once the Bun socket has bound.
// Both /api/health and the registry entry read from here so they agree
// on a single server-start timestamp, and the value reflects actual
// listen time rather than module-evaluation time.
let serverStartedAt: string = new Date(0).toISOString()

const attributeFiltersFromQuery = (url: URL) =>
	attributeFiltersFromEntries(url.searchParams.entries())

const attributeContainsFiltersFromQuery = (url: URL) =>
	attributeContainsFiltersFromEntries(url.searchParams.entries())

const decodeAttributeFilters = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest
	const url = yield* HttpServerRequest.toURL(request)
	const attributeFilters = attributeFiltersFromQuery(url)
	const attributeContainsFilters = attributeContainsFiltersFromQuery(url)
	return { attributeFilters, attributeContainsFilters } as const
})

type CursorShape =
	| { readonly kind: "trace"; readonly startedAt: number; readonly id: string }
	| { readonly kind: "log"; readonly timestamp: number; readonly id: string }

const formatLookback = (minutes: number) => {
	if (minutes % 1440 === 0) return `${minutes / 1440}d`
	if (minutes % 60 === 0) return `${minutes / 60}h`
	return `${minutes}m`
}

const listMeta = (input: {
	readonly limit: number
	readonly lookbackMinutes: number
	readonly returned: number
	readonly truncated: boolean
	readonly nextCursor: CursorShape | null
}) => ({
	limit: input.limit,
	lookback: formatLookback(input.lookbackMinutes),
	returned: input.returned,
	truncated: input.truncated,
	nextCursor: input.nextCursor,
})

const paginateSummaries = (
	summaries: readonly TraceSummaryItem[],
	options: {
		readonly limit: number
		readonly lookbackMinutes: number
		readonly cursor: CursorShape | null | undefined
	},
) => {
	const page = summaries.slice(0, options.limit)
	const last = page.at(-1)
	return {
		data: page,
		meta: listMeta({
			limit: options.limit,
			lookbackMinutes: options.lookbackMinutes,
			returned: page.length,
			truncated: summaries.length > page.length,
			nextCursor: last
				? {
						kind: "trace",
						startedAt: last.startedAt.getTime(),
						id: last.traceId,
					}
				: null,
		}),
	}
}

const paginateLogs = (
	logs: readonly LogItem[],
	options: {
		readonly limit: number
		readonly lookbackMinutes: number
		readonly cursor: CursorShape | null | undefined
	},
) => {
	const page = logs.slice(0, options.limit)
	const last = page.at(-1)

	return {
		data: page,
		meta: listMeta({
			limit: options.limit,
			lookbackMinutes: options.lookbackMinutes,
			returned: page.length,
			truncated: logs.length > page.length,
			nextCursor: last
				? {
						kind: "log",
						timestamp: last.timestamp.getTime(),
						id: last.id,
					}
				: null,
		}),
	}
}

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")

const renderTracePage = (trace: TraceItem, logs: readonly LogItem[]) => {
	const logCountsBySpan = new Map<string, number>()
	for (const log of logs) {
		if (!log.spanId) continue
		logCountsBySpan.set(log.spanId, (logCountsBySpan.get(log.spanId) ?? 0) + 1)
	}

	const spansHtml = trace.spans
		.map((span) => {
			const indent = Math.min(span.depth * 20, 120)
			const count = logCountsBySpan.get(span.spanId) ?? 0
			return `<tr>
<td style="padding-left:${indent}px">${escapeHtml(span.operationName)}</td>
<td>${escapeHtml(span.serviceName)}</td>
<td>${lifecycleLabel(span)}</td>
<td>${escapeHtml(span.status)}</td>
<td>${span.durationMs.toFixed(2)}ms</td>
<td>${count}</td>
</tr>`
		})
		.join("\n")

	const logsHtml = logs
		.slice(0, 80)
		.map(
			(log) => `<tr>
<td>${escapeHtml(log.timestamp.toISOString())}</td>
<td>${escapeHtml(log.severityText)}</td>
<td>${escapeHtml(log.scopeName ?? log.serviceName)}</td>
<td><pre>${escapeHtml(log.body)}</pre></td>
</tr>`,
		)
		.join("\n")

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(trace.rootOperationName)}</title>
<style>
body { background:#0b0b0b; color:#ede7da; font-family: ui-monospace, SFMono-Regular, monospace; margin:24px; }
h1,h2 { color:#f4a51c; }
.muted { color:#9f9788; }
table { width:100%; border-collapse: collapse; margin-top:16px; }
th, td { border-bottom:1px solid #2a2520; padding:8px; text-align:left; vertical-align:top; }
pre { white-space:pre-wrap; margin:0; color:#ede7da; }
</style>
</head>
<body>
<h1>${escapeHtml(trace.rootOperationName)}</h1>
<p class="muted">${escapeHtml(trace.serviceName)} · ${lifecycleLabel(trace)} · ${trace.durationMs.toFixed(2)}ms · ${trace.spanCount} spans · ${logs.length} logs</p>
<p class="muted">${escapeHtml(trace.traceId)}</p>
<h2>Spans</h2>
<table>
<thead><tr><th>Operation</th><th>Service</th><th>State</th><th>Status</th><th>Duration</th><th>Logs</th></tr></thead>
<tbody>${spansHtml}</tbody>
</table>
<h2>Logs</h2>
<table>
<thead><tr><th>Time</th><th>Level</th><th>Scope</th><th>Body</th></tr></thead>
<tbody>${logsHtml}</tbody>
</table>
</body>
</html>`
}

const TelemetryGroupLive = HttpApiBuilder.group(
	MotelHttpApi,
	"telemetry",
	Effect.fn(function* (handlers) {
		const ingest = yield* AsyncIngest
		const store = yield* TelemetryStore
		const logQuery = yield* LogQueryService
		const traceQuery = yield* TraceQueryService

		const loadLogsPage = (input: {
			readonly serviceName?: string | null
			readonly severity?: string | null
			readonly traceId?: string | null
			readonly spanId?: string | null
			readonly body?: string | null
			readonly attributeFilters?: Readonly<Record<string, string>>
			readonly attributeContainsFilters?: Readonly<Record<string, string>>
			readonly limit: number
			readonly lookbackMinutes: number
			readonly cursor: CursorShape | null | undefined
		}) =>
			Effect.map(
				logQuery.searchLogs({
					serviceName: input.serviceName,
					severity: input.severity,
					traceId: input.traceId,
					spanId: input.spanId,
					body: input.body,
					lookbackMinutes: input.lookbackMinutes,
					limit: input.limit + 1,
					cursorTimestampMs:
						input.cursor?.kind === "log" ? input.cursor.timestamp : undefined,
					cursorId: input.cursor?.kind === "log" ? input.cursor.id : undefined,
					attributeFilters: input.attributeFilters,
					attributeContainsFilters: input.attributeContainsFilters,
				}),
				(logs) =>
					paginateLogs(logs, {
						limit: input.limit,
						lookbackMinutes: input.lookbackMinutes,
						cursor: input.cursor,
					}),
			)

		return (
			handlers
				.handle("root", () =>
					Effect.succeed(
						"motel local telemetry server\n\nPOST /v1/traces\nPOST /v1/logs\nGET /api/services\nGET /api/traces\nGET /api/traces/search\nGET /api/traces/stats\nGET /api/traces/<trace-id>\nGET /api/traces/<trace-id>/spans\nGET /api/traces/<trace-id>/logs\nGET /api/spans/search\nGET /api/spans/<span-id>\nGET /api/spans/<span-id>/logs\nGET /api/logs\nGET /api/logs/search\nGET /api/logs/stats\nGET /api/ai/calls\nGET /api/ai/calls/<span-id>\nGET /api/ai/stats\nGET /api/facets?type=logs&field=severity\nGET /api/docs\nGET /api/docs/<name>\nGET /openapi.json\nGET /docs\nGET /trace/<trace-id>\n",
					),
				)
				.handle("health", () =>
					Effect.succeed({
						ok: true,
						service: MOTEL_SERVICE_ID,
						databasePath: config.otel.databasePath,
						pid: process.pid,
						url: config.otel.baseUrl,
						workdir: process.cwd(),
						startedAt: serverStartedAt,
						version: MOTEL_VERSION,
					}),
				)
				// OTLP ingest is routed to the worker thread via AsyncIngest
				// so the main event loop stays free during heavy SQLite writes.
				// Everything else still uses the direct TelemetryStore — reads
				// are fast enough that IPC overhead isn't worth paying.
				.handle("ingestTraces", ({ payload }) =>
					Effect.orDie(ingest.ingestTraces({ payload })),
				)
				.handle("ingestLogs", ({ payload }) =>
					Effect.orDie(ingest.ingestLogs({ payload })),
				)
				.handle("services", () =>
					traceQuery.listServices.pipe(
						Effect.map((data) => ({ data })),
						Effect.orDie,
					),
				)
				.handle(
					"traces",
					Effect.fnUntraced(function* ({
						query: { service, lookback, limit, cursor },
					}) {
						const lookbackMinutes = Duration.toMinutes(lookback)
						const data = yield* traceQuery.listTraceSummaries(service ?? null, {
							limit: limit + 1,
							lookbackMinutes,
							cursorStartedAtMs:
								cursor?.kind === "trace" ? cursor.startedAt : undefined,
							cursorTraceId: cursor?.kind === "trace" ? cursor.id : undefined,
						})
						return paginateSummaries(data, { limit, lookbackMinutes, cursor })
					}, Effect.orDie),
				)
				.handle(
					"searchTraces",
					Effect.fnUntraced(function* ({
						query: {
							service,
							operation,
							status,
							minDurationMs,
							aiText,
							lookback,
							limit,
							cursor,
						},
					}) {
						const attributeFilters = yield* decodeAttributeFilters
						const lookbackMinutes = Duration.toMinutes(lookback)
						const data = yield* traceQuery.searchTraceSummaries({
							...attributeFilters,
							serviceName: service,
							operation,
							status,
							minDurationMs,
							aiText,
							limit: limit + 1,
							lookbackMinutes,
							cursorStartedAtMs:
								cursor?.kind === "trace" ? cursor.startedAt : undefined,
							cursorTraceId: cursor?.kind === "trace" ? cursor.id : undefined,
						})
						return paginateSummaries(data, { limit, lookbackMinutes, cursor })
					}, Effect.orDie),
				)
				.handle(
					"traceStats",
					Effect.fnUntraced(function* ({
						query: {
							groupBy,
							agg,
							service,
							operation,
							lookback,
							limit,
							status,
							minDurationMs,
						},
					}) {
						const lookbackMinutes = Duration.toMinutes(lookback)
						const data = yield* traceQuery.traceStats({
							groupBy,
							agg,
							serviceName: service,
							operation: operation,
							status,
							minDurationMs,
							limit,
							lookbackMinutes,
						})
						return { data }
					}, Effect.orDie),
				)
				.handle(
					"searchSpans",
					Effect.fnUntraced(function* ({ query }) {
						const attributeFilters = yield* decodeAttributeFilters
						const lookbackMinutes = Duration.toMinutes(query.lookback)
						const data = yield* traceQuery.searchSpans({
							...query,
							...attributeFilters,
							serviceName: query.service,
							limit: query.limit + 1,
							lookbackMinutes,
						})
						const truncated = data.length > query.limit
						const page = truncated ? data.slice(0, query.limit) : data
						return {
							data: page,
							meta: listMeta({
								limit: query.limit,
								lookbackMinutes,
								returned: page.length,
								truncated,
								nextCursor: null,
							}),
						}
					}, Effect.orDie),
				)
				.handle(
					"traceLogs",
					Effect.fnUntraced(function* ({
						params,
						query: { lookback, limit, cursor },
					}) {
						const lookbackMinutes = Duration.toMinutes(lookback)
						return yield* loadLogsPage({
							traceId: params.traceId,
							limit,
							lookbackMinutes,
							cursor,
						})
					}, Effect.orDie),
				)
				.handle("traceSpans", ({ params }) =>
					traceQuery.listTraceSpans(params.traceId).pipe(
						Effect.map((data) => ({ data })),
						Effect.orDie,
					),
				)
				.handle(
					"spanLogs",
					Effect.fnUntraced(function* ({
						params,
						query: { lookback, limit, cursor },
					}) {
						const lookbackMinutes = Duration.toMinutes(lookback)
						return yield* loadLogsPage({
							spanId: params.spanId,
							limit,
							lookbackMinutes,
							cursor,
						})
					}, Effect.orDie),
				)
				.handle("span", ({ params }) =>
					traceQuery.getSpan(params.spanId).pipe(
						Effect.orDie,
						Effect.flatMap((data) =>
							data
								? Effect.succeed({ data })
								: new NotFoundError({ error: "Span not found" }).asEffect(),
						),
					),
				)
				.handle("trace", ({ params }) =>
					traceQuery.getTrace(params.traceId).pipe(
						Effect.orDie,
						Effect.flatMap((data) =>
							data
								? Effect.succeed({ data })
								: new NotFoundError({ error: "Trace not found" }).asEffect(),
						),
					),
				)
				.handle(
					"logs",
					Effect.fnUntraced(function* ({ query }) {
						const attributeFilters = yield* decodeAttributeFilters
						return yield* loadLogsPage({
							...query,
							...attributeFilters,
							serviceName: query.service,
							lookbackMinutes: Duration.toMinutes(query.lookback),
							cursor: query.cursor,
						})
					}, Effect.orDie),
				)
				.handle(
					"searchLogs",
					Effect.fnUntraced(function* ({ query, request }) {
						const url = yield* HttpServerRequest.toURL(request)
						const attributeFilters = attributeFiltersFromQuery(url)
						const attributeContainsFilters =
							attributeContainsFiltersFromQuery(url)
						return yield* loadLogsPage({
							serviceName: query.service,
							severity: query.severity,
							traceId: query.traceId,
							spanId: query.spanId,
							body: query.body,
							attributeFilters,
							attributeContainsFilters,
							limit: query.limit,
							lookbackMinutes: Duration.toMinutes(query.lookback),
							cursor: query.cursor,
						})
					}, Effect.orDie),
				)
				.handle(
					"logStats",
					Effect.fnUntraced(function* ({ request, query }) {
						const url = yield* HttpServerRequest.toURL(request)
						const attributeFilters = attributeFiltersFromQuery(url)
						const data = yield* logQuery.logStats({
							...query,
							serviceName: query.service,
							attributeFilters,
							lookbackMinutes: Duration.toMinutes(query.lookback),
						})
						return { data }
					}, Effect.orDie),
				)
				.handle("docs", () =>
					Effect.succeed({
						docs: [
							{
								name: "debug",
								title: "Motel Debug Workflow",
								path: "/api/docs/debug",
							},
							{
								name: "effect",
								title: "Effect Instrumentation Guide",
								path: "/api/docs/effect",
							},
						],
					}),
				)
				.handle(
					"doc",
					Effect.fnUntraced(function* ({ params }) {
						const docFiles: Record<string, string> = {
							debug: path.resolve(
								import.meta.dir,
								"../skills/motel-debug/SKILL.md",
							),
							effect: path.resolve(
								import.meta.dir,
								"../skills/motel-debug/references/effect.md",
							),
						}
						const filePath = docFiles[params.name]
						if (!filePath)
							return yield* new NotFoundError({
								error: `Unknown doc: ${params.name}. Available: ${Object.keys(docFiles).join(", ")}`,
							})
						return yield* Effect.tryPromise(() =>
							fs.readFile(filePath, "utf8"),
						).pipe(
							Effect.mapError(
								() =>
									new NotFoundError({
										error: `Doc file not found: ${params.name}`,
									}),
							),
						)
					}),
				)
				.handle(
					"facets",
					Effect.fnUntraced(function* ({ query }) {
						const data = yield* traceQuery.listFacets({
							...query,
							serviceName: query.service,
							lookbackMinutes: Duration.toMinutes(query.lookback),
						})
						return { data }
					}, Effect.orDie),
				)
				.handle(
					"aiCalls",
					Effect.fnUntraced(function* ({ query }) {
						const lookbackMinutes = Duration.toMinutes(query.lookback)
						const data = yield* store.searchAiCalls({
							...query,
							lookbackMinutes,
						})
						return {
							data,
							meta: listMeta({
								limit: query.limit,
								lookbackMinutes,
								returned: data.length,
								truncated: false,
								nextCursor: null,
							}),
						}
					}, Effect.orDie),
				)
				.handle(
					"aiCall",
					Effect.fnUntraced(function* ({ params }) {
						const data = yield* store
							.getAiCall(params.spanId)
							.pipe(Effect.orDie)
						if (!data)
							return yield* new NotFoundError({ error: "AI call not found" })
						return { data }
					}),
				)
				.handle(
					"aiStats",
					Effect.fnUntraced(function* ({ query }) {
						const lookbackMinutes = Duration.toMinutes(query.lookback)
						const data = yield* store.aiCallStats({
							...query,
							lookbackMinutes,
						})
						return { data }
					}, Effect.orDie),
				)
				.handle(
					"tracePage",
					Effect.fnUntraced(function* ({ params }) {
						const trace = yield* traceQuery
							.getTrace(params.traceId)
							.pipe(Effect.orDie)
						if (!trace)
							return yield* new NotFoundError({ error: "Trace not found" })
						const logs = yield* logQuery
							.listTraceLogs(params.traceId)
							.pipe(Effect.orDie)
						return renderTracePage(trace, logs)
					}),
				)
		)
	}),
)

// ---------------------------------------------------------------------------
// App layer: HTTP router + static SPA + telemetry store
// ---------------------------------------------------------------------------

// API routes come from the Effect HttpApi definition. Everything under
// /api/*, /v1/*, /openapi.json, /docs is handled here.
const ApiLayer = HttpApiBuilder.layer(MotelHttpApi, {
	openapiPath: "/openapi.json",
}).pipe(
	Layer.provide(TelemetryGroupLive),
	Layer.provide(
		HttpApiScalar.layer(MotelHttpApi, {
			scalar: { forceDarkModeState: "dark", showOperationId: true },
		}),
	),
)

const QueryServicesLive = Layer.mergeAll(
	TraceQueryServiceLive,
	LogQueryServiceLive,
).pipe(Layer.provideMerge(TelemetryStoreReadonlyLive))

// Web UI: Vite-built SPA served from web/dist. HttpStaticServer.layer
// handles GET /*, filesystem lookup under `root`, and SPA fallback to
// index.html for unknown paths — replacing the hand-rolled serveWebUi
// wrapper that previously lived inline with Bun.serve. The API routes
// above take precedence because HttpApi registers specific paths that
// the router matches before falling through to the /* catch-all.
const WEB_DIST_DIR = path.resolve(import.meta.dir, "../web/dist")
const StaticLayer = HttpStaticServer.layer({
	root: WEB_DIST_DIR,
	spa: true,
})

// Registry-entry writer as a scoped acquisition. The entry is published
// after BunHttpServer.layer binds the socket (scope acquisition order)
// and removed on scope release, so a bind failure never leaves a zombie
// entry and a graceful shutdown cleans up alongside the server stop —
// both in the same finalizer chain managed by Layer.launch.
const RegistryLayer = Layer.effectDiscard(
	Effect.acquireRelease(
		Effect.sync(() => {
			serverStartedAt = new Date().toISOString()
			try {
				writeRegistryEntry({
					pid: process.pid,
					url: config.otel.baseUrl,
					workdir: process.cwd(),
					startedAt: serverStartedAt,
					version: MOTEL_VERSION,
					databasePath: config.otel.databasePath,
				})
			} catch (err) {
				console.warn(
					`motel: failed to write registry entry: ${(err as Error).message}`,
				)
			}
		}),
		() => Effect.sync(() => removeRegistryEntry(process.pid)),
	),
)

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Launchable server layer. Composes the API + static UI + store + registry,
 * wraps the whole stack in HttpMiddleware.tracer (per-request OTel spans
 * with http.method / url / status / user-agent attributes), and binds the
 * socket via @effect/platform-bun's BunHttpServer. Use from server.ts:
 *
 *   await Effect.runPromise(Layer.launch(ServerLive))
 *
 * Socket lifecycle, graceful shutdown, and error propagation are managed
 * by the BunHttpServer layer's Scope — no hand-rolled start/stop plumbing.
 * `reusePort: true` is retained as defense-in-depth against TIME_WAIT
 * rebind conflicts (the registry-based adoption path in daemon.ts is the
 * primary protection, but this covers a raw `bun src/server.ts` restart).
 */
export const ServerLive = HttpRouter.serve(
	Layer.mergeAll(ApiLayer, StaticLayer, RegistryLayer).pipe(
		Layer.provide(HttpRouter.cors({})),
	),
).pipe(
	// OTLP ingest paths are NOT traced by the middleware, otherwise
	// MOTEL_OTEL_ENABLED creates a feedback loop: every outbound span
	// POSTs to /v1/traces, the tracer emits a span for that POST, which
	// POSTs again on the next flush. This also shaves ~1 KB of header
	// attributes off every ingest request that would have been written
	// to the spans table as noise.
	Layer.provide(
		HttpMiddleware.layerTracerDisabledForUrls(["/v1/traces", "/v1/logs"]),
	),
	// AsyncIngest spawns the telemetry worker — keeps the main-thread
	// event loop free during heavy SQLite writes. Provided alongside
	// the writer TelemetryStore for ingest / maintenance. Query endpoints
	// resolve through readonly TraceQueryService / LogQueryService so
	// reads do not contend with the writer connection.
	Layer.provideMerge(AsyncIngestLive),
	Layer.provideMerge(QueryServicesLive),
	Layer.provideMerge(TelemetryStoreLive),
	Layer.provideMerge(
		BunHttpServer.layer({
			port: config.otel.port,
			hostname: config.otel.host,
			reusePort: true,
		}),
	),
)
