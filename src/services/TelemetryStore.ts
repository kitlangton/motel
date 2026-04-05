import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Clock, Effect, Layer, ServiceMap } from "effect"
import { config } from "../config.js"
import type { LogItem, TraceItem, TraceSpanEvent, TraceSpanItem } from "../domain.js"
import { attributeMap, nanosToMilliseconds, parseAnyValue, spanKindLabel, spanStatusLabel, stringifyValue, type OtlpLogExportRequest, type OtlpTraceExportRequest } from "../otlp.js"

interface SpanRow {
	readonly trace_id: string
	readonly span_id: string
	readonly parent_span_id: string | null
	readonly service_name: string
	readonly scope_name: string | null
	readonly operation_name: string
	readonly kind: string | null
	readonly start_time_ms: number
	readonly end_time_ms: number
	readonly duration_ms: number
	readonly status: string
	readonly attributes_json: string
	readonly resource_json: string
	readonly events_json: string
}

interface LogRow {
	readonly id: number
	readonly trace_id: string | null
	readonly span_id: string | null
	readonly service_name: string
	readonly scope_name: string | null
	readonly severity_text: string
	readonly timestamp_ms: number
	readonly body: string
	readonly attributes_json: string
	readonly resource_json: string
}

interface LogSearch {
	readonly serviceName?: string | null
	readonly traceId?: string | null
	readonly spanId?: string | null
	readonly body?: string | null
	readonly limit?: number
	readonly attributeFilters?: Readonly<Record<string, string>>
}

interface TraceSearch {
	readonly serviceName?: string | null
	readonly operation?: string | null
	readonly status?: "ok" | "error" | null
	readonly minDurationMs?: number | null
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface FacetItem {
	readonly value: string
	readonly count: number
}

interface FacetSearch {
	readonly type: "traces" | "logs"
	readonly field: string
	readonly serviceName?: string | null
	readonly lookbackMinutes?: number
	readonly limit?: number
}

const parseRecord = (value: string): Record<string, string> => {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>
		return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, stringifyValue(entry)]))
	} catch {
		return {}
	}
}

const parseEvents = (value: string): readonly TraceSpanEvent[] => {
	try {
		const parsed = JSON.parse(value) as Array<{ name: string; timestamp: number; attributes: Record<string, string> }>
		return parsed.map((event) => ({
			name: event.name,
			timestamp: new Date(event.timestamp),
			attributes: event.attributes,
		}))
	} catch {
		return []
	}
}

const parseSpanRow = (row: SpanRow): TraceSpanItem => ({
	spanId: row.span_id,
	parentSpanId: row.parent_span_id,
	serviceName: row.service_name,
	scopeName: row.scope_name,
	kind: row.kind,
	operationName: row.operation_name,
	startTime: new Date(row.start_time_ms),
	durationMs: row.duration_ms,
	status: row.status === "error" ? "error" : "ok",
	depth: 0,
	tags: parseRecord(row.attributes_json),
	warnings: [],
	events: parseEvents(row.events_json),
})

const parseLogRow = (row: LogRow): LogItem => ({
	id: String(row.id),
	timestamp: new Date(row.timestamp_ms),
	serviceName: row.service_name,
	severityText: row.severity_text,
	body: row.body,
	traceId: row.trace_id,
	spanId: row.span_id,
	scopeName: row.scope_name,
	attributes: {
		...parseRecord(row.resource_json),
		...parseRecord(row.attributes_json),
	},
})

const orderTraceSpans = (spans: readonly TraceSpanItem[]) => {
	const childrenByParent = new Map<string | null, TraceSpanItem[]>()
	const spanIds = new Set(spans.map((span) => span.spanId))

	for (const span of spans) {
		const key = span.parentSpanId && spanIds.has(span.parentSpanId) ? span.parentSpanId : null
		const siblings = childrenByParent.get(key) ?? []
		siblings.push(span)
		childrenByParent.set(key, siblings)
	}

	for (const siblings of childrenByParent.values()) {
		siblings.sort((left, right) => left.startTime.getTime() - right.startTime.getTime())
	}

	const ordered: Array<TraceSpanItem> = []
	const visit = (parent: string | null, depth: number) => {
		for (const child of childrenByParent.get(parent) ?? []) {
			ordered.push({ ...child, depth })
			visit(child.spanId, depth + 1)
		}
	}

	visit(null, 0)
	return ordered
}

const buildTrace = (traceId: string, spanRows: readonly SpanRow[]): TraceItem => {
	const parsedSpans = spanRows.map(parseSpanRow)
	const orderedSpans = orderTraceSpans(parsedSpans)
	const startedAtMs = Math.min(...orderedSpans.map((span) => span.startTime.getTime()))
	const endedAtMs = Math.max(...orderedSpans.map((span) => span.startTime.getTime() + span.durationMs))
	const rootSpan = orderedSpans[0] ?? null
	const spanIds = new Set(orderedSpans.map((span) => span.spanId))
	const warnings = orderedSpans
		.filter((span) => span.parentSpanId !== null && !spanIds.has(span.parentSpanId))
		.map((span) => `missing parent ${span.parentSpanId} for ${span.operationName}`)

	return {
		traceId,
		serviceName: rootSpan?.serviceName ?? "unknown",
		rootOperationName: rootSpan?.operationName ?? "unknown",
		startedAt: new Date(startedAtMs),
		durationMs: Math.max(0, endedAtMs - startedAtMs),
		spanCount: orderedSpans.length,
		errorCount: orderedSpans.filter((span) => span.status === "error").length,
		warnings,
		spans: orderedSpans,
	}
}

export class TelemetryStore extends ServiceMap.Service<
	TelemetryStore,
	{
		readonly ingestTraces: (payload: OtlpTraceExportRequest) => Effect.Effect<{ readonly insertedSpans: number }, Error>
		readonly ingestLogs: (payload: OtlpLogExportRequest) => Effect.Effect<{ readonly insertedLogs: number }, Error>
		readonly listServices: Effect.Effect<readonly string[], Error>
		readonly listRecentTraces: (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) => Effect.Effect<readonly TraceItem[], Error>
		readonly searchTraces: (input: TraceSearch) => Effect.Effect<readonly TraceItem[], Error>
		readonly getTrace: (traceId: string) => Effect.Effect<TraceItem | null, Error>
		readonly searchLogs: (input: LogSearch) => Effect.Effect<readonly LogItem[], Error>
		readonly listFacets: (input: FacetSearch) => Effect.Effect<readonly FacetItem[], Error>
		readonly listRecentLogs: (serviceName: string) => Effect.Effect<readonly LogItem[], Error>
		readonly listTraceLogs: (traceId: string) => Effect.Effect<readonly LogItem[], Error>
	}
>()("leto/TelemetryStore") {}

export const TelemetryStoreLive = Layer.sync(
	TelemetryStore,
	() => {
		mkdirSync(dirname(config.otel.databasePath), { recursive: true })
		const db = new Database(config.otel.databasePath, { create: true })
		db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA temp_store = MEMORY;
			PRAGMA busy_timeout = 5000;

			CREATE TABLE IF NOT EXISTS spans (
				trace_id TEXT NOT NULL,
				span_id TEXT NOT NULL,
				parent_span_id TEXT,
				service_name TEXT NOT NULL,
				scope_name TEXT,
				operation_name TEXT NOT NULL,
				kind TEXT,
				start_time_ms INTEGER NOT NULL,
				end_time_ms INTEGER NOT NULL,
				duration_ms REAL NOT NULL,
				status TEXT NOT NULL,
				attributes_json TEXT NOT NULL,
				resource_json TEXT NOT NULL,
				events_json TEXT NOT NULL,
				PRIMARY KEY (trace_id, span_id)
			);

			CREATE INDEX IF NOT EXISTS idx_spans_service_time ON spans(service_name, start_time_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_spans_trace_time ON spans(trace_id, start_time_ms ASC);

			CREATE TABLE IF NOT EXISTS logs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				trace_id TEXT,
				span_id TEXT,
				service_name TEXT NOT NULL,
				scope_name TEXT,
				severity_text TEXT NOT NULL,
				timestamp_ms INTEGER NOT NULL,
				body TEXT NOT NULL,
				attributes_json TEXT NOT NULL,
				resource_json TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_logs_service_time ON logs(service_name, timestamp_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_logs_trace_time ON logs(trace_id, timestamp_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_logs_span_time ON logs(span_id, timestamp_ms DESC);
		`)

		const insertSpan = db.query(`
			INSERT INTO spans (
				trace_id, span_id, parent_span_id, service_name, scope_name, operation_name, kind,
				start_time_ms, end_time_ms, duration_ms, status, attributes_json, resource_json, events_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(trace_id, span_id) DO UPDATE SET
				parent_span_id = excluded.parent_span_id,
				service_name = excluded.service_name,
				scope_name = excluded.scope_name,
				operation_name = excluded.operation_name,
				kind = excluded.kind,
				start_time_ms = excluded.start_time_ms,
				end_time_ms = excluded.end_time_ms,
				duration_ms = excluded.duration_ms,
				status = excluded.status,
				attributes_json = excluded.attributes_json,
				resource_json = excluded.resource_json,
				events_json = excluded.events_json
		`)

		const insertLog = db.query(`
			INSERT INTO logs (
				trace_id, span_id, service_name, scope_name, severity_text, timestamp_ms, body, attributes_json, resource_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)

		let lastCleanupAt = 0

		const cleanupExpired = Effect.fn("leto/TelemetryStore.cleanupExpired")(function* () {
			const now = yield* Clock.currentTimeMillis
			if (now - lastCleanupAt < 60_000) return
			lastCleanupAt = now
			const cutoff = now - config.otel.retentionHours * 60 * 60 * 1000
			yield* Effect.sync(() => {
				db.query(`DELETE FROM spans WHERE start_time_ms < ?`).run(cutoff)
				db.query(`DELETE FROM logs WHERE timestamp_ms < ?`).run(cutoff)
			})
		})

		const ingestTraces = Effect.fn("leto/TelemetryStore.ingestTraces")(function* (payload: OtlpTraceExportRequest) {
			yield* cleanupExpired()

			return yield* Effect.sync(() => {
				let insertedSpans = 0
				const transaction = db.transaction((request: OtlpTraceExportRequest) => {
					for (const resourceSpans of request.resourceSpans ?? []) {
						const resourceAttributes = attributeMap(resourceSpans.resource?.attributes)
						const serviceName = resourceAttributes["service.name"] || resourceAttributes["service_name"] || "unknown"

						for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
							const scopeName = scopeSpans.scope?.name ?? null

							for (const span of scopeSpans.spans ?? []) {
								const startTimeMs = nanosToMilliseconds(span.startTimeUnixNano)
								const endTimeMs = nanosToMilliseconds(span.endTimeUnixNano)
								const events = (span.events ?? []).map((event) => ({
									name: event.name ?? "event",
									timestamp: nanosToMilliseconds(event.timeUnixNano),
									attributes: attributeMap(event.attributes),
								}))

								insertSpan.run(
									span.traceId,
									span.spanId,
									span.parentSpanId ?? null,
									serviceName,
									scopeName,
									span.name ?? "unknown",
									spanKindLabel(span.kind),
									startTimeMs,
									endTimeMs,
									Math.max(0, endTimeMs - startTimeMs),
									spanStatusLabel(span.status?.code),
									JSON.stringify(attributeMap(span.attributes)),
									JSON.stringify(resourceAttributes),
									JSON.stringify(events),
								)
								insertedSpans += 1
							}
						}
					}
				})

				transaction(payload)
				return { insertedSpans }
			})
		})

		const ingestLogs = Effect.fn("leto/TelemetryStore.ingestLogs")(function* (payload: OtlpLogExportRequest) {
			yield* cleanupExpired()

			return yield* Effect.sync(() => {
				let insertedLogs = 0
				const transaction = db.transaction((request: OtlpLogExportRequest) => {
					for (const resourceLogs of request.resourceLogs ?? []) {
						const resourceAttributes = attributeMap(resourceLogs.resource?.attributes)
						const serviceName = resourceAttributes["service.name"] || resourceAttributes["service_name"] || "unknown"

						for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
							const scopeName = scopeLogs.scope?.name ?? null

							for (const record of scopeLogs.logRecords ?? []) {
								const attributes = attributeMap(record.attributes)
								const timestampMs = nanosToMilliseconds(record.timeUnixNano ?? record.observedTimeUnixNano)
								insertLog.run(
									attributes.traceId || attributes.trace_id || record.traceId || null,
									attributes.spanId || attributes.span_id || record.spanId || null,
									serviceName,
									scopeName,
									record.severityText ?? "INFO",
									timestampMs,
									stringifyValue(parseAnyValue(record.body)),
									JSON.stringify(attributes),
									JSON.stringify(resourceAttributes),
								)
								insertedLogs += 1
							}
						}
					}
				})

				transaction(payload)
				return { insertedLogs }
			})
		})

		const listServices = Effect.fn("leto/TelemetryStore.listServices")(function* () {
			yield* cleanupExpired()
			const cutoff = (yield* Clock.currentTimeMillis) - config.otel.traceLookbackMinutes * 60 * 1000
			return yield* Effect.sync(() => {
				const rows = db.query(`
					SELECT service_name FROM spans WHERE start_time_ms >= ?
					UNION
					SELECT service_name FROM logs WHERE timestamp_ms >= ?
					ORDER BY service_name ASC
				`).all(cutoff, cutoff) as Array<{ service_name: string }>
				return rows.map((row) => row.service_name)
			})
		})()

		const listRecentTraces = Effect.fn("leto/TelemetryStore.listRecentTraces")(function* (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) {
			yield* cleanupExpired()
			const cutoff = (yield* Clock.currentTimeMillis) - (options?.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = options?.limit ?? config.otel.traceFetchLimit

			return yield* Effect.sync(() => {
				const traceIdRows = serviceName
					? (db.query(`
						SELECT trace_id, MAX(start_time_ms) AS latest_start
						FROM spans
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY latest_start DESC
						LIMIT ?
					`).all(serviceName, cutoff, limit) as Array<{ trace_id: string }>)
					: (db.query(`
						SELECT trace_id, MAX(start_time_ms) AS latest_start
						FROM spans
						WHERE start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY latest_start DESC
						LIMIT ?
					`).all(cutoff, limit) as Array<{ trace_id: string }>)

				const traceIds = traceIdRows.map((row) => row.trace_id)
				if (traceIds.length === 0) return [] as readonly TraceItem[]

				const placeholders = traceIds.map(() => "?").join(", ")
				const rows = db.query(`
					SELECT * FROM spans
					WHERE trace_id IN (${placeholders})
					ORDER BY start_time_ms ASC
				`).all(...traceIds) as SpanRow[]

				const grouped = new Map<string, SpanRow[]>()
				for (const row of rows) {
					const group = grouped.get(row.trace_id) ?? []
					group.push(row)
					grouped.set(row.trace_id, group)
				}

				return traceIds
					.map((traceId) => grouped.get(traceId))
					.filter((rows): rows is SpanRow[] => rows !== undefined)
					.map((rows) => buildTrace(rows[0]!.trace_id, rows))
			})
		})

		const getTrace = Effect.fn("leto/TelemetryStore.getTrace")(function* (traceId: string) {
			return yield* Effect.sync(() => {
				const rows = db.query(`
					SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC
				`).all(traceId) as SpanRow[]
				return rows.length === 0 ? null : buildTrace(traceId, rows)
			})
		})

		const searchTraces = Effect.fn("leto/TelemetryStore.searchTraces")(function* (input: TraceSearch) {
			yield* cleanupExpired()
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? config.otel.traceFetchLimit
			const candidateLimit = Math.max(limit * 10, 200)

			return yield* Effect.sync(() => {
				const traceIdRows = input.serviceName
					? (db.query(`
						SELECT trace_id, MAX(start_time_ms) AS latest_start
						FROM spans
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY latest_start DESC
						LIMIT ?
					`).all(input.serviceName, cutoff, candidateLimit) as Array<{ trace_id: string }>)
					: (db.query(`
						SELECT trace_id, MAX(start_time_ms) AS latest_start
						FROM spans
						WHERE start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY latest_start DESC
						LIMIT ?
					`).all(cutoff, candidateLimit) as Array<{ trace_id: string }>)

				const traceIds = traceIdRows.map((row) => row.trace_id)
				if (traceIds.length === 0) return [] as readonly TraceItem[]

				const placeholders = traceIds.map(() => "?").join(", ")
				const rows = db.query(`
					SELECT * FROM spans
					WHERE trace_id IN (${placeholders})
					ORDER BY start_time_ms ASC
				`).all(...traceIds) as SpanRow[]

				const grouped = new Map<string, SpanRow[]>()
				for (const row of rows) {
					const group = grouped.get(row.trace_id) ?? []
					group.push(row)
					grouped.set(row.trace_id, group)
				}

				return traceIds
					.map((traceId) => grouped.get(traceId))
					.filter((group): group is SpanRow[] => group !== undefined)
					.map((group) => buildTrace(group[0]!.trace_id, group))
					.filter((trace) => {
						if (input.status === "error" && trace.errorCount === 0) return false
						if (input.status === "ok" && trace.errorCount > 0) return false
						if (input.minDurationMs !== undefined && input.minDurationMs !== null && trace.durationMs < input.minDurationMs) return false
						if (input.operation) {
							const needle = input.operation.toLowerCase()
							if (!trace.spans.some((span) => span.operationName.toLowerCase().includes(needle))) return false
						}
						return true
					})
					.slice(0, limit)
			})
		})

		const searchLogs = Effect.fn("leto/TelemetryStore.searchLogs")(function* (input: LogSearch) {
			yield* cleanupExpired()
			return yield* Effect.sync(() => {
				const clauses: string[] = []
				const params: Array<string | number> = []

				if (input.serviceName) {
					clauses.push(`service_name = ?`)
					params.push(input.serviceName)
				}
				if (input.traceId) {
					clauses.push(`trace_id = ?`)
					params.push(input.traceId)
				}
				if (input.spanId) {
					clauses.push(`span_id = ?`)
					params.push(input.spanId)
				}
				if (input.body) {
					clauses.push(`body LIKE ?`)
					params.push(`%${input.body}%`)
				}

				const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
				const limit = input.limit ?? config.otel.logFetchLimit
				const queryLimit = Object.keys(input.attributeFilters ?? {}).length > 0 ? Math.max(limit * 10, 500) : limit
				const rows = db.query(`
					SELECT * FROM logs
					${where}
					ORDER BY timestamp_ms DESC
					LIMIT ?
				`).all(...params, queryLimit) as LogRow[]

				const logs = rows.map(parseLogRow)
				const filtered = Object.entries(input.attributeFilters ?? {}).length === 0
					? logs
					: logs.filter((log) =>
						Object.entries(input.attributeFilters ?? {}).every(([key, value]) => log.attributes[key] === value),
					)

				return filtered.slice(0, limit)
			})
		})

		const listRecentLogs = Effect.fn("leto/TelemetryStore.listRecentLogs")(function* (serviceName: string) {
			return yield* searchLogs({ serviceName, limit: config.otel.logFetchLimit })
		})

		const listFacets = Effect.fn("leto/TelemetryStore.listFacets")(function* (input: FacetSearch) {
			yield* cleanupExpired()
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 20

			return yield* Effect.sync(() => {
				if (input.type === "logs") {
					if (input.field === "service") {
						const rows = db.query(`
							SELECT service_name AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							GROUP BY service_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(cutoff, limit) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "severity") {
						const rows = db.query(`
							SELECT severity_text AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY severity_text
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "scope") {
						const rows = db.query(`
							SELECT COALESCE(scope_name, 'unknown') AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY COALESCE(scope_name, 'unknown')
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
						return rows
					}
				}

				if (input.type === "traces") {
					if (input.field === "service") {
						const rows = db.query(`
							SELECT service_name AS value, COUNT(DISTINCT trace_id) AS count
							FROM spans
							WHERE start_time_ms >= ?
							GROUP BY service_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(cutoff, limit) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "operation") {
						const rows = db.query(`
							SELECT operation_name AS value, COUNT(*) AS count
							FROM spans
							WHERE start_time_ms >= ? AND parent_span_id IS NULL
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY operation_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "status") {
						const traces = (db.query(`
							SELECT trace_id
							FROM spans
							WHERE start_time_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY trace_id
							ORDER BY MAX(start_time_ms) DESC
						`).all(...(input.serviceName ? [cutoff, input.serviceName] : [cutoff])) as Array<{ trace_id: string }>)

						const result = new Map<string, number>()
						for (const row of traces) {
							const group = db.query(`SELECT COUNT(*) AS count FROM spans WHERE trace_id = ? AND status = 'error'`).get(row.trace_id) as { count: number }
							const value = group.count > 0 ? "error" : "ok"
							result.set(value, (result.get(value) ?? 0) + 1)
						}
						return [...result.entries()].map(([value, count]) => ({ value, count })).slice(0, limit)
					}
				}

				return [] as FacetItem[]
			})
		})

		const listTraceLogs = Effect.fn("leto/TelemetryStore.listTraceLogs")(function* (traceId: string) {
			return yield* searchLogs({ traceId, limit: config.otel.logFetchLimit })
		})

		return TelemetryStore.of({
			ingestTraces,
			ingestLogs,
			listServices,
			listRecentTraces,
			searchTraces,
			getTrace,
			searchLogs,
			listFacets,
			listRecentLogs,
			listTraceLogs,
		})
	},
)
