import { Effect, Layer, ServiceMap } from "effect"
import type { LogItem } from "../domain.js"
import { TelemetryStore } from "./TelemetryStore.js"

export class LogQueryService extends ServiceMap.Service<
	LogQueryService,
	{
		readonly listRecentLogs: (serviceName: string) => Effect.Effect<readonly LogItem[], Error>
		readonly listTraceLogs: (traceId: string) => Effect.Effect<readonly LogItem[], Error>
		readonly searchLogs: (input: { readonly serviceName?: string; readonly traceId?: string; readonly spanId?: string; readonly body?: string; readonly limit?: number; readonly attributeFilters?: Readonly<Record<string, string>> }) => Effect.Effect<readonly LogItem[], Error>
		readonly listFacets: (input: { readonly type: "traces" | "logs"; readonly field: string; readonly serviceName?: string | null; readonly lookbackMinutes?: number; readonly limit?: number }) => Effect.Effect<readonly { readonly value: string; readonly count: number }[], Error>
	}
>()("leto/LogQueryService") {}

export const LogQueryServiceLive = Layer.effect(
	LogQueryService,
	Effect.gen(function* () {
		const store = yield* TelemetryStore

		const listRecentLogs = Effect.fn("leto/LogQueryService.listRecentLogs")(function* (serviceName: string) {
			yield* Effect.annotateCurrentSpan("log.service_name", serviceName)
			const logs = yield* store.listRecentLogs(serviceName)
			yield* Effect.annotateCurrentSpan("log.result_count", logs.length)
			return logs
		})

		const listTraceLogs = Effect.fn("leto/LogQueryService.listTraceLogs")(function* (traceId: string) {
			yield* Effect.annotateCurrentSpan("log.trace_id", traceId)
			const logs = yield* store.listTraceLogs(traceId)
			yield* Effect.annotateCurrentSpan("log.result_count", logs.length)
			return logs
		})

		const searchLogs = Effect.fn("leto/LogQueryService.searchLogs")(function* (input: { readonly serviceName?: string; readonly traceId?: string; readonly spanId?: string; readonly body?: string; readonly limit?: number; readonly attributeFilters?: Readonly<Record<string, string>> }) {
			return yield* store.searchLogs(input)
		})

		const listFacets = Effect.fn("leto/LogQueryService.listFacets")(function* (input: { readonly type: "traces" | "logs"; readonly field: string; readonly serviceName?: string | null; readonly lookbackMinutes?: number; readonly limit?: number }) {
			return yield* store.listFacets(input)
		})

		return LogQueryService.of({ listRecentLogs, listTraceLogs, searchLogs, listFacets })
	}),
)
