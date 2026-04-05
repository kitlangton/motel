import { Effect, References } from "effect"
import { config } from "./config.js"
import { effectSetupInstructions } from "./instructions.js"
import { queryRuntime } from "./runtime.js"
import { LogQueryService } from "./services/LogQueryService.js"
import { TraceQueryService } from "./services/TraceQueryService.js"

const [command, ...args] = process.argv.slice(2)

const runQuiet = <A, E, R extends TraceQueryService | LogQueryService | never>(effect: Effect.Effect<A, E, R>) =>
	queryRuntime.runPromise(effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")))

switch (command) {
	case "services": {
		const result = await runQuiet(Effect.flatMap(TraceQueryService.asEffect(), (query) => query.listServices))
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "traces": {
		const service = args[0] ?? config.otel.serviceName
		const limit = args[1] ? Number.parseInt(args[1], 10) : config.otel.traceFetchLimit
		const result = await runQuiet(Effect.flatMap(TraceQueryService.asEffect(), (query) => query.listRecentTraces(service, { limit })))
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "trace": {
		const traceId = args[0]
		if (!traceId) {
			throw new Error("Usage: bun run cli trace <trace-id>")
		}

		const result = await runQuiet(Effect.flatMap(TraceQueryService.asEffect(), (query) => query.getTrace(traceId)))
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "search-traces": {
		const service = args[0] ?? config.otel.serviceName
		const operation = args[1] ?? undefined
		const result = await runQuiet(
			Effect.flatMap(TraceQueryService.asEffect(), (query) =>
				query.searchTraces({
					serviceName: service,
					operation,
					limit: config.otel.traceFetchLimit,
				}),
			),
		)
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "instructions": {
		console.log(effectSetupInstructions())
		break
	}

	case "logs": {
		const service = args[0] ?? config.otel.serviceName
		const result = await runQuiet(Effect.flatMap(LogQueryService.asEffect(), (query) => query.listRecentLogs(service)))
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "search-logs": {
		const service = args[0] ?? config.otel.serviceName
		const body = args[1] ?? undefined
		const result = await runQuiet(
			Effect.flatMap(LogQueryService.asEffect(), (query) =>
				query.searchLogs({
					serviceName: service,
					body,
					limit: config.otel.logFetchLimit,
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

		const result = await runQuiet(Effect.flatMap(LogQueryService.asEffect(), (query) => query.listTraceLogs(traceId)))
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
		console.log(JSON.stringify({
			baseUrl: config.otel.baseUrl,
			exporterUrl: config.otel.exporterUrl,
			logsExporterUrl: config.otel.logsExporterUrl,
			queryUrl: config.otel.queryUrl,
			databasePath: config.otel.databasePath,
		}, null, 2))
		break
	}

	default: {
		console.log(`Usage:
	bun run cli services
	bun run cli traces [service] [limit]
	bun run cli trace <trace-id>
	bun run cli search-traces [service] [operation]
	bun run cli logs [service]
	bun run cli search-logs [service] [body]
	bun run cli trace-logs <trace-id>
	bun run cli facets <traces|logs> <field>
	bun run cli instructions
	bun run cli endpoints`)
	}
}
