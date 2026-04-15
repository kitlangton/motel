import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect, Layer, ServiceMap } from "effect"
import { config, parsePositiveInt, resolveOtelUrl } from "./config.js"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { MotelHttpApi } from "./httpApi.js"
import { attributeFiltersFromEntries, attributeContainsFiltersFromEntries, ATTRIBUTE_FILTER_PREFIX, ATTRIBUTE_CONTAINS_PREFIX } from "./queryFilters.js"
import { MOTEL_SERVICE_ID, MOTEL_VERSION, writeRegistryEntry } from "./registry.js"
import { TelemetryStore, TelemetryStoreLive } from "./services/TelemetryStore.js"
import type { LogItem, TraceItem, TraceSummaryItem } from "./domain.js"

const TRACE_DEFAULT_LIMIT = 20
const TRACE_MAX_LIMIT = 100
const TRACE_DEFAULT_LOOKBACK = 60
const TRACE_MAX_LOOKBACK = 24 * 60
const SPAN_DEFAULT_LIMIT = 100
const SPAN_MAX_LIMIT = 500
const LOG_DEFAULT_LIMIT = 100
const LOG_MAX_LIMIT = 500
const LOG_DEFAULT_LOOKBACK = 60
const LOG_MAX_LOOKBACK = 24 * 60

let server: ReturnType<typeof Bun.serve> | null = null
let disposeWebHandler: (() => Promise<void>) | null = null
let startedAt: string | null = null

const resolveBoundUrl = () => {
	if (!server) return config.otel.queryUrl
	const host = server.hostname === "0.0.0.0" || server.hostname === "::" ? "127.0.0.1" : server.hostname
	return `http://${host}:${server.port}`
}

const jsonResponse = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status })
const textResponse = (value: string) => HttpServerResponse.text(value)
const htmlResponse = (value: string) => HttpServerResponse.html(value)
const notFoundResponse = (message = "Not found") => jsonResponse({ error: message }, 404)
const requestUrl = (request: { readonly url: string }) => new URL(request.url, config.otel.baseUrl)
const withStore = <A>(f: (store: TelemetryStore["Service"]) => Effect.Effect<A, Error>) => Effect.flatMap(TelemetryStore.asEffect(), f)
const respondJson = <A>(effect: Effect.Effect<A, unknown, TelemetryStore>) =>
	Effect.match(effect, {
		onFailure: (error) => jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500),
		onSuccess: (value) => jsonResponse(value),
	})
const respondRaw = (effect: Effect.Effect<ReturnType<typeof jsonResponse>, unknown, TelemetryStore>) =>
	Effect.match(effect, {
		onFailure: (error) => jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500),
		onSuccess: (value) => value,
	})

const parseLimit = (value: string | null, fallback: number) => parsePositiveInt(value ?? undefined, fallback)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))
const parseBoundedLimit = (value: string | null, fallback: number, max: number) => clamp(parseLimit(value, fallback), 1, max)

const parseLookbackMinutes = (value: string | null, fallback: number) => {
	if (!value) return fallback
	const match = value.trim().match(/^(\d+)([mhd])$/i)
	if (!match) return fallback
	const amount = Number.parseInt(match[1] ?? "", 10)
	if (!Number.isFinite(amount) || amount <= 0) return fallback
	const unit = (match[2] ?? "m").toLowerCase()
	if (unit === "d") return amount * 1440
	if (unit === "h") return amount * 60
	return amount
}

const parseBoundedLookbackMinutes = (value: string | null, fallback: number, max: number) => clamp(parseLookbackMinutes(value, fallback), 1, max)

const attributeFiltersFromQuery = (url: URL) =>
	attributeFiltersFromEntries(
		[...url.searchParams.entries()].filter(([key]) => key.startsWith(ATTRIBUTE_FILTER_PREFIX) && !key.startsWith(ATTRIBUTE_CONTAINS_PREFIX)),
	)

const attributeContainsFiltersFromQuery = (url: URL) =>
	attributeContainsFiltersFromEntries(
		[...url.searchParams.entries()].filter(([key]) => key.startsWith(ATTRIBUTE_CONTAINS_PREFIX)),
	)

type CursorShape =
	| { readonly kind: "trace"; readonly startedAt: number; readonly id: string }
	| { readonly kind: "log"; readonly timestamp: number; readonly id: string }

const encodeCursor = (cursor: CursorShape) => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")

const decodeCursor = (value: string | null): CursorShape | null => {
	if (!value) return null
	try {
		return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorShape
	} catch {
		return null
	}
}

const formatLookback = (minutes: number) => {
	if (minutes % 1440 === 0) return `${minutes / 1440}d`
	if (minutes % 60 === 0) return `${minutes / 60}h`
	return `${minutes}m`
}

const listMeta = (input: { readonly limit: number; readonly lookbackMinutes: number; readonly returned: number; readonly truncated: boolean; readonly nextCursor: string | null }) => ({
	limit: input.limit,
	lookback: formatLookback(input.lookbackMinutes),
	returned: input.returned,
	truncated: input.truncated,
	nextCursor: input.nextCursor,
})

const paginateSummaries = (summaries: readonly TraceSummaryItem[], options: { readonly limit: number; readonly lookbackMinutes: number; readonly cursor: CursorShape | null }) => {
	const page = summaries.slice(0, options.limit)
	const last = page.at(-1)
	return {
		data: page,
		meta: listMeta({
			limit: options.limit,
			lookbackMinutes: options.lookbackMinutes,
			returned: page.length,
			truncated: summaries.length > page.length,
			nextCursor: last ? encodeCursor({ kind: "trace", startedAt: last.startedAt.getTime(), id: last.traceId }) : null,
		}),
	}
}

const paginateLogs = (logs: readonly LogItem[], options: { readonly limit: number; readonly lookbackMinutes: number; readonly cursor: CursorShape | null }) => {
	const page = logs.slice(0, options.limit)
	const last = page.at(-1)

	return {
		data: page,
		meta: listMeta({
			limit: options.limit,
			lookbackMinutes: options.lookbackMinutes,
			returned: page.length,
			truncated: logs.length > page.length,
			nextCursor: last ? encodeCursor({ kind: "log", timestamp: last.timestamp.getTime(), id: last.id }) : null,
		}),
	}
}

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
	readonly cursor: CursorShape | null
}) =>
	Effect.flatMap(TelemetryStore.asEffect(), (store) =>
		Effect.map(
			store.searchLogs({
				serviceName: input.serviceName,
				severity: input.severity,
				traceId: input.traceId,
				spanId: input.spanId,
				body: input.body,
				lookbackMinutes: input.lookbackMinutes,
				limit: input.limit + 1,
				cursorTimestampMs: input.cursor?.kind === "log" ? input.cursor.timestamp : undefined,
				cursorId: input.cursor?.kind === "log" ? input.cursor.id : undefined,
				attributeFilters: input.attributeFilters,
				attributeContainsFilters: input.attributeContainsFilters,
			}),
			(logs) => paginateLogs(logs, {
				limit: input.limit,
				lookbackMinutes: input.lookbackMinutes,
				cursor: input.cursor,
			}),
		),
	)

const handleLogSearch = (request: { readonly url: string }) =>
	respondRaw(Effect.gen(function*() {
		const url = requestUrl(request)
		const attributeFilters = attributeFiltersFromQuery(url)
		const attributeContainsFilters = attributeContainsFiltersFromQuery(url)
		const limit = parseBoundedLimit(url.searchParams.get("limit"), LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT)
		const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), LOG_DEFAULT_LOOKBACK, LOG_MAX_LOOKBACK)
		const cursor = decodeCursor(url.searchParams.get("cursor"))
		return jsonResponse(yield* loadLogsPage({
			serviceName: url.searchParams.get("service"),
			severity: url.searchParams.get("severity"),
			traceId: url.searchParams.get("traceId"),
			spanId: url.searchParams.get("spanId"),
			body: url.searchParams.get("body"),
			attributeFilters,
			attributeContainsFilters,
			limit,
			lookbackMinutes,
			cursor,
		}))
	}))

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
<p class="muted">${escapeHtml(trace.serviceName)} · ${trace.durationMs.toFixed(2)}ms · ${trace.spanCount} spans · ${logs.length} logs</p>
<p class="muted">${escapeHtml(trace.traceId)}</p>
<h2>Spans</h2>
<table>
<thead><tr><th>Operation</th><th>Service</th><th>Status</th><th>Duration</th><th>Logs</th></tr></thead>
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
	(handlers) =>
		handlers
			.handleRaw("root", () =>
				Effect.succeed(textResponse("motel local telemetry server\n\nPOST /v1/traces\nPOST /v1/logs\nGET /api/services\nGET /api/traces\nGET /api/traces/search\nGET /api/traces/stats\nGET /api/traces/<trace-id>\nGET /api/traces/<trace-id>/spans\nGET /api/traces/<trace-id>/logs\nGET /api/spans/search\nGET /api/spans/<span-id>\nGET /api/spans/<span-id>/logs\nGET /api/logs\nGET /api/logs/search\nGET /api/logs/stats\nGET /api/ai/calls\nGET /api/ai/calls/<span-id>\nGET /api/ai/stats\nGET /api/facets?type=logs&field=severity\nGET /api/docs\nGET /api/docs/<name>\nGET /openapi.json\nGET /docs\nGET /trace/<trace-id>\n")),
			)
			.handle("health", () =>
				Effect.succeed({
					ok: true,
					service: MOTEL_SERVICE_ID,
					databasePath: config.otel.databasePath,
					pid: process.pid,
					url: resolveBoundUrl(),
					workdir: process.cwd(),
					startedAt: startedAt ?? new Date(0).toISOString(),
					version: MOTEL_VERSION,
				}),
			)
			.handleRaw("ingestTraces", ({ request }) =>
				respondRaw(
					Effect.flatMap(request.json, (payload) =>
						Effect.map(withStore((store) => store.ingestTraces(payload as any)), (result) => jsonResponse(result)),
					),
				),
			)
			.handleRaw("ingestLogs", ({ request }) =>
				respondRaw(
					Effect.flatMap(request.json, (payload) =>
						Effect.map(withStore((store) => store.ingestLogs(payload as any)), (result) => jsonResponse(result)),
					),
				),
			)
			.handleRaw("services", () => respondJson(Effect.map(withStore((store) => store.listServices), (data) => ({ data }))))
			.handleRaw("traces", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const service = url.searchParams.get("service")
					const limit = parseBoundedLimit(url.searchParams.get("limit"), TRACE_DEFAULT_LIMIT, TRACE_MAX_LIMIT)
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
					const cursor = decodeCursor(url.searchParams.get("cursor"))
					const data = yield* withStore((store) => store.listTraceSummaries(service, {
						limit: limit + 1,
						lookbackMinutes,
						cursorStartedAtMs: cursor?.kind === "trace" ? cursor.startedAt : undefined,
						cursorTraceId: cursor?.kind === "trace" ? cursor.id : undefined,
					}))
					return jsonResponse(paginateSummaries(data, { limit, lookbackMinutes, cursor }))
				})),
			)
			.handleRaw("searchTraces", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const attributeFilters = attributeFiltersFromQuery(url)
					const limit = parseBoundedLimit(url.searchParams.get("limit"), TRACE_DEFAULT_LIMIT, TRACE_MAX_LIMIT)
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
					const cursor = decodeCursor(url.searchParams.get("cursor"))
					const data = yield* withStore((store) =>
						store.searchTraceSummaries({
							serviceName: url.searchParams.get("service"),
							operation: url.searchParams.get("operation"),
							status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: url.searchParams.get("minDurationMs") ? Number.parseFloat(url.searchParams.get("minDurationMs") ?? "") : null,
							attributeFilters,
							limit: limit + 1,
							lookbackMinutes,
							cursorStartedAtMs: cursor?.kind === "trace" ? cursor.startedAt : undefined,
							cursorTraceId: cursor?.kind === "trace" ? cursor.id : undefined,
						}),
					)
					return jsonResponse(paginateSummaries(data, { limit, lookbackMinutes, cursor }))
				})),
			)
			.handleRaw("traceStats", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const attributeFilters = attributeFiltersFromQuery(url)
					const groupBy = url.searchParams.get("groupBy")
					const agg = url.searchParams.get("agg")
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
					if (!groupBy || (agg !== "count" && agg !== "avg_duration" && agg !== "p95_duration" && agg !== "error_rate")) {
						return jsonResponse({ error: "Expected groupBy and agg=count|avg_duration|p95_duration|error_rate" }, 400)
					}
					const data = yield* withStore((store) =>
						store.traceStats({
							groupBy,
							agg,
							serviceName: url.searchParams.get("service"),
							operation: url.searchParams.get("operation"),
							status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: url.searchParams.get("minDurationMs") ? Number.parseFloat(url.searchParams.get("minDurationMs") ?? "") : null,
							attributeFilters,
							limit: parseBoundedLimit(url.searchParams.get("limit"), 20, TRACE_MAX_LIMIT),
							lookbackMinutes,
						}),
					)
					return jsonResponse({ data })
				})),
			)
			.handleRaw("searchSpans", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const attributeFilters = attributeFiltersFromQuery(url)
					const attributeContainsFilters = attributeContainsFiltersFromQuery(url)
					const limit = parseBoundedLimit(url.searchParams.get("limit"), SPAN_DEFAULT_LIMIT, SPAN_MAX_LIMIT)
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
					const data = yield* withStore((store) =>
						store.searchSpans({
							serviceName: url.searchParams.get("service"),
							traceId: url.searchParams.get("traceId"),
							operation: url.searchParams.get("operation"),
							parentOperation: url.searchParams.get("parentOperation"),
							status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							attributeFilters,
							attributeContainsFilters,
							limit: limit + 1,
							lookbackMinutes,
						}),
					)
					const truncated = data.length > limit
					const page = truncated ? data.slice(0, limit) : data
					return jsonResponse({
						data: page,
						meta: listMeta({
							limit,
							lookbackMinutes,
							returned: page.length,
							truncated,
							nextCursor: null,
						}),
					})
				})),
			)
			.handleRaw("traceLogs", ({ params, request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), LOG_DEFAULT_LOOKBACK, LOG_MAX_LOOKBACK)
					const limit = parseBoundedLimit(url.searchParams.get("limit"), LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT)
					const cursor = decodeCursor(url.searchParams.get("cursor"))
					return jsonResponse(yield* loadLogsPage({ traceId: params.traceId, limit, lookbackMinutes, cursor }))
				})),
			)
			.handleRaw("traceSpans", ({ params }) =>
				respondJson(Effect.map(withStore((store) => store.listTraceSpans(params.traceId)), (data) => ({ data }))),
			)
			.handleRaw("spanLogs", ({ params, request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), LOG_DEFAULT_LOOKBACK, LOG_MAX_LOOKBACK)
					const limit = parseBoundedLimit(url.searchParams.get("limit"), LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT)
					const cursor = decodeCursor(url.searchParams.get("cursor"))
					return jsonResponse(yield* loadLogsPage({ spanId: params.spanId, limit, lookbackMinutes, cursor }))
				})),
			)
			.handleRaw("span", ({ params }) =>
				respondRaw(
					Effect.flatMap(withStore((store) => store.getSpan(params.spanId)), (data) =>
						Effect.succeed(data ? jsonResponse({ data }) : notFoundResponse("Span not found")),
					),
				),
			)
			.handleRaw("trace", ({ params }) =>
				respondRaw(
					Effect.flatMap(withStore((store) => store.getTrace(params.traceId)), (data) =>
						Effect.succeed(data ? jsonResponse({ data }) : notFoundResponse("Trace not found")),
					),
				),
			)
			.handleRaw("logs", ({ request }) => handleLogSearch(request))
			.handleRaw("searchLogs", ({ request }) => handleLogSearch(request))
			.handleRaw("logStats", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const attributeFilters = attributeFiltersFromQuery(url)
					const groupBy = url.searchParams.get("groupBy")
					const agg = url.searchParams.get("agg")
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), LOG_DEFAULT_LOOKBACK, LOG_MAX_LOOKBACK)
					if (!groupBy || agg !== "count") {
						return jsonResponse({ error: "Expected groupBy and agg=count" }, 400)
					}
					const data = yield* withStore((store) =>
						store.logStats({
							groupBy,
							agg: "count",
							serviceName: url.searchParams.get("service"),
							traceId: url.searchParams.get("traceId"),
							spanId: url.searchParams.get("spanId"),
							body: url.searchParams.get("body"),
							attributeFilters,
							limit: parseBoundedLimit(url.searchParams.get("limit"), 20, LOG_MAX_LIMIT),
							lookbackMinutes,
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
					const docFiles: Record<string, string> = {
						debug: path.resolve(import.meta.dir, "../skills/motel-debug/SKILL.md"),
						effect: path.resolve(import.meta.dir, "../skills/motel-debug/references/effect.md"),
					}
					const filePath = docFiles[params.name]
					if (!filePath) return notFoundResponse(`Unknown doc: ${params.name}. Available: ${Object.keys(docFiles).join(", ")}`)
					try {
						const content = yield* Effect.promise(() => fs.readFile(filePath, "utf8"))
						return textResponse(content)
					} catch {
						return notFoundResponse(`Doc file not found: ${params.name}`)
					}
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
					const data = yield* withStore((store) =>
						store.listFacets({
							type,
							field,
							serviceName: url.searchParams.get("service"),
							lookbackMinutes: parseLookbackMinutes(url.searchParams.get("lookback"), config.otel.traceLookbackMinutes),
							limit: parseLimit(url.searchParams.get("limit"), 20),
						}),
					)
					return jsonResponse({ data })
				})),
			)
			.handleRaw("aiCalls", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const limit = parseBoundedLimit(url.searchParams.get("limit"), 20, SPAN_MAX_LIMIT)
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
					const data = yield* withStore((store) =>
						store.searchAiCalls({
							service: url.searchParams.get("service"),
							traceId: url.searchParams.get("traceId"),
							sessionId: url.searchParams.get("sessionId"),
							functionId: url.searchParams.get("functionId"),
							provider: url.searchParams.get("provider"),
							model: url.searchParams.get("model"),
							operation: url.searchParams.get("operation"),
							status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: url.searchParams.get("minDurationMs") ? Number(url.searchParams.get("minDurationMs")) : null,
							text: url.searchParams.get("text"),
							lookbackMinutes,
							limit,
						}),
					)
					return jsonResponse({
						data,
						meta: listMeta({ limit, lookbackMinutes, returned: data.length, truncated: false, nextCursor: null }),
					})
				})),
			)
			.handleRaw("aiCall", ({ params }) =>
				respondRaw(Effect.gen(function*() {
					const data = yield* withStore((store) => store.getAiCall(params.spanId))
					if (!data) return notFoundResponse("AI call not found")
					return jsonResponse({ data })
				})),
			)
			.handleRaw("aiStats", ({ request }) =>
				respondRaw(Effect.gen(function*() {
					const url = requestUrl(request)
					const groupBy = url.searchParams.get("groupBy") as "provider" | "model" | "functionId" | "sessionId" | "status" | null
					const agg = url.searchParams.get("agg") as "count" | "avg_duration" | "p95_duration" | "total_input_tokens" | "total_output_tokens" | null
					if (!groupBy || !agg) {
						return jsonResponse({ error: "Expected groupBy and agg parameters" }, 400)
					}
					const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
					const data = yield* withStore((store) =>
						store.aiCallStats({
							groupBy,
							agg,
							service: url.searchParams.get("service"),
							traceId: url.searchParams.get("traceId"),
							sessionId: url.searchParams.get("sessionId"),
							functionId: url.searchParams.get("functionId"),
							provider: url.searchParams.get("provider"),
							model: url.searchParams.get("model"),
							operation: url.searchParams.get("operation"),
							status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
							minDurationMs: url.searchParams.get("minDurationMs") ? Number(url.searchParams.get("minDurationMs")) : null,
							lookbackMinutes,
							limit: parseBoundedLimit(url.searchParams.get("limit"), 20, SPAN_MAX_LIMIT),
						}),
					)
					return jsonResponse({ data })
				})),
			)
			.handleRaw("tracePage", ({ params }) =>
				respondRaw(
					Effect.flatMap(withStore((store) => store.getTrace(params.traceId)), (trace) =>
						trace
							? Effect.map(withStore((store) => store.listTraceLogs(params.traceId)), (logs) => htmlResponse(renderTracePage(trace, logs)))
							: Effect.succeed(notFoundResponse("Trace not found")),
					),
				),
			),
)

const ApiLive = Layer.provideMerge(
	HttpApiBuilder.layer(MotelHttpApi, { openapiPath: "/openapi.json" }).pipe(
		Layer.provide(TelemetryGroupLive),
		Layer.provide(HttpApiScalar.layer(MotelHttpApi, { scalar: { forceDarkModeState: "dark", showOperationId: true } })),
		Layer.provide(HttpServer.layerServices),
	),
	TelemetryStoreLive,
)

export const startLocalServer = async () => {
	if (server) return server
	const { handler, dispose } = HttpRouter.toWebHandler(ApiLive, { disableLogger: true })
	disposeWebHandler = dispose
	server = Bun.serve({
		hostname: config.otel.host,
		port: config.otel.port,
		fetch(request) {
			return handler(request)
		},
	})
	startedAt = new Date().toISOString()
	try {
		writeRegistryEntry({
			pid: process.pid,
			url: resolveBoundUrl(),
			workdir: process.cwd(),
			startedAt,
			version: MOTEL_VERSION,
		})
	} catch (err) {
		console.warn(`motel: failed to write registry entry: ${(err as Error).message}`)
	}
	return server
}

export const ensureLocalServer = async () => {
	if (server) return server
	try {
		const response = await fetch(resolveOtelUrl("/api/health"), { signal: AbortSignal.timeout(250) })
		if (response.ok) return null
	} catch {
		// Start local server below.
	}
	return await startLocalServer()
}
