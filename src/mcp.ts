#!/usr/bin/env bun
import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Logger, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/unstable/ai"
import { TraceSpanStatus } from "./domain.js"
import { MotelClient, MotelClientLive } from "./motelClient.js"
import { Locator, LocatorLive } from "./locator.js"

const Attributes = Schema.optional(
	Schema.Record(Schema.String, Schema.String).annotate({
		description:
			"Arbitrary OTel attribute filters. Key is the attribute name WITHOUT the 'attr.' prefix (it is added for you). Values must be strings.",
	}),
)

const AttributeContains = Schema.optional(
	Schema.Record(Schema.String, Schema.String).annotate({
		description:
			"Case-insensitive substring attribute filters. Key is the attribute name WITHOUT the 'attrContains.' prefix (it is added for you). Values must be strings.",
	}),
)

const Lookback = Schema.optional(
	Schema.String.annotate({
		description:
			"Time window to look back, e.g. '15m', '1h', '6h', '1d'. Max 24h. Default 60m.",
	}),
)

const Limit = Schema.optional(
	Schema.Number.annotate({ description: "Max items to return in this page. Tool defaults apply." }),
)

const Cursor = Schema.optional(
	Schema.String.annotate({
		description:
			"Opaque pagination cursor from a previous response's meta.nextCursor. Pass it back to fetch the next page.",
	}),
)

const ServiceParam = Schema.optional(
	Schema.String.annotate({ description: "Filter by OTel service name (e.g. 'opencode', 'my-app')." }),
)

const Status = Schema.optional(
	TraceSpanStatus.annotate({
		description:
			"Filter by trace health. 'error' = at least one span errored. 'ok' = no errors.",
	}),
)

const Severity = Schema.optional(
	Schema.String.annotate({
		description: "Filter by log severity, e.g. TRACE, DEBUG, INFO, WARN, ERROR, FATAL.",
	}),
)

const StatusTool = Tool.make("motel_status", {
	description:
		"Check which motel instance this shim is connected to. Call this FIRST if any other tool errors, to confirm the connection. Returns url, version, workdir, whether the cwd matches, and how many motel instances are running on this machine.",
	parameters: Tool.EmptyParams,
	success: Schema.Struct({
		connected: Schema.Boolean,
		url: Schema.optional(Schema.String),
		version: Schema.optional(Schema.String),
		workdir: Schema.optional(Schema.String),
		cwdMatch: Schema.optional(Schema.Boolean),
		instanceCount: Schema.optional(Schema.Number),
		source: Schema.optional(Schema.String),
		error: Schema.optional(Schema.String),
	}),
}).annotate(Tool.Readonly, true)

const ServicesTool = Tool.make("motel_services", {
	description:
		"List every OTel service name that has emitted traces or logs recently. Use this to discover what's being observed before narrowing down with motel_search_traces or motel_search_logs.",
	parameters: Tool.EmptyParams,
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const FacetsTool = Tool.make("motel_facets", {
	description:
		"Return distinct values and counts for a given field, so the agent can see what data exists before filtering. For traces, valid fields include 'service', 'operation', 'status'. For logs, 'service', 'severity', 'scope'. Supports attr.<key> fields too.",
	parameters: Schema.Struct({
		type: Schema.Literals(["traces", "logs"]).annotate({
			description: "Which dataset to facet.",
		}),
		field: Schema.String.annotate({
			description: "The column or attr.<key> to return distinct values for.",
		}),
		service: ServiceParam,
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const SearchTracesTool = Tool.make("motel_search_traces", {
	description:
		"Search distributed traces by service, operation, error status, minimum duration, time window, and arbitrary OTel attributes. Returns compact trace summaries with traceId, duration, error count, span count, and a nextCursor. Drill into a specific trace with motel_get_trace. For 'what just broke' investigations, pass status='error' with a short lookback like '15m'.",
	parameters: Schema.Struct({
		service: ServiceParam,
		operation: Schema.optional(
			Schema.String.annotate({ description: "Substring match on span operation name." }),
		),
		status: Status,
		minDurationMs: Schema.optional(
			Schema.Number.annotate({ description: "Only return traces slower than this (ms)." }),
		),
		attributes: Attributes,
		lookback: Lookback,
		limit: Limit,
		cursor: Cursor,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetTraceTool = Tool.make("motel_get_trace", {
	description:
		"Fetch a single trace by its 32-character hex traceId, including the full span tree ordered parent-first. Use this to drill into a trace found via motel_search_traces. For the logs emitted inside this trace, use motel_get_trace_logs instead.",
	parameters: Schema.Struct({
		traceId: Schema.String.annotate({ description: "Full 32-character hex trace ID." }),
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetTraceLogsTool = Tool.make("motel_get_trace_logs", {
	description:
		"Fetch log records correlated with a specific trace, across all spans. When investigating a failing trace, call this before motel_search_logs — it is the most scoped and usually the most informative log view.",
	parameters: Schema.Struct({
		traceId: Schema.String.annotate({ description: "Full 32-character hex trace ID." }),
		lookback: Lookback,
		limit: Limit,
		cursor: Cursor,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetTraceSpansTool = Tool.make("motel_get_trace_spans", {
	description:
		"Fetch the flat span list for a specific trace. Use this when you already know the traceId and want to inspect span durations, status, parents, and raw attributes without the nested trace wrapper.",
	parameters: Schema.Struct({
		traceId: Schema.String.annotate({ description: "Full 32-character hex trace ID." }),
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const SearchSpansTool = Tool.make("motel_search_spans", {
	description:
		"Search spans directly by service, traceId, operation, parentOperation, status, time window, and raw OTel attributes. Use this when traces are too coarse and you need to find the exact span or suspicious operation first.",
	parameters: Schema.Struct({
		service: ServiceParam,
		traceId: Schema.optional(
			Schema.String.annotate({ description: "Scope search to a single trace ID." }),
		),
		operation: Schema.optional(
			Schema.String.annotate({ description: "Substring match on span operation name." }),
		),
		parentOperation: Schema.optional(
			Schema.String.annotate({ description: "Substring match on parent operation name." }),
		),
		status: Status,
		attributes: Attributes,
		attributeContains: AttributeContains,
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetSpanTool = Tool.make("motel_get_span", {
	description:
		"Fetch a single span by its 16-character hex spanId. Use this after motel_search_spans to inspect one span's full payload, parent trace, raw tags, and events.",
	parameters: Schema.Struct({
		spanId: Schema.String.annotate({ description: "Full 16-character hex span ID." }),
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetSpanLogsTool = Tool.make("motel_get_span_logs", {
	description:
		"Fetch log records correlated with a specific span. Use this after motel_get_span when you need the exact logs emitted from that one span, not the entire trace.",
	parameters: Schema.Struct({
		spanId: Schema.String.annotate({ description: "Full 16-character hex span ID." }),
		lookback: Lookback,
		limit: Limit,
		cursor: Cursor,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const SearchLogsTool = Tool.make("motel_search_logs", {
	description:
		"Search logs by service, trace/span correlation, body substring, time window, and arbitrary OTel attributes. Returns log entries with a nextCursor. For logs tied to a known traceId, prefer motel_get_trace_logs — it is more focused.",
	parameters: Schema.Struct({
		service: ServiceParam,
		severity: Severity,
		traceId: Schema.optional(
			Schema.String.annotate({ description: "Filter by trace ID." }),
		),
		spanId: Schema.optional(
			Schema.String.annotate({ description: "Filter by span ID." }),
		),
		body: Schema.optional(
			Schema.String.annotate({ description: "Substring match on log body (case-sensitive)." }),
		),
		attributes: Attributes,
		attributeContains: AttributeContains,
		lookback: Lookback,
		limit: Limit,
		cursor: Cursor,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const SearchAiCallsTool = Tool.make("motel_search_ai_calls", {
	description:
		"Search normalized AI calls such as streamText and generateText by session, provider, model, functionId, operation, duration, status, or free-text prompt/response content. Use this for LLM-specific investigations rather than raw span search.",
	parameters: Schema.Struct({
		service: ServiceParam,
		traceId: Schema.optional(Schema.String.annotate({ description: "Filter by trace ID." })),
		sessionId: Schema.optional(Schema.String.annotate({ description: "Filter by normalized AI sessionId." })),
		functionId: Schema.optional(Schema.String.annotate({ description: "Filter by AI functionId, e.g. session.llm." })),
		provider: Schema.optional(Schema.String.annotate({ description: "Filter by provider, e.g. openai.responses." })),
		model: Schema.optional(Schema.String.annotate({ description: "Filter by model ID." })),
		operation: Schema.optional(Schema.String.annotate({ description: "Filter by normalized AI operation, e.g. streamText." })),
		status: Status,
		minDurationMs: Schema.optional(Schema.Number.annotate({ description: "Only return AI calls slower than this (ms)." })),
		text: Schema.optional(Schema.String.annotate({ description: "Case-insensitive substring match across prompt, response, and tool content." })),
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetAiCallTool = Tool.make("motel_get_ai_call", {
	description:
		"Fetch the full detail for one AI call by spanId, including complete prompt messages, response payloads, tool calls, token usage, provider metadata, and correlated logs.",
	parameters: Schema.Struct({
		spanId: Schema.String.annotate({ description: "The span ID of the AI call." }),
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const AiStatsTool = Tool.make("motel_ai_stats", {
	description:
		"Aggregate AI call statistics grouped by provider, model, functionId, sessionId, or status. Use this before paging raw AI calls when you want to understand which models are slowest or which functions consume the most tokens.",
	parameters: Schema.Struct({
		groupBy: Schema.Literals(["provider", "model", "functionId", "sessionId", "status"]),
		agg: Schema.Literals(["count", "avg_duration", "p95_duration", "total_input_tokens", "total_output_tokens"]),
		service: ServiceParam,
		traceId: Schema.optional(Schema.String),
		sessionId: Schema.optional(Schema.String),
		functionId: Schema.optional(Schema.String),
		provider: Schema.optional(Schema.String),
		model: Schema.optional(Schema.String),
		operation: Schema.optional(Schema.String),
		status: Status,
		minDurationMs: Schema.optional(Schema.Number),
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const DocsIndexTool = Tool.make("motel_docs_index", {
	description:
		"List the documentation pages bundled with motel, such as the debug workflow and Effect guide. Use this before motel_get_doc if you are unsure which docs are available.",
	parameters: Tool.EmptyParams,
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetDocTool = Tool.make("motel_get_doc", {
	description:
		"Fetch a bundled motel documentation page as markdown text. Useful for giving an agent the exact debug workflow or Effect instrumentation guidance without leaving MCP.",
	parameters: Schema.Struct({
		name: Schema.String.annotate({ description: "Document name, e.g. 'debug' or 'effect'." }),
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const OpenApiTool = Tool.make("motel_openapi", {
	description:
		"Fetch motel's OpenAPI JSON document. Use this when you need the authoritative HTTP API surface or want to compare MCP coverage against the server routes.",
	parameters: Tool.EmptyParams,
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const TraceStatsTool = Tool.make("motel_traces_stats", {
	description:
		"Aggregate statistics across traces: count, average duration, p95 duration, or error rate, grouped by a field like service, operation, status, or attr.<key>. Use this BEFORE paginating raw traces when you want to understand the shape of the data — for example 'what tools are the slowest' or 'which services are erroring'.",
	parameters: Schema.Struct({
		groupBy: Schema.String.annotate({
			description: "Grouping dimension. Examples: 'service', 'operation', 'status', 'attr.tool.name'.",
		}),
		agg: Schema.Literals(["count", "avg_duration", "p95_duration", "error_rate"]),
		service: ServiceParam,
		operation: Schema.optional(Schema.String),
		status: Status,
		minDurationMs: Schema.optional(Schema.Number),
		attributes: Attributes,
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const LogStatsTool = Tool.make("motel_logs_stats", {
	description:
		"Group and count logs by a field like 'severity', 'service', 'scope', or 'attr.<key>'. Useful for quickly understanding log-level distribution (e.g. how many ERROR logs there are in the last hour) before drilling into individual entries.",
	parameters: Schema.Struct({
		groupBy: Schema.String.annotate({
			description: "Grouping dimension. Examples: 'service', 'severity', 'scope', 'attr.session.id'.",
		}),
		service: ServiceParam,
		traceId: Schema.optional(Schema.String),
		spanId: Schema.optional(Schema.String),
		body: Schema.optional(Schema.String),
		attributes: Attributes,
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const MotelToolkit = Toolkit.make(
	StatusTool,
	ServicesTool,
	FacetsTool,
	SearchTracesTool,
	GetTraceTool,
	GetTraceLogsTool,
	GetTraceSpansTool,
	SearchSpansTool,
	GetSpanTool,
	GetSpanLogsTool,
	SearchLogsTool,
	SearchAiCallsTool,
	GetAiCallTool,
	AiStatsTool,
	TraceStatsTool,
	LogStatsTool,
	DocsIndexTool,
	GetDocTool,
	OpenApiTool,
)

const asResult = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
	Effect.match(effect, {
		onFailure: (err) => ({ error: err.message }) as unknown,
		onSuccess: (value) => value as unknown,
	})

const ToolHandlers = MotelToolkit.toLayer(
	Effect.gen(function* () {
		const client = yield* MotelClient
		const locator = yield* Locator

		return {
			motel_status: () =>
				Effect.match(locator.resolve, {
					onFailure: (err) => ({
						connected: false as const,
						error: err instanceof Error ? err.message : String(err),
					}),
					onSuccess: (r) => ({
						connected: true as const,
						url: r.url,
						version: r.version,
						workdir: r.workdir,
						cwdMatch: r.cwdMatch,
						instanceCount: r.instanceCount,
						source: r.source,
					}),
				}),

			motel_services: () => asResult(client.services),

			motel_facets: (input) => asResult(client.facets(input)),

			motel_search_traces: (input) => asResult(client.searchTraces(input)),

			motel_get_trace: ({ traceId }) => asResult(client.getTrace(traceId)),

			motel_get_trace_logs: ({ traceId, lookback, limit, cursor }) =>
				asResult(client.getTraceLogs(traceId, { lookback, limit, cursor })),

			motel_get_trace_spans: ({ traceId }) => asResult(client.getTraceSpans(traceId)),

			motel_search_spans: (input) => asResult(client.searchSpans(input)),

			motel_get_span: ({ spanId }) => asResult(client.getSpan(spanId)),

			motel_get_span_logs: ({ spanId, lookback, limit, cursor }) =>
				asResult(client.getSpanLogs(spanId, { lookback, limit, cursor })),

			motel_search_logs: (input) => asResult(client.searchLogs(input)),

			motel_search_ai_calls: (input) => asResult(client.searchAiCalls(input)),

			motel_get_ai_call: ({ spanId }) => asResult(client.getAiCall(spanId)),

			motel_ai_stats: (input) => asResult(client.aiCallStats(input)),

			motel_traces_stats: (input) => asResult(client.traceStats(input)),

			motel_logs_stats: (input) => asResult(client.logStats(input)),

			motel_docs_index: () => asResult(client.docs),

			motel_get_doc: ({ name }) => asResult(Effect.map(client.getDoc(name), (data) => ({ data }))),

			motel_openapi: () => asResult(client.openapi),
		}
	}),
)

const ServerLayer = McpServer.toolkit(MotelToolkit).pipe(
	Layer.provideMerge(ToolHandlers),
	Layer.provide(MotelClientLive),
	Layer.provide(LocatorLive),
	Layer.provide(
		McpServer.layerStdio({
			name: "motel",
			version: "0.1.0",
		}),
	),
	Layer.provide(BunStdio.layer),
	Layer.provide(Logger.layer([Logger.consolePretty({ stderr: true })])),
)

Layer.launch(ServerLayer).pipe(BunRuntime.runMain)
