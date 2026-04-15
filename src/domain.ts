import { Schema } from "effect"

export type TraceSpanStatus = "ok" | "error"

export interface TraceSpanEvent {
	readonly name: string
	readonly timestamp: Date
	readonly attributes: Readonly<Record<string, string>>
}

export interface TraceSpanItem {
	readonly spanId: string
	readonly parentSpanId: string | null
	readonly serviceName: string
	readonly scopeName: string | null
	readonly kind: string | null
	readonly operationName: string
	readonly startTime: Date
	readonly durationMs: number
	readonly status: TraceSpanStatus
	readonly depth: number
	readonly tags: Readonly<Record<string, string>>
	readonly warnings: readonly string[]
	readonly events: readonly TraceSpanEvent[]
}

export interface TraceItem {
	readonly traceId: string
	readonly serviceName: string
	readonly rootOperationName: string
	readonly startedAt: Date
	readonly durationMs: number
	readonly spanCount: number
	readonly errorCount: number
	readonly warnings: readonly string[]
	readonly spans: readonly TraceSpanItem[]
}

export interface TraceSummaryItem {
	readonly traceId: string
	readonly serviceName: string
	readonly rootOperationName: string
	readonly startedAt: Date
	readonly durationMs: number
	readonly spanCount: number
	readonly errorCount: number
	readonly warnings: readonly string[]
}

export interface SpanItem {
	readonly traceId: string
	readonly rootOperationName: string
	readonly parentOperationName: string | null
	readonly span: TraceSpanItem
}

export interface LogItem {
	readonly id: string
	readonly timestamp: Date
	readonly serviceName: string
	readonly severityText: string
	readonly body: string
	readonly traceId: string | null
	readonly spanId: string | null
	readonly scopeName: string | null
	readonly attributes: Readonly<Record<string, string>>
}

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

/** Attribute keys to search across when using the `text` filter */
export const AI_TEXT_SEARCH_KEYS = [
	"ai.prompt.messages",
	"ai.prompt",
	"ai.response.text",
	"ai.prompt.tools",
] as const

const PREVIEW_LENGTH = 200

export const truncatePreview = (value: string | null | undefined): string | null => {
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
	operation: Schema.String.pipe(Schema.annotateKey({ description: "AI operation: streamText, generateText, streamObject, etc." })),
	service: Schema.String,
	functionId: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "ai.telemetry.functionId" })),
	provider: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "ai.model.provider (e.g. openai.responses)" })),
	model: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "ai.model.id (e.g. gpt-5.4)" })),
	status: Schema.Literals(["ok", "error"]),
	startedAt: Schema.String.pipe(Schema.annotateKey({ description: "ISO 8601 timestamp" })),
	durationMs: Schema.Number,
	sessionId: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	promptPreview: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "First ~200 chars of prompt content" })),
	responsePreview: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "First ~200 chars of response text" })),
	finishReason: Schema.NullOr(Schema.String),
	toolCallCount: Schema.Number.pipe(Schema.annotateKey({ description: "Number of tool call child spans" })),
	usage: Schema.NullOr(AiUsage),
}).annotate({ identifier: "AiCallSummary" })

export type AiCallSummary = typeof AiCallSummary.Type

export const AiToolCall = Schema.Struct({
	name: Schema.String,
	spanId: Schema.NullOr(Schema.String),
	status: Schema.Literals(["ok", "error"]),
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
	status: Schema.Literals(["ok", "error"]),
	startedAt: Schema.String,
	durationMs: Schema.Number,
	sessionId: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	finishReason: Schema.NullOr(Schema.String),
	promptMessages: Schema.NullOr(Schema.Unknown).pipe(Schema.annotateKey({ description: "Full parsed ai.prompt.messages or ai.prompt" })),
	responseText: Schema.NullOr(Schema.String).pipe(Schema.annotateKey({ description: "Full ai.response.text" })),
	toolCalls: Schema.Array(AiToolCall),
	toolsAvailable: Schema.NullOr(Schema.Unknown).pipe(Schema.annotateKey({ description: "Full ai.prompt.tools" })),
	providerMetadata: Schema.NullOr(Schema.Unknown),
	usage: Schema.NullOr(AiUsage),
	timing: Schema.Struct({
		msToFirstChunk: Schema.NullOr(Schema.Number),
		msToFinish: Schema.NullOr(Schema.Number),
		avgOutputTokensPerSecond: Schema.NullOr(Schema.Number),
	}),
	logs: Schema.Array(Schema.Unknown).pipe(Schema.annotateKey({ description: "Correlated log records" })),
}).annotate({ identifier: "AiCallDetail" })

export type AiCallDetail = typeof AiCallDetail.Type
