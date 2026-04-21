import { Effect, References } from "effect"
import { config } from "./config.js"
import { otelServerInstructions } from "./instructions.js"
import {
	attributeFiltersFromArgs,
	isAttributeFilterToken,
} from "./queryFilters.js"
import { queryRuntime } from "./runtime.js"
import { LogQueryService } from "./services/LogQueryService.js"
import { TraceQueryService } from "./services/TraceQueryService.js"

const [command, ...args] = process.argv.slice(2)

const runQuiet = <A, E, R extends TraceQueryService | LogQueryService | never>(
	effect: Effect.Effect<A, E, R>,
) =>
	queryRuntime.runPromise(
		effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")),
	)

try {
	switch (command) {
		case "services": {
			const result = await runQuiet(
				Effect.flatMap(
					TraceQueryService.asEffect(),
					(query) => query.listServices,
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "traces": {
			const service = args[0] ?? config.otel.serviceName
			const limit = args[1]
				? Number.parseInt(args[1], 10)
				: config.otel.traceFetchLimit
			const result = await runQuiet(
				Effect.flatMap(TraceQueryService.asEffect(), (query) =>
					query.listRecentTraces(service, { limit }),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "trace": {
			const traceId = args[0]
			if (!traceId) {
				throw new Error("Usage: bun run cli trace <trace-id>")
			}

			const result = await runQuiet(
				Effect.flatMap(TraceQueryService.asEffect(), (query) =>
					query.getTrace(traceId),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "span": {
			const spanId = args[0]
			if (!spanId) {
				throw new Error("Usage: bun run cli span <span-id>")
			}

			const result = await fetch(
				`${config.otel.queryUrl}/api/spans/${encodeURIComponent(spanId)}`,
			).then((response) => response.json())
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "trace-spans": {
			const traceId = args[0]
			if (!traceId) {
				throw new Error("Usage: bun run cli trace-spans <trace-id>")
			}

			const result = await runQuiet(
				Effect.flatMap(TraceQueryService.asEffect(), (query) =>
					query.listTraceSpans(traceId),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "search-spans": {
			const service = args[0] ?? config.otel.serviceName
			const operation =
				args[1] &&
				!isAttributeFilterToken(args[1]) &&
				!args[1].startsWith("parent=")
					? args[1]
					: undefined
			const parentTokenIndex = args.findIndex(
				(value, index) => index > 0 && value.startsWith("parent="),
			)
			const parentOperation =
				parentTokenIndex >= 0
					? args[parentTokenIndex]?.slice("parent=".length)
					: undefined
			const attributeStartIndex = operation ? 2 : 1
			const attributeFilters = attributeFiltersFromArgs(
				args.slice(attributeStartIndex),
			)
			const result = await runQuiet(
				Effect.flatMap(TraceQueryService.asEffect(), (query) =>
					query.searchSpans({
						serviceName: service,
						operation,
						parentOperation,
						attributeFilters,
						limit: config.otel.logFetchLimit,
					}),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "search-traces": {
			const service = args[0] ?? config.otel.serviceName
			const operation =
				args[1] && !isAttributeFilterToken(args[1]) ? args[1] : undefined
			const attributeFilters = attributeFiltersFromArgs(
				args.slice(operation ? 2 : 1),
			)
			const result = await runQuiet(
				Effect.flatMap(TraceQueryService.asEffect(), (query) =>
					query.searchTraces({
						serviceName: service,
						operation,
						attributeFilters,
						limit: config.otel.traceFetchLimit,
					}),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "trace-stats": {
			const groupBy = args[0]
			const agg = args[1]
			const service =
				args[2] && !isAttributeFilterToken(args[2]) ? args[2] : undefined
			const attributeFilters = attributeFiltersFromArgs(
				args.slice(service ? 3 : 2),
			)
			if (
				!groupBy ||
				(agg !== "count" &&
					agg !== "avg_duration" &&
					agg !== "p95_duration" &&
					agg !== "error_rate")
			) {
				throw new Error(
					"Usage: bun run cli trace-stats <groupBy> <count|avg_duration|p95_duration|error_rate> [service]",
				)
			}

			const result = await runQuiet(
				Effect.flatMap(TraceQueryService.asEffect(), (query) =>
					query.traceStats({
						groupBy,
						agg,
						serviceName: service,
						attributeFilters,
						limit: 20,
					}),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "instructions": {
			console.log(otelServerInstructions())
			break
		}

		case "logs": {
			const service = args[0] ?? config.otel.serviceName
			const result = await runQuiet(
				Effect.flatMap(LogQueryService.asEffect(), (query) =>
					query.listRecentLogs(service),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "search-logs": {
			const service = args[0] ?? config.otel.serviceName
			const body =
				args[1] && !isAttributeFilterToken(args[1]) ? args[1] : undefined
			const attributeFilters = attributeFiltersFromArgs(
				args.slice(body ? 2 : 1),
			)
			const result = await runQuiet(
				Effect.flatMap(LogQueryService.asEffect(), (query) =>
					query.searchLogs({
						serviceName: service,
						body,
						attributeFilters,
						limit: config.otel.logFetchLimit,
					}),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "log-stats": {
			const groupBy = args[0]
			const service =
				args[1] && !isAttributeFilterToken(args[1]) ? args[1] : undefined
			const attributeFilters = attributeFiltersFromArgs(
				args.slice(service ? 2 : 1),
			)
			if (!groupBy) {
				throw new Error("Usage: bun run cli log-stats <groupBy> [service]")
			}

			const result = await runQuiet(
				Effect.flatMap(LogQueryService.asEffect(), (query) =>
					query.logStats({
						groupBy,
						agg: "count",
						serviceName: service,
						attributeFilters,
						limit: 20,
					}),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "trace-logs": {
			const traceId = args[0]
			if (!traceId) {
				throw new Error("Usage: bun run cli trace-logs <trace-id>")
			}

			const result = await runQuiet(
				Effect.flatMap(LogQueryService.asEffect(), (query) =>
					query.listTraceLogs(traceId),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "span-logs": {
			const spanId = args[0]
			if (!spanId) {
				throw new Error("Usage: bun run cli span-logs <span-id>")
			}

			const result = await runQuiet(
				Effect.flatMap(LogQueryService.asEffect(), (query) =>
					query.searchLogs({
						spanId,
						limit: config.otel.logFetchLimit,
					}),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "facets": {
			const type = args[0]
			const field = args[1]
			if ((type !== "traces" && type !== "logs") || !field) {
				throw new Error("Usage: bun run cli facets <traces|logs> <field>")
			}

			const result = await runQuiet(
				Effect.flatMap(LogQueryService.asEffect(), (query) =>
					query.listFacets({ type, field, limit: 20 }),
				),
			)
			console.log(JSON.stringify(result, null, 2))
			break
		}

		case "endpoints": {
			console.log(
				JSON.stringify(
					{
						baseUrl: config.otel.baseUrl,
						exporterUrl: config.otel.exporterUrl,
						logsExporterUrl: config.otel.logsExporterUrl,
						queryUrl: config.otel.queryUrl,
						databasePath: config.otel.databasePath,
					},
					null,
					2,
				),
			)
			break
		}

		default: {
			console.log(`Usage:
	bun run cli services
	bun run cli traces [service] [limit]
	bun run cli trace <trace-id>
	bun run cli span <span-id>
	bun run cli trace-spans <trace-id>
	bun run cli search-spans [service] [operation] [parent=<operation>] [attr.key=value ...]
	bun run cli search-traces [service] [operation] [attr.key=value ...]
	bun run cli trace-stats <groupBy> <agg> [service] [attr.key=value ...]
	bun run cli logs [service]
	bun run cli search-logs [service] [body] [attr.key=value ...]
	bun run cli log-stats <groupBy> [service] [attr.key=value ...]
	bun run cli trace-logs <trace-id>
	bun run cli span-logs <span-id>
	bun run cli facets <traces|logs> <field>
	bun run cli instructions
	bun run cli endpoints`)
		}
	}
} finally {
	await queryRuntime.dispose()
}
