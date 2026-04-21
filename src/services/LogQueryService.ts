import { Effect, Layer, Context } from "effect"
import type { LogItem } from "../domain.js"
import { TelemetryStore } from "./TelemetryStore.js"

export class LogQueryService extends Context.Service<
	LogQueryService,
	{
		readonly listRecentLogs: (
			serviceName: string,
		) => Effect.Effect<readonly LogItem[], Error>
		readonly listTraceLogs: (
			traceId: string,
		) => Effect.Effect<readonly LogItem[], Error>
		readonly searchLogs: (input: {
			readonly serviceName?: string | null
			readonly severity?: string | null
			readonly traceId?: string | null
			readonly spanId?: string | null
			readonly body?: string | null
			readonly lookbackMinutes?: number
			readonly limit?: number
			readonly cursorTimestampMs?: number
			readonly cursorId?: string
			readonly attributeFilters?: Readonly<Record<string, string>>
			readonly attributeContainsFilters?: Readonly<Record<string, string>>
		}) => Effect.Effect<readonly LogItem[], Error>
		readonly logStats: (input: {
			readonly groupBy: string
			readonly agg: "count"
			readonly serviceName?: string | null
			readonly traceId?: string | null
			readonly spanId?: string | null
			readonly body?: string | null
			readonly lookbackMinutes?: number
			readonly limit?: number
			readonly attributeFilters?: Readonly<Record<string, string>>
			readonly attributeContainsFilters?: Readonly<Record<string, string>>
		}) => Effect.Effect<
			readonly {
				readonly group: string
				readonly value: number
				readonly count: number
			}[],
			Error
		>
		readonly listFacets: (input: {
			readonly type: "traces" | "logs"
			readonly field: string
			readonly serviceName?: string | null
			readonly lookbackMinutes?: number
			readonly limit?: number
		}) => Effect.Effect<
			readonly { readonly value: string; readonly count: number }[],
			Error
		>
	}
>()("motel/LogQueryService") {}

export const LogQueryServiceLive = Layer.effect(
	LogQueryService,
	Effect.gen(function* () {
		const store = yield* TelemetryStore

		const listRecentLogs = Effect.fn("motel/LogQueryService.listRecentLogs")(
			function* (serviceName: string) {
				yield* Effect.annotateCurrentSpan("log.service_name", serviceName)
				const logs = yield* store.listRecentLogs(serviceName)
				yield* Effect.annotateCurrentSpan("log.result_count", logs.length)
				return logs
			},
		)

		const listTraceLogs = Effect.fn("motel/LogQueryService.listTraceLogs")(
			function* (traceId: string) {
				yield* Effect.annotateCurrentSpan("log.trace_id", traceId)
				const logs = yield* store.listTraceLogs(traceId)
				yield* Effect.annotateCurrentSpan("log.result_count", logs.length)
				return logs
			},
		)

		return LogQueryService.of({
			listRecentLogs,
			listTraceLogs,
			searchLogs: store.searchLogs,
			logStats: store.logStats,
			listFacets: store.listFacets,
		})
	}),
)
