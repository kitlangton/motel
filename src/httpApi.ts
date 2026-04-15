import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { AiCallSummary, AiCallDetail, FacetItem, StatsItem } from "./domain.js"

const ErrorResponse = Schema.Struct({ error: Schema.String })
const Meta = Schema.Struct({
	limit: Schema.Number,
	lookback: Schema.String,
	returned: Schema.Number,
	truncated: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ListMeta" })

const TraceSpanEvent = Schema.Struct({
	name: Schema.String.pipe(Schema.annotateKey({ description: "Event name" })),
	timestamp: Schema.String.pipe(Schema.annotateKey({ description: "ISO 8601 timestamp" })),
	attributes: Schema.Unknown.pipe(Schema.annotateKey({ description: "Key-value attributes attached to the event" })),
})

const TraceSpan = Schema.Struct({
	spanId: Schema.String,
	parentSpanId: Schema.NullOr(Schema.String),
	serviceName: Schema.String,
	scopeName: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "Instrumentation scope (e.g. module or library name)" })),
	kind: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "Span kind: client, server, producer, consumer, or internal" })),
	operationName: Schema.String.pipe(Schema.annotateKey({ description: "The operation this span represents (e.g. HTTP handler, DB query)" })),
	startTime: Schema.String.pipe(Schema.annotateKey({ description: "ISO 8601 timestamp" })),
	isRunning: Schema.Boolean.pipe(Schema.annotateKey({ description: "True when the span has not reported an end timestamp yet" })),
	durationMs: Schema.Number.pipe(Schema.annotateKey({ description: "Wall-clock duration in milliseconds" })),
	status: Schema.Literals(["ok", "error"]).pipe(Schema.annotateKey({ description: "ok or error" })),
	depth: Schema.Number.pipe(Schema.annotateKey({ description: "Nesting depth in the span tree (root = 0)" })),
	tags: Schema.Unknown.pipe(Schema.annotateKey({ description: "Span attributes as key-value pairs" })),
	warnings: Schema.Array(Schema.String).pipe(Schema.annotateKey({ description: "Structural warnings (e.g. missing parent span)" })),
	events: Schema.Array(TraceSpanEvent),
}).annotate({ identifier: "TraceSpan" })

const Trace = Schema.Struct({
	traceId: Schema.String,
	serviceName: Schema.String.pipe(Schema.annotateKey({ description: "Service that owns the root span" })),
	rootOperationName: Schema.String.pipe(Schema.annotateKey({ description: "Operation name of the root span" })),
	startedAt: Schema.String.pipe(Schema.annotateKey({ description: "ISO 8601 timestamp of the earliest span" })),
	isRunning: Schema.Boolean.pipe(Schema.annotateKey({ description: "True when any span in the trace is still open" })),
	durationMs: Schema.Number.pipe(Schema.annotateKey({ description: "End-to-end trace duration in milliseconds" })),
	spanCount: Schema.Number,
	errorCount: Schema.Number.pipe(Schema.annotateKey({ description: "Number of spans with status=error" })),
	warnings: Schema.Array(Schema.String),
	spans: Schema.Array(TraceSpan).pipe(Schema.annotateKey({ description: "Spans ordered by parent-child hierarchy, depth-first" })),
}).annotate({ identifier: "Trace" })

const TraceSummary = Schema.Struct({
	traceId: Schema.String,
	serviceName: Schema.String,
	rootOperationName: Schema.String,
	startedAt: Schema.String,
	isRunning: Schema.Boolean,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	errorCount: Schema.Number,
	warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "TraceSummary" })

const Span = Schema.Struct({
	traceId: Schema.String,
	rootOperationName: Schema.String.pipe(Schema.annotateKey({ description: "Operation name of the trace's root span, for context" })),
	parentOperationName: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "Parent span operation name, if present" })),
	span: TraceSpan,
}).annotate({ identifier: "SpanWithContext" })

const Log = Schema.Struct({
	id: Schema.String,
	timestamp: Schema.String.pipe(Schema.annotateKey({ description: "ISO 8601 timestamp" })),
	serviceName: Schema.String,
	severityText: Schema.String.pipe(Schema.annotateKey({ description: "Log level: TRACE, DEBUG, INFO, WARN, ERROR, FATAL" })),
	body: Schema.String.pipe(Schema.annotateKey({ description: "Log message body" })),
	traceId: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "Associated trace ID, if the log was emitted inside a span" })),
	spanId: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "Associated span ID, if the log was emitted inside a span" })),
	scopeName: Schema.NullOr(Schema.String),
	attributes: Schema.Unknown.pipe(Schema.annotateKey({ description: "Merged resource + log attributes as key-value pairs" })),
}).annotate({ identifier: "Log" })

const Facet = FacetItem
const Stat = StatsItem

const ServiceList = Schema.Struct({ data: Schema.Array(Schema.String) })
const Health = Schema.Struct({
	ok: Schema.Boolean,
	service: Schema.String.pipe(Schema.annotateKey({ description: "Stable identity string. Always 'motel-local-server' — used by the MCP shim to detect impostor processes on a stale port." })),
	databasePath: Schema.String,
	pid: Schema.Number.pipe(Schema.annotateKey({ description: "Process ID of this motel instance. Used by the MCP shim to verify a registry entry points at the expected process." })),
	url: Schema.String.pipe(Schema.annotateKey({ description: "Base URL this instance is actually bound to, including the dynamically-chosen port." })),
	workdir: Schema.String.pipe(Schema.annotateKey({ description: "Working directory at the time the server started. Used by MCP discovery to match the current project via longest-prefix." })),
	startedAt: Schema.String.pipe(Schema.annotateKey({ description: "ISO 8601 timestamp of when the server bound its port." })),
	version: Schema.String.pipe(Schema.annotateKey({ description: "Motel version string." })),
})
const IngestTraceResponse = Schema.Struct({ insertedSpans: Schema.Number })
const IngestLogResponse = Schema.Struct({ insertedLogs: Schema.Number })
const DocIndex = Schema.Struct({
	docs: Schema.Array(Schema.Struct({
		name: Schema.String.pipe(Schema.annotateKey({ description: "Document identifier used in the URL path" })),
		title: Schema.String.pipe(Schema.annotateKey({ description: "Human-readable title" })),
		path: Schema.String.pipe(Schema.annotateKey({ description: "API path to fetch this document" })),
	})),
}).annotate({ identifier: "DocIndex" })
const PlainText = Schema.String.pipe(HttpApiSchema.asText())
const HtmlText = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" }))
const TraceSummaryList = Schema.Struct({ data: Schema.Array(TraceSummary), meta: Meta })
const SpanResponse = Schema.Struct({ data: Span })
const SpanList = Schema.Struct({ data: Schema.Array(Span) })
const PaginatedSpanList = Schema.Struct({ data: Schema.Array(Span), meta: Meta })
const TraceResponse = Schema.Struct({ data: Trace })
const LogList = Schema.Struct({ data: Schema.Array(Log), meta: Meta })
const FacetList = Schema.Struct({ data: Schema.Array(Facet) })
const StatList = Schema.Struct({ data: Schema.Array(Stat) })

const AiCallList = Schema.Struct({ data: Schema.Array(AiCallSummary), meta: Meta })
const AiCallDetailResponse = Schema.Struct({ data: AiCallDetail })

// Shared query parameter schemas
const LookbackParam = Schema.optionalKey(Schema.String).pipe(
	Schema.annotateKey({ description: "Time window to look back. Examples: 30m, 1h, 6h, 1d. Default: 90m" }),
)
const LimitParam = Schema.optionalKey(Schema.Number).pipe(
	Schema.annotateKey({ description: "Maximum number of results to return" }),
)
const CursorParam = Schema.optionalKey(Schema.String).pipe(
	Schema.annotateKey({ description: "Opaque pagination cursor from a previous response" }),
)
const ServiceParam = Schema.optionalKey(Schema.String).pipe(
	Schema.annotateKey({ description: "Filter by service name" }),
)

export const MotelHttpApi = HttpApi.make("MotelTelemetry")
	.annotate(OpenApi.Title, "Motel Telemetry API")
	.annotate(OpenApi.Version, "1.0.0")
	.annotate(OpenApi.Description, "Local OpenTelemetry ingest, query, and debugging API. Accepts OTLP HTTP traces and logs, stores them in SQLite, and exposes query endpoints for TUI, CLI, and agent consumption.")
	.add(
		HttpApiGroup.make("telemetry")
			.annotate(OpenApi.Description, "Query traces, spans, logs, and service metadata from the local telemetry store")
			.add(
				HttpApiEndpoint.get("root", "/", { success: PlainText })
					.annotate(OpenApi.Summary, "Root endpoint")
					.annotate(OpenApi.Description, "Human-readable overview of the local telemetry server routes."),

				HttpApiEndpoint.get("health", "/api/health", { success: Health })
					.annotate(OpenApi.Summary, "Health check and identity handshake")
					.annotate(OpenApi.Description, "Returns liveness plus identity fields (pid, url, workdir, startedAt, version). Doubles as the MCP discovery handshake: clients compare the returned pid against a registry entry to detect stale registrations that now point at an impostor process on the same port."),

				HttpApiEndpoint.post("ingestTraces", "/v1/traces", {
					payload: Schema.Unknown,
					success: IngestTraceResponse,
				})
					.annotate(OpenApi.Summary, "Ingest OTLP traces")
					.annotate(OpenApi.Description, "Accepts OTLP HTTP trace export requests and stores them in the local SQLite telemetry store."),

				HttpApiEndpoint.post("ingestLogs", "/v1/logs", {
					payload: Schema.Unknown,
					success: IngestLogResponse,
				})
					.annotate(OpenApi.Summary, "Ingest OTLP logs")
					.annotate(OpenApi.Description, "Accepts OTLP HTTP log export requests and stores them in the local SQLite telemetry store."),

				HttpApiEndpoint.get("services", "/api/services", { success: ServiceList })
					.annotate(OpenApi.Summary, "List active services")
					.annotate(OpenApi.Description, "Returns service names that have emitted spans or logs within the default lookback window. Use this to discover what services are reporting, then query their traces or logs."),

				HttpApiEndpoint.get("traces", "/api/traces", {
					query: {
						service: ServiceParam,
						limit: LimitParam,
						lookback: LookbackParam,
						cursor: CursorParam,
					},
					success: TraceSummaryList,
				})
					.annotate(OpenApi.Summary, "List recent traces")
					.annotate(OpenApi.Description, "Returns compact trace summaries ordered by start time descending. Use /api/traces/{traceId} for the full span tree. Supports cursor pagination and applies default/max limit and lookback bounds."),

				HttpApiEndpoint.get("searchTraces", "/api/traces/search", {
					query: {
						service: ServiceParam,
						operation: Schema.optionalKey(Schema.String).pipe(
							Schema.annotateKey({ description: "Substring match against span operation names (case-insensitive)" }),
						),
						status: Schema.optionalKey(Schema.Literals(["ok", "error"])).pipe(
							Schema.annotateKey({ description: "Filter by trace health: 'error' = at least one span errored, 'ok' = no errors" }),
						),
						minDurationMs: Schema.optionalKey(Schema.Number).pipe(
							Schema.annotateKey({ description: "Only return traces slower than this threshold (milliseconds)" }),
						),
						lookback: LookbackParam,
						limit: LimitParam,
						cursor: CursorParam,
					},
					success: TraceSummaryList,
				})
					.annotate(OpenApi.Summary, "Search traces with filters")
					.annotate(OpenApi.Description, "Search compact trace summaries with filters. Use /api/traces/{traceId} for full details. Supports cursor pagination and attr.<key> filters in the query string."),

				HttpApiEndpoint.get("traceStats", "/api/traces/stats", {
					query: {
						groupBy: Schema.String.pipe(Schema.annotateKey({ description: "Grouping field: service, operation, status, or attr.<key>" })),
						agg: Schema.Literals(["count", "avg_duration", "p95_duration", "error_rate"]),
						service: ServiceParam,
						operation: Schema.optionalKey(Schema.String),
						status: Schema.optionalKey(Schema.Literals(["ok", "error"])),
						minDurationMs: Schema.optionalKey(Schema.Number),
						lookback: LookbackParam,
						limit: LimitParam,
					},
					success: StatList,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Aggregate trace statistics")
					.annotate(OpenApi.Description, "Returns grouped trace aggregates such as count, average duration, p95 duration, or error rate. Supports the same core filters as trace search plus groupBy dimensions like service, operation, status, and attr.<key>."),

				HttpApiEndpoint.get("trace", "/api/traces/:traceId", {
					params: {
						traceId: Schema.String.pipe(Schema.annotateKey({ description: "Full 32-character hex trace ID" })),
					},
					success: TraceResponse,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Get a single trace")
					.annotate(OpenApi.Description, "Returns the full trace with all spans ordered by parent-child hierarchy. Returns 404 if the trace ID is not found or has expired."),

				HttpApiEndpoint.get("tracePage", "/trace/:traceId", {
					params: {
						traceId: Schema.String.pipe(Schema.annotateKey({ description: "Full 32-character hex trace ID" })),
					},
					success: HtmlText,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Render a browser trace page")
					.annotate(OpenApi.Description, "Renders a simple HTML waterfall/log view for one trace, suitable for opening from the TUI or browser."),

				HttpApiEndpoint.get("traceLogs", "/api/traces/:traceId/logs", {
					params: {
						traceId: Schema.String.pipe(Schema.annotateKey({ description: "Full 32-character hex trace ID" })),
					},
					query: {
						lookback: LookbackParam,
						limit: LimitParam,
						cursor: CursorParam,
					},
					success: LogList,
				})
					.annotate(OpenApi.Summary, "Get logs for a trace")
					.annotate(OpenApi.Description, "Returns log records correlated with the given trace, across all spans. Ordered by timestamp descending. Supports cursor pagination and bounded lookback/limit defaults."),

				HttpApiEndpoint.get("traceSpans", "/api/traces/:traceId/spans", {
					params: {
						traceId: Schema.String.pipe(Schema.annotateKey({ description: "Full 32-character hex trace ID" })),
					},
					success: SpanList,
				})
					.annotate(OpenApi.Summary, "List spans for a trace")
					.annotate(OpenApi.Description, "Returns the flat list of spans for one trace, preserving trace context on each row. Useful for span-level filtering and sorting without traversing the full tree shape."),

				HttpApiEndpoint.get("span", "/api/spans/:spanId", {
					params: {
						spanId: Schema.String.pipe(Schema.annotateKey({ description: "Full 16-character hex span ID" })),
					},
					success: SpanResponse,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Get a single span")
					.annotate(OpenApi.Description, "Returns a span by its ID, including the parent trace ID and root operation name for context. Returns 404 if the span is not found."),

				HttpApiEndpoint.get("spanLogs", "/api/spans/:spanId/logs", {
					params: {
						spanId: Schema.String.pipe(Schema.annotateKey({ description: "Full 16-character hex span ID" })),
					},
					query: {
						lookback: LookbackParam,
						limit: LimitParam,
						cursor: CursorParam,
					},
					success: LogList,
				})
					.annotate(OpenApi.Summary, "Get logs for a span")
					.annotate(OpenApi.Description, "Returns log records correlated with the given span. Ordered by timestamp descending. Supports cursor pagination and bounded lookback/limit defaults."),

				HttpApiEndpoint.get("searchSpans", "/api/spans/search", {
					query: {
						service: ServiceParam,
						traceId: Schema.optionalKey(Schema.String).pipe(
							Schema.annotateKey({ description: "Scope search to a single trace" }),
						),
						operation: Schema.optionalKey(Schema.String),
						parentOperation: Schema.optionalKey(Schema.String),
						status: Schema.optionalKey(Schema.Literals(["ok", "error"])),
						lookback: LookbackParam,
						limit: LimitParam,
					},
					success: PaginatedSpanList,
				})
					.annotate(OpenApi.Summary, "Search spans directly")
					.annotate(OpenApi.Description, "Search spans directly instead of root traces. Supports service, traceId, operation, parentOperation, status, lookback, limit, attr.<key>=<value> (exact match), and attrContains.<key>=<substring> (case-insensitive substring search inside attribute values) in the query string."),

				HttpApiEndpoint.get("logs", "/api/logs", {
					query: {
						service: ServiceParam,
						severity: Schema.optionalKey(Schema.String).pipe(
							Schema.annotateKey({ description: "Filter by log severity: TRACE, DEBUG, INFO, WARN, ERROR, FATAL (case-insensitive)" }),
						),
						traceId: Schema.optionalKey(Schema.String).pipe(
							Schema.annotateKey({ description: "Filter logs by trace ID" }),
						),
						spanId: Schema.optionalKey(Schema.String).pipe(
							Schema.annotateKey({ description: "Filter logs by span ID" }),
						),
						body: Schema.optionalKey(Schema.String).pipe(
							Schema.annotateKey({ description: "Substring match against log body (case-insensitive)" }),
						),
						lookback: LookbackParam,
						limit: LimitParam,
						cursor: CursorParam,
					},
					success: LogList,
				})
					.annotate(OpenApi.Summary, "Search logs")
					.annotate(OpenApi.Description, "Search log records by service, severity, trace/span correlation, or body text (case-insensitive). Supports attr.<key>=<value> (exact match) and attrContains.<key>=<substring> (case-insensitive substring) in the query string. Cursor pagination and bounded lookback/limit defaults. Ordered by timestamp descending."),

				HttpApiEndpoint.get("searchLogs", "/api/logs/search", {
					query: {
						service: ServiceParam,
						severity: Schema.optionalKey(Schema.String).pipe(
							Schema.annotateKey({ description: "Filter by log severity: TRACE, DEBUG, INFO, WARN, ERROR, FATAL (case-insensitive)" }),
						),
						traceId: Schema.optionalKey(Schema.String),
						spanId: Schema.optionalKey(Schema.String),
						body: Schema.optionalKey(Schema.String),
						lookback: LookbackParam,
						limit: LimitParam,
						cursor: CursorParam,
					},
					success: LogList,
				})
					.annotate(OpenApi.Summary, "Alias for log search")
					.annotate(OpenApi.Description, "Same behavior as GET /api/logs. Exists as an explicit search endpoint for agents and scripts that distinguish list vs search routes."),

				HttpApiEndpoint.get("logStats", "/api/logs/stats", {
					query: {
						groupBy: Schema.String.pipe(Schema.annotateKey({ description: "Grouping field: service, severity, scope, or attr.<key>" })),
						agg: Schema.Literals(["count"]),
						service: ServiceParam,
						traceId: Schema.optionalKey(Schema.String),
						spanId: Schema.optionalKey(Schema.String),
						body: Schema.optionalKey(Schema.String),
						lookback: LookbackParam,
						limit: LimitParam,
					},
					success: StatList,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Aggregate log statistics")
					.annotate(OpenApi.Description, "Returns grouped log counts by fields like severity, service, scope, or attr.<key>. Useful for quickly understanding log distribution before drilling into raw entries."),

				HttpApiEndpoint.get("docs", "/api/docs", { success: DocIndex })
					.annotate(OpenApi.Summary, "List available documentation")
					.annotate(OpenApi.Description, "Returns an index of available documentation pages. Use GET /api/docs/{name} to fetch the full content of a specific document."),

				HttpApiEndpoint.get("doc", "/api/docs/:name", {
					params: {
						name: Schema.String.pipe(Schema.annotateKey({ description: "Document name: 'debug' for the debug workflow skill, 'effect' for Effect-specific instrumentation guidance" })),
					},
					success: PlainText,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Get a documentation page")
					.annotate(OpenApi.Description, "Returns the full markdown content of a documentation page. Available documents: 'debug' (hypothesis-driven debugging workflow using motel), 'effect' (Effect-specific instrumentation and runtime guidance)."),

				HttpApiEndpoint.get("facets", "/api/facets", {
					query: {
						type: Schema.Literals(["traces", "logs"]).pipe(
							Schema.annotateKey({ description: "Data source to facet: 'traces' facets span columns, 'logs' facets log columns" }),
						),
						field: Schema.String.pipe(
							Schema.annotateKey({ description: "Column to facet. Traces: service, operation, status. Logs: service, severity, scope" }),
						),
						service: ServiceParam,
						lookback: LookbackParam,
						limit: LimitParam,
					},
					success: FacetList,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Get facet value counts")
					.annotate(OpenApi.Description, "Returns distinct values and their counts for a given field, useful for discovering what data exists before querying. For example: ?type=logs&field=severity returns the distribution of log levels."),

				// AI Call endpoints
				HttpApiEndpoint.get("aiCalls", "/api/ai/calls", {
					query: {
						service: ServiceParam,
						traceId: Schema.optionalKey(Schema.String),
						sessionId: Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Filter by ai.telemetry.metadata.sessionId" })),
						functionId: Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Filter by ai.telemetry.functionId" })),
						provider: Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Filter by ai.model.provider (e.g. openai.responses)" })),
						model: Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Filter by ai.model.id (e.g. gpt-5.4)" })),
						operation: Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Filter by AI operation: streamText, generateText, streamObject, etc." })),
						status: Schema.optionalKey(Schema.Literals(["ok", "error"])),
						minDurationMs: Schema.optionalKey(Schema.Number),
						text: Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Case-insensitive substring search across prompt, response, and tool content" })),
						lookback: LookbackParam,
						limit: LimitParam,
					},
					success: AiCallList,
				})
					.annotate(OpenApi.Summary, "Search AI calls")
					.annotate(OpenApi.Description, "Search AI SDK calls (streamText, generateText, etc.) with normalized fields. Returns compact summaries with previews — use /api/ai/calls/{spanId} for full prompt/response payloads. Supports filtering by service, session, model, provider, function, operation, status, duration, and free-text search across prompt/response content."),

				HttpApiEndpoint.get("aiCall", "/api/ai/calls/:spanId", {
					params: {
						spanId: Schema.String.pipe(Schema.annotateKey({ description: "The span ID of the AI call" })),
					},
					success: AiCallDetailResponse,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Get AI call detail")
					.annotate(OpenApi.Description, "Returns the full detail of a single AI call including complete prompt messages, response text, tool calls with args, token usage, timing, provider metadata, and correlated logs."),

				HttpApiEndpoint.get("aiStats", "/api/ai/stats", {
					query: {
						groupBy: Schema.Literals(["provider", "model", "functionId", "sessionId", "status"]).pipe(
							Schema.annotateKey({ description: "Group results by this field" }),
						),
						agg: Schema.Literals(["count", "avg_duration", "p95_duration", "total_input_tokens", "total_output_tokens"]).pipe(
							Schema.annotateKey({ description: "Aggregation function" }),
						),
						service: ServiceParam,
						traceId: Schema.optionalKey(Schema.String),
						sessionId: Schema.optionalKey(Schema.String),
						functionId: Schema.optionalKey(Schema.String),
						provider: Schema.optionalKey(Schema.String),
						model: Schema.optionalKey(Schema.String),
						operation: Schema.optionalKey(Schema.String),
						status: Schema.optionalKey(Schema.Literals(["ok", "error"])),
						minDurationMs: Schema.optionalKey(Schema.Number),
						lookback: LookbackParam,
						limit: LimitParam,
					},
					success: StatList,
					error: ErrorResponse,
				})
					.annotate(OpenApi.Summary, "Aggregate AI call statistics")
					.annotate(OpenApi.Description, "Returns grouped statistics for AI calls. Supports grouping by provider, model, functionId, sessionId, or status with aggregations: count, avg_duration, p95_duration, total_input_tokens, total_output_tokens."),
			)
	)

export const motelOpenApiSpec = OpenApi.fromApi(MotelHttpApi)
