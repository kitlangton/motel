import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Reusable helpers
// ---------------------------------------------------------------------------

const StringRecord = Schema.Record(Schema.String, Schema.String)

const DateFromString = Schema.DateFromString

// ---------------------------------------------------------------------------
// Core telemetry domain types (Schema is the single source of truth)
// ---------------------------------------------------------------------------

export const TraceSpanStatus = Schema.Literals(["ok", "error"])
export type TraceSpanStatus = typeof TraceSpanStatus.Type

export const TraceSpanEvent = Schema.Struct({
	name: Schema.String.pipe(Schema.annotateKey({ description: "Event name" })),
	timestamp: DateFromString.pipe(
		Schema.annotateKey({ description: "ISO 8601 timestamp" }),
	),
	attributes: StringRecord.pipe(
		Schema.annotateKey({
			description: "Key-value attributes attached to the event",
		}),
	),
}).annotate({ identifier: "TraceSpanEvent" })

export type TraceSpanEvent = typeof TraceSpanEvent.Type

export const TraceSpanItem = Schema.Struct({
	spanId: Schema.String,
	parentSpanId: Schema.NullOr(Schema.String),
	serviceName: Schema.String,
	scopeName: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({
			description: "Instrumentation scope (e.g. module or library name)",
		}),
	),
	kind: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({
			description: "Span kind: client, server, producer, consumer, or internal",
		}),
	),
	operationName: Schema.String.pipe(
		Schema.annotateKey({
			description:
				"The operation this span represents (e.g. HTTP handler, DB query)",
		}),
	),
	startTime: DateFromString.pipe(
		Schema.annotateKey({ description: "ISO 8601 timestamp" }),
	),
	isRunning: Schema.Boolean.pipe(
		Schema.annotateKey({
			description: "True when the span has not reported an end timestamp yet",
		}),
	),
	durationMs: Schema.Number.pipe(
		Schema.annotateKey({ description: "Wall-clock duration in milliseconds" }),
	),
	status: TraceSpanStatus.pipe(
		Schema.annotateKey({ description: "ok or error" }),
	),
	depth: Schema.Number.pipe(
		Schema.annotateKey({
			description: "Nesting depth in the span tree (root = 0)",
		}),
	),
	tags: StringRecord.pipe(
		Schema.annotateKey({ description: "Span attributes as key-value pairs" }),
	),
	warnings: Schema.Array(Schema.String).pipe(
		Schema.annotateKey({
			description: "Structural warnings (e.g. missing parent span)",
		}),
	),
	events: Schema.Array(TraceSpanEvent),
}).annotate({ identifier: "TraceSpan" })

export type TraceSpanItem = typeof TraceSpanItem.Type

export const TraceItem = Schema.Struct({
	traceId: Schema.String,
	serviceName: Schema.String.pipe(
		Schema.annotateKey({ description: "Service that owns the root span" }),
	),
	rootOperationName: Schema.String.pipe(
		Schema.annotateKey({ description: "Operation name of the root span" }),
	),
	startedAt: DateFromString.pipe(
		Schema.annotateKey({
			description: "ISO 8601 timestamp of the earliest span",
		}),
	),
	isRunning: Schema.Boolean.pipe(
		Schema.annotateKey({
			description: "True when any span in the trace is still open",
		}),
	),
	durationMs: Schema.Number.pipe(
		Schema.annotateKey({
			description: "End-to-end trace duration in milliseconds",
		}),
	),
	spanCount: Schema.Number,
	errorCount: Schema.Number.pipe(
		Schema.annotateKey({ description: "Number of spans with status=error" }),
	),
	warnings: Schema.Array(Schema.String),
	spans: Schema.Array(TraceSpanItem).pipe(
		Schema.annotateKey({
			description: "Spans ordered by parent-child hierarchy, depth-first",
		}),
	),
}).annotate({ identifier: "Trace" })

export type TraceItem = typeof TraceItem.Type

export const TraceSummaryItem = Schema.Struct({
	traceId: Schema.String,
	serviceName: Schema.String,
	rootOperationName: Schema.String,
	startedAt: DateFromString.pipe(
		Schema.annotateKey({ description: "ISO 8601 timestamp" }),
	),
	isRunning: Schema.Boolean,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	errorCount: Schema.Number,
	warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "TraceSummary" })

export type TraceSummaryItem = typeof TraceSummaryItem.Type

export const SpanItem = Schema.Struct({
	traceId: Schema.String,
	rootOperationName: Schema.String.pipe(
		Schema.annotateKey({
			description: "Operation name of the trace's root span, for context",
		}),
	),
	parentOperationName: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({
			description: "Parent span operation name, if present",
		}),
	),
	span: TraceSpanItem,
}).annotate({ identifier: "SpanWithContext" })

export type SpanItem = typeof SpanItem.Type

export const LogItem = Schema.Struct({
	id: Schema.String,
	timestamp: DateFromString.pipe(
		Schema.annotateKey({ description: "ISO 8601 timestamp" }),
	),
	serviceName: Schema.String,
	severityText: Schema.String.pipe(
		Schema.annotateKey({
			description: "Log level: TRACE, DEBUG, INFO, WARN, ERROR, FATAL",
		}),
	),
	body: Schema.String.pipe(
		Schema.annotateKey({ description: "Log message body" }),
	),
	traceId: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({
			description: "Associated trace ID, if the log was emitted inside a span",
		}),
	),
	spanId: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({
			description: "Associated span ID, if the log was emitted inside a span",
		}),
	),
	scopeName: Schema.NullOr(Schema.String),
	attributes: StringRecord.pipe(
		Schema.annotateKey({
			description: "Merged resource + log attributes as key-value pairs",
		}),
	),
}).annotate({ identifier: "Log" })

export type LogItem = typeof LogItem.Type

// ---------------------------------------------------------------------------
// Shared query result types
// ---------------------------------------------------------------------------

export const FacetItem = Schema.Struct({
	value: Schema.String.pipe(
		Schema.annotateKey({ description: "Distinct value for the faceted field" }),
	),
	count: Schema.Number.pipe(
		Schema.annotateKey({ description: "Number of occurrences" }),
	),
}).annotate({ identifier: "Facet" })

export type FacetItem = typeof FacetItem.Type

export const StatsItem = Schema.Struct({
	group: Schema.String.pipe(
		Schema.annotateKey({ description: "Grouping key" }),
	),
	value: Schema.Number.pipe(
		Schema.annotateKey({
			description: "Aggregate value for the chosen metric",
		}),
	),
	count: Schema.Number.pipe(
		Schema.annotateKey({ description: "Number of samples in the group" }),
	),
}).annotate({ identifier: "Stat" })

export type StatsItem = typeof StatsItem.Type

// ---------------------------------------------------------------------------
// AI Call types
// ---------------------------------------------------------------------------

/** Maps normalized field names to the AI SDK attribute keys in span_attributes */
export const AI_ATTR_MAP = {
	operationId: "ai.operationId",
	functionId: "ai.telemetry.functionId",
	provider: "ai.model.provider",
	model: "ai.model.id",
	sessionId: "ai.telemetry.metadata.sessionId",
	userId: "ai.telemetry.metadata.userId",
	finishReason: "ai.response.finishReason",
	inputTokens: "ai.usage.inputTokens",
	outputTokens: "ai.usage.outputTokens",
	totalTokens: "ai.usage.totalTokens",
	cachedInputTokens: "ai.usage.cachedInputTokens",
	reasoningTokens: "ai.usage.reasoningTokens",
	msToFirstChunk: "ai.response.msToFirstChunk",
	msToFinish: "ai.response.msToFinish",
	avgOutputTokensPerSecond: "ai.response.avgOutputTokensPerSecond",
	promptMessages: "ai.prompt.messages",
	prompt: "ai.prompt",
	responseText: "ai.response.text",
	tools: "ai.prompt.tools",
	toolChoice: "ai.prompt.toolChoice",
	providerMetadata: "ai.response.providerMetadata",
	responseModel: "ai.response.model",
	responseId: "ai.response.id",
	responseTimestamp: "ai.response.timestamp",
} as const

/**
 * Attribute keys that carry LLM prompt/response content and should be
 * indexed in the span-attribute FTS table. These are the keys emitted by
 * well-known LLM instrumentation conventions:
 *
 * - **Vercel AI SDK** (`ai.*`): rich, SDK-specific attributes captured by
 *   `experimental_telemetry` on `generateText` / `streamText` / `generateObject`.
 * - **OpenTelemetry GenAI semantic conventions** (`gen_ai.*`): the
 *   cross-vendor standard. The singular `prompt`/`completion` attrs are
 *   deprecated in favor of event-based capture but are still emitted by
 *   most instrumentations, so we keep them.
 * - **OpenInference** (`input.value` / `output.value`): Arize Phoenix /
 *   LangChain-style normalized input/output.
 *
 * Keys here trigger FTS indexing on insert via a trigger in TelemetryStore.
 * Adding a key requires a one-time backfill; removing one leaves orphan
 * FTS entries that get cleaned up on next retention pass.
 */
export const AI_FTS_KEYS = [
	// Vercel AI SDK
	"ai.prompt",
	"ai.prompt.messages",
	"ai.prompt.tools",
	"ai.prompt.toolChoice",
	"ai.response.text",
	"ai.response.toolCalls",
	"ai.response.reasoning",
	"ai.response.object",
	"ai.toolCall.args",
	"ai.toolCall.result",
	// OpenTelemetry GenAI semantic conventions
	"gen_ai.prompt",
	"gen_ai.completion",
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"gen_ai.system_instructions",
	"gen_ai.tool.definitions",
	"gen_ai.tool.message.content",
	// OpenInference (Phoenix, LangChain, etc.)
	"input.value",
	"output.value",
] as const

/**
 * Back-compat alias. The `text` filter on `/api/ai/calls` historically
 * LIKE-searched these four keys; now FTS indexes the broader AI_FTS_KEYS
 * set so the filter transparently covers more content.
 */
export const AI_TEXT_SEARCH_KEYS = AI_FTS_KEYS

/**
 * True if a span's tags contain any of the AI content keys we track.
 * Used as the single source of truth for "this span has LLM payloads
 * worth a specialized view" — drives the ✦ marker in the waterfall row
 * and picks the chat-flavored renderer when the user drills into the
 * span's detail. Scanning happens once per row during render so this
 * needs to stay O(AI_FTS_KEYS.length) with cheap `in` checks rather
 * than an `Object.keys(...).some(...)` allocation.
 */
export const isAiSpan = (tags: Readonly<Record<string, string>>): boolean => {
	for (const key of AI_FTS_KEYS) {
		if (key in tags) return true
	}
	return false
}

const PREVIEW_LENGTH = 200

export const truncatePreview = (
	value: string | null | undefined,
): string | null => {
	if (!value) return null
	if (value.length <= PREVIEW_LENGTH) return value
	return value.slice(0, PREVIEW_LENGTH) + "..."
}

export const AiUsage = Schema.Struct({
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	totalTokens: Schema.NullOr(Schema.Number),
	cachedInputTokens: Schema.NullOr(Schema.Number),
	reasoningTokens: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "AiUsage" })

export type AiUsage = typeof AiUsage.Type

export const AiCallSummary = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	operation: Schema.String.pipe(
		Schema.annotateKey({
			description: "AI operation: streamText, generateText, streamObject, etc.",
		}),
	),
	service: Schema.String,
	functionId: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({ description: "ai.telemetry.functionId" }),
	),
	provider: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({
			description: "ai.model.provider (e.g. openai.responses)",
		}),
	),
	model: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({ description: "ai.model.id (e.g. gpt-5.4)" }),
	),
	status: TraceSpanStatus,
	startedAt: Schema.String.pipe(
		Schema.annotateKey({ description: "ISO 8601 timestamp" }),
	),
	durationMs: Schema.Number,
	sessionId: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	promptPreview: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({ description: "First ~200 chars of prompt content" }),
	),
	responsePreview: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({ description: "First ~200 chars of response text" }),
	),
	finishReason: Schema.NullOr(Schema.String),
	toolCallCount: Schema.Number.pipe(
		Schema.annotateKey({ description: "Number of tool call child spans" }),
	),
	usage: Schema.NullOr(AiUsage),
}).annotate({ identifier: "AiCallSummary" })

export type AiCallSummary = typeof AiCallSummary.Type

export const AiToolCall = Schema.Struct({
	name: Schema.String,
	spanId: Schema.NullOr(Schema.String),
	status: TraceSpanStatus,
	durationMs: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "AiToolCall" })

export type AiToolCall = typeof AiToolCall.Type

export const AiCallDetail = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	operation: Schema.String,
	service: Schema.String,
	functionId: Schema.NullOr(Schema.String),
	provider: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	status: TraceSpanStatus,
	startedAt: Schema.String,
	durationMs: Schema.Number,
	sessionId: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	finishReason: Schema.NullOr(Schema.String),
	promptMessages: Schema.NullOr(Schema.Unknown).pipe(
		Schema.annotateKey({
			description: "Full parsed ai.prompt.messages or ai.prompt",
		}),
	),
	responseText: Schema.NullOr(Schema.String).pipe(
		Schema.annotateKey({ description: "Full ai.response.text" }),
	),
	toolCalls: Schema.Array(AiToolCall),
	toolsAvailable: Schema.NullOr(Schema.Unknown).pipe(
		Schema.annotateKey({ description: "Full ai.prompt.tools" }),
	),
	providerMetadata: Schema.NullOr(Schema.Unknown),
	usage: Schema.NullOr(AiUsage),
	timing: Schema.Struct({
		msToFirstChunk: Schema.NullOr(Schema.Number),
		msToFinish: Schema.NullOr(Schema.Number),
		avgOutputTokensPerSecond: Schema.NullOr(Schema.Number),
	}),
	logs: Schema.Array(Schema.Unknown).pipe(
		Schema.annotateKey({ description: "Correlated log records" }),
	),
}).annotate({ identifier: "AiCallDetail" })

export type AiCallDetail = typeof AiCallDetail.Type
