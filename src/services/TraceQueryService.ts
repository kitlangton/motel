import { Effect, Layer, Context } from "effect"
import type {
	AiCallDetail,
	SpanItem,
	TraceItem,
	TraceSummaryItem,
} from "../domain.js"
import { TelemetryStore } from "./TelemetryStore.js"

export class TraceQueryService extends Context.Service<
	TraceQueryService,
	{
		readonly listServices: Effect.Effect<readonly string[], Error>
		readonly listRecentTraces: (
			serviceName: string,
			options?: {
				readonly lookbackMinutes?: number
				readonly limit?: number
				readonly cursorStartedAtMs?: number
				readonly cursorTraceId?: string
			},
		) => Effect.Effect<readonly TraceItem[], Error>
		readonly listTraceSummaries: (
			serviceName: string | null,
			options?: {
				readonly lookbackMinutes?: number
				readonly limit?: number
				readonly cursorStartedAtMs?: number
				readonly cursorTraceId?: string
			},
		) => Effect.Effect<readonly TraceSummaryItem[], Error>
		readonly searchTraceSummaries: (input: {
			readonly serviceName?: string | null
			readonly operation?: string | null
			readonly status?: "ok" | "error" | null
			readonly minDurationMs?: number | null
			readonly lookbackMinutes?: number
			readonly limit?: number
			readonly attributeFilters?: Readonly<Record<string, string>>
			readonly aiText?: string | null
			readonly cursorStartedAtMs?: number
			readonly cursorTraceId?: string
		}) => Effect.Effect<readonly TraceSummaryItem[], Error>
		readonly listFacets: (input: {
			readonly type: "traces" | "logs"
			readonly field: string
			readonly serviceName?: string | null
			readonly key?: string | null
			readonly lookbackMinutes?: number
			readonly limit?: number
		}) => Effect.Effect<
			readonly { readonly value: string; readonly count: number }[],
			Error
		>
		readonly searchTraces: (input: {
			readonly serviceName?: string | null
			readonly operation?: string | null
			readonly status?: "ok" | "error" | null
			readonly minDurationMs?: number | null
			readonly lookbackMinutes?: number
			readonly limit?: number
			readonly attributeFilters?: Readonly<Record<string, string>>
		}) => Effect.Effect<readonly TraceItem[], Error>
		readonly traceStats: (input: {
			readonly groupBy: string
			readonly agg: "count" | "avg_duration" | "p95_duration" | "error_rate"
			readonly serviceName?: string | null
			readonly operation?: string | null
			readonly status?: "ok" | "error" | null
			readonly minDurationMs?: number | null
			readonly lookbackMinutes?: number
			readonly limit?: number
			readonly attributeFilters?: Readonly<Record<string, string>>
		}) => Effect.Effect<
			readonly {
				readonly group: string
				readonly value: number
				readonly count: number
			}[],
			Error
		>
		readonly getTrace: (
			traceId: string,
		) => Effect.Effect<TraceItem | null, Error>
		readonly getSpan: (spanId: string) => Effect.Effect<SpanItem | null, Error>
		readonly getAiCall: (
			spanId: string,
		) => Effect.Effect<AiCallDetail | null, Error>
		readonly listTraceSpans: (
			traceId: string,
		) => Effect.Effect<readonly SpanItem[], Error>
		readonly searchSpans: (input: {
			readonly serviceName?: string | null
			readonly traceId?: string | null
			readonly operation?: string | null
			readonly parentOperation?: string | null
			readonly status?: "ok" | "error" | null
			readonly lookbackMinutes?: number
			readonly limit?: number
			readonly attributeFilters?: Readonly<Record<string, string>>
			readonly attributeContainsFilters?: Readonly<Record<string, string>>
		}) => Effect.Effect<readonly SpanItem[], Error>
	}
>()("motel/TraceQueryService") {}

export const TraceQueryServiceLive = Layer.effect(
	TraceQueryService,
	Effect.gen(function* () {
		const store = yield* TelemetryStore

		const listServices = Effect.gen(function* () {
			const services = yield* store.listServices
			yield* Effect.annotateCurrentSpan("trace.service_count", services.length)
			return services
		}).pipe(Effect.withSpan("motel/TraceQueryService.listServices"))

		const listRecentTraces = Effect.fn(
			"motel/TraceQueryService.listRecentTraces",
		)(function* (
			serviceName: string,
			options?: {
				readonly lookbackMinutes?: number
				readonly limit?: number
				readonly cursorStartedAtMs?: number
				readonly cursorTraceId?: string
			},
		) {
			yield* Effect.annotateCurrentSpan({
				"trace.service_name": serviceName,
			})
			const traces = yield* store.listRecentTraces(serviceName, options)
			yield* Effect.annotateCurrentSpan("trace.result_count", traces.length)
			return traces
		})

		const listTraceSummaries = Effect.fn(
			"motel/TraceQueryService.listTraceSummaries",
		)(function* (
			serviceName: string | null,
			options?: {
				readonly lookbackMinutes?: number
				readonly limit?: number
				readonly cursorStartedAtMs?: number
				readonly cursorTraceId?: string
			},
		) {
			yield* Effect.annotateCurrentSpan({
				"trace.service_name": serviceName,
			})
			const traces = yield* store.listTraceSummaries(serviceName, options)
			yield* Effect.annotateCurrentSpan("trace.result_count", traces.length)
			return traces
		})

		const getTrace = Effect.fn("motel/TraceQueryService.getTrace")(function* (
			traceId: string,
		) {
			yield* Effect.annotateCurrentSpan("trace.trace_id", traceId)
			return yield* store.getTrace(traceId)
		})

		const getSpan = Effect.fn("motel/TraceQueryService.getSpan")(function* (
			spanId: string,
		) {
			yield* Effect.annotateCurrentSpan("trace.span_id", spanId)
			return yield* store.getSpan(spanId)
		})

		return TraceQueryService.of({
			listServices,
			listRecentTraces,
			listTraceSummaries,
			searchTraceSummaries: store.searchTraceSummaries,
			listFacets: store.listFacets,
			searchTraces: store.searchTraces,
			traceStats: store.traceStats,
			getTrace,
			getSpan,
			getAiCall: store.getAiCall,
			listTraceSpans: store.listTraceSpans,
			searchSpans: store.searchSpans,
		})
	}),
)
