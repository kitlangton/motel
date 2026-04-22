import { Effect, Layer, Context } from "effect"
import { Locator } from "./locator.js"

export class MotelHttpError extends Error {
	readonly _tag = "MotelHttpError"
	constructor(
		readonly status: number,
		readonly detail: string,
	) {
		super(`motel returned HTTP ${status}: ${detail}`)
	}
}

type QueryValue = string | number | boolean | null | undefined
type Query = Readonly<Record<string, QueryValue>>
type AttributeFilters = Readonly<Record<string, string>>

const appendQuery = (url: URL, query: Query | undefined) => {
	if (!query) return url
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") continue
		url.searchParams.set(key, String(value))
	}
	return url
}

const appendAttributes = (
	url: URL,
	prefix: "attr" | "attrContains",
	attributes: AttributeFilters | undefined,
) => {
	if (!attributes) return url
	for (const [key, value] of Object.entries(attributes)) {
		url.searchParams.set(`${prefix}.${key}`, value)
	}
	return url
}

const appendAllAttributes = (
	url: URL,
	attributes: AttributeFilters | undefined,
	attributeContains: AttributeFilters | undefined,
) =>
	appendAttributes(
		appendAttributes(url, "attr", attributes),
		"attrContains",
		attributeContains,
	)

export type SearchTracesInput = {
	readonly service?: string
	readonly operation?: string
	readonly status?: "ok" | "error"
	readonly minDurationMs?: number
	readonly lookback?: string
	readonly limit?: number
	readonly cursor?: string
	readonly attributes?: AttributeFilters
	readonly attributeContains?: AttributeFilters
}

export type SearchSpansInput = {
	readonly service?: string
	readonly traceId?: string
	readonly operation?: string
	readonly parentOperation?: string
	readonly status?: "ok" | "error"
	readonly lookback?: string
	readonly limit?: number
	readonly attributes?: AttributeFilters
	readonly attributeContains?: AttributeFilters
}

export type SearchLogsInput = {
	readonly service?: string
	readonly severity?: string
	readonly traceId?: string
	readonly spanId?: string
	readonly body?: string
	readonly lookback?: string
	readonly limit?: number
	readonly cursor?: string
	readonly attributes?: AttributeFilters
	readonly attributeContains?: AttributeFilters
}

export type TraceStatsInput = {
	readonly groupBy: string
	readonly agg: "count" | "avg_duration" | "p95_duration" | "error_rate"
	readonly service?: string
	readonly operation?: string
	readonly status?: "ok" | "error"
	readonly minDurationMs?: number
	readonly lookback?: string
	readonly limit?: number
	readonly attributes?: AttributeFilters
}

export type LogStatsInput = {
	readonly groupBy: string
	readonly service?: string
	readonly traceId?: string
	readonly spanId?: string
	readonly body?: string
	readonly lookback?: string
	readonly limit?: number
	readonly attributes?: AttributeFilters
}

export type FacetsInput = {
	readonly type: "traces" | "logs"
	readonly field: string
	readonly key?: string
	readonly service?: string
	readonly lookback?: string
	readonly limit?: number
}

export type TraceLogOptions = {
	readonly lookback?: string
	readonly limit?: number
	readonly cursor?: string
}

export type AiCallSearchInput = {
	readonly service?: string
	readonly traceId?: string
	readonly sessionId?: string
	readonly functionId?: string
	readonly provider?: string
	readonly model?: string
	readonly operation?: string
	readonly status?: "ok" | "error"
	readonly minDurationMs?: number
	readonly text?: string
	readonly lookback?: string
	readonly limit?: number
}

export type AiCallStatsInput = {
	readonly groupBy: "provider" | "model" | "functionId" | "sessionId" | "status"
	readonly agg:
		| "count"
		| "avg_duration"
		| "p95_duration"
		| "total_input_tokens"
		| "total_output_tokens"
	readonly service?: string
	readonly traceId?: string
	readonly sessionId?: string
	readonly functionId?: string
	readonly provider?: string
	readonly model?: string
	readonly operation?: string
	readonly status?: "ok" | "error"
	readonly minDurationMs?: number
	readonly lookback?: string
	readonly limit?: number
}

export class MotelClient extends Context.Service<
	MotelClient,
	{
		readonly searchTraces: (
			input: SearchTracesInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly searchSpans: (
			input: SearchSpansInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly getTrace: (
			traceId: string,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly getTraceSpans: (
			traceId: string,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly getTraceLogs: (
			traceId: string,
			options: TraceLogOptions,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly getSpan: (spanId: string) => Effect.Effect<unknown, MotelHttpError>
		readonly getSpanLogs: (
			spanId: string,
			options: TraceLogOptions,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly searchLogs: (
			input: SearchLogsInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly searchAiCalls: (
			input: AiCallSearchInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly getAiCall: (
			spanId: string,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly aiCallStats: (
			input: AiCallStatsInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly traceStats: (
			input: TraceStatsInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly logStats: (
			input: LogStatsInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly facets: (
			input: FacetsInput,
		) => Effect.Effect<unknown, MotelHttpError>
		readonly services: Effect.Effect<unknown, MotelHttpError>
		readonly health: Effect.Effect<unknown, MotelHttpError>
		readonly docs: Effect.Effect<unknown, MotelHttpError>
		readonly getDoc: (name: string) => Effect.Effect<string, MotelHttpError>
		readonly openapi: Effect.Effect<unknown, MotelHttpError>
	}
>()("motel/MotelClient") {}

export const MotelClientLive = Layer.effect(
	MotelClient,
	Effect.gen(function* () {
		const locator = yield* Locator

		const get = Effect.fnUntraced(function* <A = unknown>(
			path: string,
			query?: Query,
			attributes?: AttributeFilters,
			attributeContains?: AttributeFilters,
		) {
			const { url } = yield* Effect.mapError(
				locator.resolve,
				(err) => new MotelHttpError(0, err.message),
			)
			const target = appendAllAttributes(
				appendQuery(new URL(path, url), query),
				attributes,
				attributeContains,
			)
			return yield* Effect.tryPromise({
				try: async () => {
					const res = await fetch(target, {
						signal: AbortSignal.timeout(5000),
					})
					const body = (await res
						.json()
						.catch(() => ({ error: "invalid json" }))) as A
					if (!res.ok)
						throw new MotelHttpError(res.status, JSON.stringify(body))
					return body
				},
				catch: (err) =>
					err instanceof MotelHttpError
						? err
						: new MotelHttpError(0, (err as Error).message),
			}).pipe(
				Effect.tapError((err) =>
					err.status === 0 ? locator.invalidate : Effect.void,
				),
			)
		})

		return {
			searchTraces: (input) =>
				get(
					"/api/traces/search",
					{
						service: input.service,
						operation: input.operation,
						status: input.status,
						minDurationMs: input.minDurationMs,
						lookback: input.lookback,
						limit: input.limit,
						cursor: input.cursor,
					},
					input.attributes,
					input.attributeContains,
				),

			searchSpans: (input) =>
				get(
					"/api/spans/search",
					{
						service: input.service,
						traceId: input.traceId,
						operation: input.operation,
						parentOperation: input.parentOperation,
						status: input.status,
						lookback: input.lookback,
						limit: input.limit,
					},
					input.attributes,
					input.attributeContains,
				),

			getTrace: (traceId) => get(`/api/traces/${encodeURIComponent(traceId)}`),

			getTraceSpans: (traceId) =>
				get(`/api/traces/${encodeURIComponent(traceId)}/spans`),

			getTraceLogs: (traceId, options) =>
				get(`/api/traces/${encodeURIComponent(traceId)}/logs`, {
					lookback: options.lookback,
					limit: options.limit,
					cursor: options.cursor,
				}),

			getSpan: (spanId) => get(`/api/spans/${encodeURIComponent(spanId)}`),

			getSpanLogs: (spanId, options) =>
				get(`/api/spans/${encodeURIComponent(spanId)}/logs`, {
					lookback: options.lookback,
					limit: options.limit,
					cursor: options.cursor,
				}),

			searchLogs: (input) =>
				get(
					"/api/logs/search",
					{
						service: input.service,
						severity: input.severity,
						traceId: input.traceId,
						spanId: input.spanId,
						body: input.body,
						lookback: input.lookback,
						limit: input.limit,
						cursor: input.cursor,
					},
					input.attributes,
					input.attributeContains,
				),

			searchAiCalls: (input) =>
				get("/api/ai/calls", {
					service: input.service,
					traceId: input.traceId,
					sessionId: input.sessionId,
					functionId: input.functionId,
					provider: input.provider,
					model: input.model,
					operation: input.operation,
					status: input.status,
					minDurationMs: input.minDurationMs,
					text: input.text,
					lookback: input.lookback,
					limit: input.limit,
				}),

			getAiCall: (spanId) => get(`/api/ai/calls/${encodeURIComponent(spanId)}`),

			aiCallStats: (input) =>
				get("/api/ai/stats", {
					groupBy: input.groupBy,
					agg: input.agg,
					service: input.service,
					traceId: input.traceId,
					sessionId: input.sessionId,
					functionId: input.functionId,
					provider: input.provider,
					model: input.model,
					operation: input.operation,
					status: input.status,
					minDurationMs: input.minDurationMs,
					lookback: input.lookback,
					limit: input.limit,
				}),

			traceStats: (input) =>
				get(
					"/api/traces/stats",
					{
						groupBy: input.groupBy,
						agg: input.agg,
						service: input.service,
						operation: input.operation,
						status: input.status,
						minDurationMs: input.minDurationMs,
						lookback: input.lookback,
						limit: input.limit,
					},
					input.attributes,
				),

			logStats: (input) =>
				get(
					"/api/logs/stats",
					{
						groupBy: input.groupBy,
						agg: "count",
						service: input.service,
						traceId: input.traceId,
						spanId: input.spanId,
						body: input.body,
						lookback: input.lookback,
						limit: input.limit,
					},
					input.attributes,
				),

			facets: (input) =>
				get("/api/facets", {
					type: input.type,
					field: input.field,
					key: input.key,
					service: input.service,
					lookback: input.lookback,
					limit: input.limit,
				}),

			services: get("/api/services"),

			health: get("/api/health"),

			docs: get("/api/docs"),

			getDoc: (name) =>
				Effect.gen(function* () {
					const { url } = yield* Effect.mapError(
						locator.resolve,
						(err) => new MotelHttpError(0, err.message),
					)
					return yield* Effect.tryPromise({
						try: async () => {
							const res = await fetch(
								new URL(`/api/docs/${encodeURIComponent(name)}`, url),
								{
									signal: AbortSignal.timeout(5000),
								},
							)
							const body = await res.text()
							if (!res.ok) throw new MotelHttpError(res.status, body)
							return body
						},
						catch: (err) =>
							err instanceof MotelHttpError
								? err
								: new MotelHttpError(0, (err as Error).message),
					}).pipe(
						Effect.tapError((err) =>
							err.status === 0 ? locator.invalidate : Effect.void,
						),
					)
				}),

			openapi: get("/openapi.json"),
		}
	}),
)
