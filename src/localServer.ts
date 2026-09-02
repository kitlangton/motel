import path from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { config } from "./config.js"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpStaticServer from "effect/unstable/http/HttpStaticServer"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { MotelHttpApi } from "./httpApi.js"
import { AI_LIST, LOG_LIST, LOG_STATS, SPAN_LIST, TRACE_LIST, TRACE_STATS, listMeta, logCursorArgs, paginateLogs, paginateSummaries, parseLimit, parseListParams as decodeListParams, parseLookbackMinutes, requestUrl as decodeRequestUrl, traceCursorArgs, type ListBounds, type ListParams } from "./httpListPolicy.js"
import { MOTEL_SERVICE_ID, MOTEL_VERSION, processIdentity, removeRegistryEntry, writeRegistryEntry } from "./registry.js"
import { AsyncIngest, AsyncIngestLive } from "./services/AsyncIngest.js"
import { TelemetryStoreReadonly } from "./services/TelemetryStore.js"
import { TelemetryQueryLive } from "./services/TelemetryQuery.js"
import { decodeProtobufLogs, decodeProtobufTraces } from "./otlpProtobuf.js"
import type { OtlpLogExportRequest, OtlpTraceExportRequest } from "./otlp.js"

// Set by the RegistryLayer acquisition once the Bun socket has bound.
// Both /api/health and the registry entry read from here so they agree
// on a single server-start timestamp, and the value reflects actual
// listen time rather than module-evaluation time.
let serverStartedAt: string = new Date().toISOString()

const requestUrl = (request: { readonly url: string }) => decodeRequestUrl(request, config.otel.baseUrl)
const parseListParams = (request: { readonly url: string }, bounds: ListBounds) => decodeListParams(request, bounds, config.otel.baseUrl)

const jsonResponse = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status })
const textResponse = (value: string) => HttpServerResponse.text(value)
const notFoundResponse = (message = "Not found") => jsonResponse({ error: message }, 404)
const healthPayload = () => ({
	ok: true,
	service: MOTEL_SERVICE_ID,
	databasePath: config.otel.databasePath,
	pid: process.pid,
	url: config.otel.baseUrl,
	workdir: process.cwd(),
	startedAt: serverStartedAt,
	version: MOTEL_VERSION,
	instanceId: process.env.MOTEL_DAEMON_INSTANCE_ID?.trim(),
})
// Query handlers resolve against the readonly store identifier so they
// don't contend with the writer connection that owns ingest/retention.
const withRead = <A>(f: (store: TelemetryStoreReadonly["Service"]) => Effect.Effect<A, Error>) => Effect.flatMap(TelemetryStoreReadonly, f)
// Response-building helpers are generic in R so a handler can depend
// on AsyncIngest (worker-RPC path) or TelemetryStoreReadonly (query
// path) without forcing every handler onto the same service surface.
const respondJson = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
	Effect.match(effect, {
		onFailure: (error) => jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500),
		onSuccess: (value) => jsonResponse(value),
	})
const respondRaw = <R>(effect: Effect.Effect<ReturnType<typeof jsonResponse>, unknown, R>) =>
	Effect.match(effect, {
		onFailure: (error) => jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500),
		onSuccess: (value) => value,
	})

const readOtlpBody = <T>(
	request: {
		readonly json: Effect.Effect<unknown, unknown>
		readonly arrayBuffer: Effect.Effect<ArrayBuffer, unknown>
		readonly headers: Readonly<Record<string, string | undefined>>
	},
	decodeProtobuf: (bytes: Uint8Array) => T,
): Effect.Effect<T, unknown> => {
	const contentType = (request.headers["content-type"] ?? "").toLowerCase()
	if (contentType.includes("application/x-protobuf") || contentType.includes("application/protobuf")) {
		return Effect.map(request.arrayBuffer, (buffer) => decodeProtobuf(new Uint8Array(buffer)))
	}
	return Effect.map(request.json, (payload) => payload as T)
}

// Log page loader: takes the parsed list params + any resource-specific
// filter values (service, severity, traceId, spanId, body), runs the
// store query with limit+1 to detect a next page, and shapes the
// paginated response.
const loadLogsPage = (
	params: ListParams,
	filters: { readonly serviceName?: string | null; readonly severity?: string | null; readonly traceId?: string | null; readonly spanId?: string | null; readonly body?: string | null },
) =>
	Effect.map(
		withRead((store) => store.searchLogs({
			...filters,
			...logCursorArgs(params.cursor),
			attributeFilters: params.attributeFilters,
			attributeContainsFilters: params.attributeContainsFilters,
			lookbackMinutes: params.lookbackMinutes,
			limit: params.limit + 1,
		})),
		(logs) => paginateLogs(logs, params),
	)

const handleLogSearch = (request: { readonly url: string }) =>
	respondRaw(Effect.gen(function*() {
		const params = parseListParams(request, LOG_LIST)
		return jsonResponse(yield* loadLogsPage(params, {
			serviceName: params.url.searchParams.get("service"),
			severity: params.url.searchParams.get("severity"),
			traceId: params.url.searchParams.get("traceId"),
			spanId: params.url.searchParams.get("spanId"),
			body: params.url.searchParams.get("body"),
		}))
	}))

const TelemetryGroupLive = HttpApiBuilder.group(
	MotelHttpApi,
	"telemetry",
	(handlers) =>
		handlers
			.handleRaw("root", () =>
				Effect.succeed(textResponse("motel local telemetry server\n\nPOST /v1/traces\nPOST /v1/logs\nGET /api/services\nGET /api/traces\nGET /api/traces/search\nGET /api/traces/stats\nGET /api/traces/<trace-id>\nGET /api/traces/<trace-id>/spans\nGET /api/traces/<trace-id>/logs\nGET /api/spans/search\nGET /api/spans/<span-id>\nGET /api/spans/<span-id>/logs\nGET /api/logs\nGET /api/logs/search\nGET /api/logs/stats\nGET /api/ai/calls\nGET /api/ai/calls/<span-id>\nGET /api/ai/stats\nGET /api/facets?type=logs&field=severity\nGET /api/docs\nGET /api/docs/<name>\nGET /openapi.json\nGET /docs\n")),
			)
			.handle("health", () =>
				HttpMiddleware.withLoggerDisabled(Effect.succeed(healthPayload())),
			)
			// OTLP ingest is routed to the worker thread via AsyncIngest
			// so the main event loop stays free during heavy SQLite writes.
			// Read queries use a separate query worker so synchronous SQLite
			// work cannot block the HTTP event loop.
			.handleRaw("ingestTraces", ({ request }) =>
				HttpMiddleware.withLoggerDisabled(respondRaw(
					Effect.flatMap(
						readOtlpBody<OtlpTraceExportRequest>(request, decodeProtobufTraces),
						(payload) => Effect.map(
							Effect.flatMap(AsyncIngest, (ingest) => ingest.ingestTraces({ payload })),
							(result) => jsonResponse(result),
						),
					),
				)),
			)
			.handleRaw("ingestLogs", ({ request }) =>
				HttpMiddleware.withLoggerDisabled(respondRaw(
					Effect.flatMap(
						readOtlpBody<OtlpLogExportRequest>(request, decodeProtobufLogs),
						(payload) => Effect.map(
							Effect.flatMap(AsyncIngest, (ingest) => ingest.ingestLogs({ payload })),
							(result) => jsonResponse(result),
						),
					),
				)),
			)
			.handleRaw("services", () => respondJson(Effect.map(withRead((store) => store.listServices), (data) => ({ data }))))
			.handleRaw("traces", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, TRACE_LIST)
					const data = yield* withRead((store) => store.listTraceSummaries(params.url.searchParams.get("service"), {
						limit: params.limit + 1,
						lookbackMinutes: params.lookbackMinutes,
						...traceCursorArgs(params.cursor),
					}))
					return jsonResponse(paginateSummaries(data, params))
				})),
			)
			.handleRaw("searchTraces", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, TRACE_LIST)
					const data = yield* withRead((store) =>
						store.searchTraceSummaries({
							serviceName: params.url.searchParams.get("service"),
							operation: params.url.searchParams.get("operation"),
							status: (params.url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: params.url.searchParams.get("minDurationMs") ? Number.parseFloat(params.url.searchParams.get("minDurationMs") ?? "") : null,
							attributeFilters: params.attributeFilters,
							aiText: params.url.searchParams.get("aiText"),
							limit: params.limit + 1,
							lookbackMinutes: params.lookbackMinutes,
							...traceCursorArgs(params.cursor),
						}),
					)
					return jsonResponse(paginateSummaries(data, params))
				})),
			)
			.handleRaw("traceStats", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, TRACE_STATS)
					const groupBy = params.url.searchParams.get("groupBy")
					const agg = params.url.searchParams.get("agg")
					if (!groupBy || (agg !== "count" && agg !== "avg_duration" && agg !== "p95_duration" && agg !== "error_rate")) {
						return jsonResponse({ error: "Expected groupBy and agg=count|avg_duration|p95_duration|error_rate" }, 400)
					}
					const data = yield* withRead((store) =>
						store.traceStats({
							groupBy,
							agg,
							serviceName: params.url.searchParams.get("service"),
							operation: params.url.searchParams.get("operation"),
							status: (params.url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: params.url.searchParams.get("minDurationMs") ? Number.parseFloat(params.url.searchParams.get("minDurationMs") ?? "") : null,
							attributeFilters: params.attributeFilters,
							limit: params.limit,
							lookbackMinutes: params.lookbackMinutes,
						}),
					)
					return jsonResponse({ data })
				})),
			)
			.handleRaw("searchSpans", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, SPAN_LIST)
					const data = yield* withRead((store) =>
						store.searchSpans({
							serviceName: params.url.searchParams.get("service"),
							traceId: params.url.searchParams.get("traceId"),
							operation: params.url.searchParams.get("operation"),
							parentOperation: params.url.searchParams.get("parentOperation"),
							status: (params.url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							attributeFilters: params.attributeFilters,
							attributeContainsFilters: params.attributeContainsFilters,
							limit: params.limit + 1,
							lookbackMinutes: params.lookbackMinutes,
						}),
					)
					const truncated = data.length > params.limit
					const page = truncated ? data.slice(0, params.limit) : data
					return jsonResponse({
						data: page,
						meta: listMeta({
							limit: params.limit,
							lookbackMinutes: params.lookbackMinutes,
							returned: page.length,
							truncated,
							nextCursor: null,
						}),
					})
				})),
			)
			.handleRaw("traceLogs", ({ params: route, request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, LOG_LIST)
					return jsonResponse(yield* loadLogsPage(params, { traceId: route.traceId }))
				})),
			)
			.handleRaw("traceSpans", ({ params }) =>
				respondJson(Effect.map(withRead((store) => store.listTraceSpans(params.traceId)), (data) => ({ data }))),
			)
			.handleRaw("spanLogs", ({ params: route, request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, LOG_LIST)
					return jsonResponse(yield* loadLogsPage(params, { spanId: route.spanId }))
				})),
			)
			.handleRaw("span", ({ params }) =>
				respondRaw(
					Effect.flatMap(withRead((store) => store.getSpan(params.spanId)), (data) =>
						Effect.succeed(data ? jsonResponse({ data }) : notFoundResponse("Span not found")),
					),
				),
			)
			.handleRaw("trace", ({ params }) =>
				respondRaw(
					Effect.flatMap(withRead((store) => store.getTrace(params.traceId)), (data) =>
						Effect.succeed(data ? jsonResponse({ data }) : notFoundResponse("Trace not found")),
					),
				),
			)
			.handleRaw("logs", ({ request }) => handleLogSearch(request))
			.handleRaw("searchLogs", ({ request }) => handleLogSearch(request))
			.handleRaw("logStats", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, LOG_STATS)
					const groupBy = params.url.searchParams.get("groupBy")
					const agg = params.url.searchParams.get("agg")
					if (!groupBy || agg !== "count") {
						return jsonResponse({ error: "Expected groupBy and agg=count" }, 400)
					}
					const data = yield* withRead((store) =>
						store.logStats({
							groupBy,
							agg: "count",
							serviceName: params.url.searchParams.get("service"),
							traceId: params.url.searchParams.get("traceId"),
							spanId: params.url.searchParams.get("spanId"),
							body: params.url.searchParams.get("body"),
							attributeFilters: params.attributeFilters,
							limit: params.limit,
							lookbackMinutes: params.lookbackMinutes,
						}),
					)
					return jsonResponse({ data })
				})),
			)
			.handle("docs", () =>
				Effect.succeed({
					docs: [
						{ name: "debug", title: "Motel Debug Workflow", path: "/api/docs/debug" },
						{ name: "effect", title: "Effect Instrumentation Guide", path: "/api/docs/effect" },
					],
				}),
			)
			.handleRaw("doc", ({ params }) =>
				respondRaw(Effect.gen(function*() {
					const fileSystem = yield* FileSystem.FileSystem
					const docFiles: Record<string, string> = {
						debug: path.resolve(import.meta.dir, "../skills/motel-debug/SKILL.md"),
						effect: path.resolve(import.meta.dir, "../skills/motel-debug/references/effect.md"),
					}
					const filePath = docFiles[params.name]
					if (!filePath) return notFoundResponse(`Unknown doc: ${params.name}. Available: ${Object.keys(docFiles).join(", ")}`)
					return yield* fileSystem.readFileString(filePath).pipe(
						Effect.map(textResponse),
						Effect.catch(() => Effect.succeed(notFoundResponse(`Doc file not found: ${params.name}`))),
					)
				})),
			)
			.handleRaw("facets", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const type = url.searchParams.get("type")
					const field = url.searchParams.get("field")
					if ((type !== "traces" && type !== "logs") || !field) {
						return jsonResponse({ error: "Expected type=traces|logs and field=<name>" }, 400)
					}
					const data = yield* withRead((store) =>
						store.listFacets({
							type,
							field,
							serviceName: url.searchParams.get("service"),
							key: url.searchParams.get("key"),
							lookbackMinutes: parseLookbackMinutes(url.searchParams.get("lookback"), config.otel.traceLookbackMinutes),
							limit: parseLimit(url.searchParams.get("limit"), 20),
						}),
					)
					return jsonResponse({ data })
				})),
			)
			.handleRaw("aiCalls", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, AI_LIST)
					const data = yield* withRead((store) =>
						store.searchAiCalls({
							service: params.url.searchParams.get("service"),
							traceId: params.url.searchParams.get("traceId"),
							sessionId: params.url.searchParams.get("sessionId"),
							functionId: params.url.searchParams.get("functionId"),
							provider: params.url.searchParams.get("provider"),
							model: params.url.searchParams.get("model"),
							operation: params.url.searchParams.get("operation"),
							status: (params.url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: params.url.searchParams.get("minDurationMs") ? Number(params.url.searchParams.get("minDurationMs")) : null,
							text: params.url.searchParams.get("text"),
							lookbackMinutes: params.lookbackMinutes,
							limit: params.limit,
						}),
					)
					return jsonResponse({
						data,
						meta: listMeta({ limit: params.limit, lookbackMinutes: params.lookbackMinutes, returned: data.length, truncated: false, nextCursor: null }),
					})
				})),
			)
			.handleRaw("aiCall", ({ params }) =>
				respondRaw(Effect.gen(function*() {
					const data = yield* withRead((store) => store.getAiCall(params.spanId))
					if (!data) return notFoundResponse("AI call not found")
					return jsonResponse({ data })
				})),
			)
			.handleRaw("aiStats", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const params = parseListParams(request, AI_LIST)
					const groupBy = params.url.searchParams.get("groupBy") as "provider" | "model" | "functionId" | "sessionId" | "status" | null
					const agg = params.url.searchParams.get("agg") as "count" | "avg_duration" | "p95_duration" | "total_input_tokens" | "total_output_tokens" | null
					if (!groupBy || !agg) {
						return jsonResponse({ error: "Expected groupBy and agg parameters" }, 400)
					}
					const data = yield* withRead((store) =>
						store.aiCallStats({
							groupBy,
							agg,
							service: params.url.searchParams.get("service"),
							traceId: params.url.searchParams.get("traceId"),
							sessionId: params.url.searchParams.get("sessionId"),
							functionId: params.url.searchParams.get("functionId"),
							provider: params.url.searchParams.get("provider"),
							model: params.url.searchParams.get("model"),
							operation: params.url.searchParams.get("operation"),
							status: (params.url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: params.url.searchParams.get("minDurationMs") ? Number(params.url.searchParams.get("minDurationMs")) : null,
							lookbackMinutes: params.lookbackMinutes,
							limit: params.limit,
						}),
					)
					return jsonResponse({ data })
				})),
			),
)

// ---------------------------------------------------------------------------
// App layer: HTTP router + static SPA + telemetry store
// ---------------------------------------------------------------------------

// API routes come from the Effect HttpApi definition. Everything under
// /api/*, /v1/*, /openapi.json, /docs is handled here.
const ApiLayer = HttpApiBuilder.layer(MotelHttpApi, { openapiPath: "/openapi.json" }).pipe(
	Layer.provide(TelemetryGroupLive),
	Layer.provide(HttpApiScalar.layer(MotelHttpApi, { scalar: { forceDarkModeState: "dark", showOperationId: true } })),
)

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
					instanceId: process.env.MOTEL_DAEMON_INSTANCE_ID?.trim(),
					processIdentity: processIdentity(process.pid) ?? undefined,
				})
			} catch (err) {
				console.warn(`motel: failed to write registry entry: ${(err as Error).message}`)
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
	Layer.mergeAll(ApiLayer, StaticLayer, RegistryLayer),
	{ middleware: HttpMiddleware.tracer },
).pipe(
	// OTLP ingest paths are NOT traced by the middleware, otherwise
	// MOTEL_OTEL_ENABLED creates a feedback loop: every outbound span
	// POSTs to /v1/traces, the tracer emits a span for that POST, which
	// POSTs again on the next flush. This also shaves ~1 KB of header
	// attributes off every ingest request that would have been written
	// to the spans table as noise.
	Layer.provide(HttpMiddleware.layerTracerDisabledForUrls(["/api/health", "/v1/traces", "/v1/logs"])),
	// The telemetry worker owns ingest, migrations, and bounded maintenance.
	// The HTTP thread only opens an existing database read-only (or bootstraps
	// a brand-new empty one), keeping health independent of writer work.
	Layer.provideMerge(AsyncIngestLive),
	Layer.provideMerge(TelemetryQueryLive),
	Layer.provideMerge(BunHttpServer.layer({
		port: config.otel.port,
		hostname: config.otel.host,
		reusePort: true,
		routes: {
			"/api/health": () => Response.json(healthPayload()),
		},
	})),
)
