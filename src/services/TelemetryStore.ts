import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Clock, Effect, Layer, Schedule, ServiceMap } from "effect"
import { config } from "../config.js"
import type { LogItem, SpanItem, TraceItem, TraceSpanEvent, TraceSpanItem } from "../domain.js"
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
	readonly lookbackMinutes?: number
	readonly limit?: number
	readonly attributeFilters?: Readonly<Record<string, string>>
}

interface TraceSearch {
	readonly serviceName?: string | null
	readonly operation?: string | null
	readonly status?: "ok" | "error" | null
	readonly minDurationMs?: number | null
	readonly attributeFilters?: Readonly<Record<string, string>>
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface SpanSearch {
	readonly serviceName?: string | null
	readonly operation?: string | null
	readonly parentOperation?: string | null
	readonly status?: "ok" | "error" | null
	readonly lookbackMinutes?: number
	readonly limit?: number
	readonly attributeFilters?: Readonly<Record<string, string>>
}

interface TraceStatsSearch extends TraceSearch {
	readonly groupBy: string
	readonly agg: "count" | "avg_duration" | "p95_duration" | "error_rate"
	readonly limit?: number
}

interface LogStatsSearch extends LogSearch {
	readonly groupBy: string
	readonly agg: "count"
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface FacetItem {
	readonly value: string
	readonly count: number
}

interface StatsItem {
	readonly group: string
	readonly value: number
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
	tags: {
		...parseRecord(row.resource_json),
		...parseRecord(row.attributes_json),
	},
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

const buildSpanItems = (traceId: string, spanRows: readonly SpanRow[]): readonly SpanItem[] => {
	const trace = buildTrace(traceId, spanRows)
	const spanById = new Map(trace.spans.map((span) => [span.spanId, span]))
	return trace.spans.map((span) => ({
		traceId,
		rootOperationName: trace.rootOperationName,
		parentOperationName: span.parentSpanId ? spanById.get(span.parentSpanId)?.operationName ?? null : null,
		span,
	}))
}

const buildSpanItem = (traceId: string, spanRows: readonly SpanRow[], spanId: string): SpanItem | null =>
	buildSpanItems(traceId, spanRows).find((item) => item.span.spanId === spanId) ?? null

const matchesAttributes = (attributes: Readonly<Record<string, string>>, filters: Readonly<Record<string, string>> | undefined) =>
	!filters || Object.entries(filters).every(([key, value]) => attributes[key] === value)

const percentile = (values: readonly number[], ratio: number) => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
	return sorted[index] ?? 0
}

export class TelemetryStore extends ServiceMap.Service<
	TelemetryStore,
	{
		readonly ingestTraces: (payload: OtlpTraceExportRequest) => Effect.Effect<{ readonly insertedSpans: number }, Error>
		readonly ingestLogs: (payload: OtlpLogExportRequest) => Effect.Effect<{ readonly insertedLogs: number }, Error>
		readonly listServices: Effect.Effect<readonly string[], Error>
		readonly listRecentTraces: (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) => Effect.Effect<readonly TraceItem[], Error>
		readonly searchTraces: (input: TraceSearch) => Effect.Effect<readonly TraceItem[], Error>
		readonly traceStats: (input: TraceStatsSearch) => Effect.Effect<readonly StatsItem[], Error>
		readonly getTrace: (traceId: string) => Effect.Effect<TraceItem | null, Error>
		readonly getSpan: (spanId: string) => Effect.Effect<SpanItem | null, Error>
		readonly listTraceSpans: (traceId: string) => Effect.Effect<readonly SpanItem[], Error>
		readonly searchSpans: (input: SpanSearch) => Effect.Effect<readonly SpanItem[], Error>
		readonly searchLogs: (input: LogSearch) => Effect.Effect<readonly LogItem[], Error>
		readonly logStats: (input: LogStatsSearch) => Effect.Effect<readonly StatsItem[], Error>
		readonly listFacets: (input: FacetSearch) => Effect.Effect<readonly FacetItem[], Error>
		readonly listRecentLogs: (serviceName: string) => Effect.Effect<readonly LogItem[], Error>
		readonly listTraceLogs: (traceId: string) => Effect.Effect<readonly LogItem[], Error>
	}
>()("leto/TelemetryStore") {}

export interface TelemetryStoreOptions {
	readonly databasePath: string
	readonly retentionHours: number
	readonly traceLookbackMinutes: number
	readonly traceFetchLimit: number
	readonly logFetchLimit: number
}

const defaultOptions: TelemetryStoreOptions = {
	databasePath: config.otel.databasePath,
	retentionHours: config.otel.retentionHours,
	traceLookbackMinutes: config.otel.traceLookbackMinutes,
	traceFetchLimit: config.otel.traceFetchLimit,
	logFetchLimit: config.otel.logFetchLimit,
}

export const TelemetryStoreLive = Layer.effect(
	TelemetryStore,
	Effect.gen(function* () {
		mkdirSync(dirname(config.otel.databasePath), { recursive: true })
		const db = yield* Effect.acquireRelease(
			Effect.sync(() => new Database(config.otel.databasePath, { create: true })),
			(db) => Effect.sync(() => db.close()),
		)
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

		const maxDbSizeBytes = config.otel.maxDbSizeMb * 1024 * 1024

		const cleanupExpired = Effect.fn("leto/TelemetryStore.cleanupExpired")(function* () {
			const now = yield* Clock.currentTimeMillis

			yield* Effect.sync(() => {
				// Time-based retention
				const cutoff = now - config.otel.retentionHours * 60 * 60 * 1000
				db.query(`DELETE FROM spans WHERE start_time_ms < ?`).run(cutoff)
				db.query(`DELETE FROM logs WHERE timestamp_ms < ?`).run(cutoff)

				// Size-based retention: if DB exceeds max, delete oldest 20% of rows
				const pageCount = (db.query(`PRAGMA page_count`).get() as { page_count: number }).page_count
				const pageSize = (db.query(`PRAGMA page_size`).get() as { page_size: number }).page_size
				const dbSize = pageCount * pageSize
				if (dbSize > maxDbSizeBytes) {
					const spanCount = (db.query(`SELECT COUNT(*) AS c FROM spans`).get() as { c: number }).c
					const logCount = (db.query(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c
					const spanCutCount = Math.max(1, Math.floor(spanCount * 0.2))
					const logCutCount = Math.max(1, Math.floor(logCount * 0.2))
					db.query(`DELETE FROM spans WHERE rowid IN (SELECT rowid FROM spans ORDER BY start_time_ms ASC LIMIT ?)`).run(spanCutCount)
					db.query(`DELETE FROM logs WHERE rowid IN (SELECT rowid FROM logs ORDER BY timestamp_ms ASC LIMIT ?)`).run(logCutCount)
				}
			})
		})

		// Run cleanup every 60 seconds in the background, tied to the layer's scope
		yield* Effect.forkScoped(Effect.repeat(cleanupExpired(), Schedule.spaced("60 seconds")))

		const ingestTraces = Effect.fn("leto/TelemetryStore.ingestTraces")(function* (payload: OtlpTraceExportRequest) {


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

			const cutoff = (yield* Clock.currentTimeMillis) - (options?.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = options?.limit ?? config.otel.traceFetchLimit

			return yield* Effect.sync(() => {
				const traceIdRows = serviceName
					? (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(serviceName, cutoff, limit) as Array<{ trace_id: string }>)
					: (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
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

		const getSpan = Effect.fn("leto/TelemetryStore.getSpan")(function* (spanId: string) {
			return yield* Effect.sync(() => {
				const row = db.query(`SELECT trace_id FROM spans WHERE span_id = ? LIMIT 1`).get(spanId) as { trace_id: string } | null
				if (!row) return null
				const spanRows = db.query(`SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC`).all(row.trace_id) as SpanRow[]
				return buildSpanItem(row.trace_id, spanRows, spanId)
			})
		})

		const listTraceSpans = Effect.fn("leto/TelemetryStore.listTraceSpans")(function* (traceId: string) {
			return yield* Effect.sync(() => {
				const rows = db.query(`SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC`).all(traceId) as SpanRow[]
				return rows.length === 0 ? [] as readonly SpanItem[] : buildSpanItems(traceId, rows)
			})
		})

		const searchSpans = Effect.fn("leto/TelemetryStore.searchSpans")(function* (input: SpanSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 100
			const candidateLimit = Object.keys(input.attributeFilters ?? {}).length > 0 ? Math.max(limit * 20, 500) : Math.max(limit * 10, 200)

			return yield* Effect.sync(() => {
				const clauses: string[] = ["start_time_ms >= ?"]
				const params: Array<string | number> = [cutoff]

				if (input.serviceName) {
					clauses.push("service_name = ?")
					params.push(input.serviceName)
				}
				if (input.operation) {
					clauses.push("operation_name LIKE ?")
					params.push(`%${input.operation}%`)
				}
				if (input.status) {
					clauses.push("status = ?")
					params.push(input.status)
				}

				const rows = db.query(`
					SELECT trace_id, span_id
					FROM spans
					WHERE ${clauses.join(" AND ")}
					ORDER BY start_time_ms DESC
					LIMIT ?
				`).all(...params, candidateLimit) as Array<{ trace_id: string; span_id: string }>

				const traceIds = [...new Set(rows.map((row) => row.trace_id))]
				if (traceIds.length === 0) return [] as readonly SpanItem[]

				const placeholders = traceIds.map(() => "?").join(", ")
				const spanRows = db.query(`
					SELECT * FROM spans
					WHERE trace_id IN (${placeholders})
					ORDER BY start_time_ms ASC
				`).all(...traceIds) as SpanRow[]

				const grouped = new Map<string, SpanRow[]>()
				for (const row of spanRows) {
					const group = grouped.get(row.trace_id) ?? []
					group.push(row)
					grouped.set(row.trace_id, group)
				}

				const itemById = new Map<string, SpanItem>()
				for (const traceId of traceIds) {
					const traceSpanRows = grouped.get(traceId)
					if (!traceSpanRows) continue
					for (const item of buildSpanItems(traceId, traceSpanRows)) {
						itemById.set(item.span.spanId, item)
					}
				}

				return rows
					.map((row) => itemById.get(row.span_id))
					.filter((item): item is SpanItem => item !== undefined)
					.filter((item) => {
						if (input.parentOperation) {
							const needle = input.parentOperation.toLowerCase()
							if (!item.parentOperationName?.toLowerCase().includes(needle)) return false
						}
						if (input.attributeFilters && !matchesAttributes(item.span.tags, input.attributeFilters)) return false
						return true
					})
					.slice(0, limit)
			})
		})

		const searchTraces = Effect.fn("leto/TelemetryStore.searchTraces")(function* (input: TraceSearch) {

			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? config.otel.traceFetchLimit
			const candidateLimit = Object.keys(input.attributeFilters ?? {}).length > 0 ? Math.max(limit * 20, 500) : Math.max(limit * 10, 200)

			return yield* Effect.sync(() => {
				const traceIdRows = input.serviceName
					? (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(input.serviceName, cutoff, candidateLimit) as Array<{ trace_id: string }>)
					: (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
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
						if (input.attributeFilters && !trace.spans.some((span) => matchesAttributes(span.tags, input.attributeFilters))) return false
						return true
					})
					.slice(0, limit)
			})
		})

		const searchLogs = Effect.fn("leto/TelemetryStore.searchLogs")(function* (input: LogSearch) {
			const now = yield* Clock.currentTimeMillis
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
				if (input.lookbackMinutes) {
					const cutoff = now - input.lookbackMinutes * 60 * 1000
					clauses.push(`timestamp_ms >= ?`)
					params.push(cutoff)
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

		const traceStats = Effect.fn("leto/TelemetryStore.traceStats")(function* (input: TraceStatsSearch) {
			const traces = yield* searchTraces({
				serviceName: input.serviceName,
				operation: input.operation,
				status: input.status,
				minDurationMs: input.minDurationMs,
				attributeFilters: input.attributeFilters,
				lookbackMinutes: input.lookbackMinutes,
				limit: Math.max(5000, input.limit ?? config.otel.traceFetchLimit),
			})

			const groups = new Map<string, TraceItem[]>()
			for (const trace of traces) {
				const group = input.groupBy === "service"
					? trace.serviceName
					: input.groupBy === "operation"
						? trace.rootOperationName
						: input.groupBy === "status"
							? trace.errorCount > 0 ? "error" : "ok"
							: input.groupBy.startsWith("attr.")
								? trace.spans.find((span) => span.tags[input.groupBy.slice(5)] !== undefined)?.tags[input.groupBy.slice(5)] ?? "unknown"
								: "unknown"
				const bucket = groups.get(group) ?? []
				bucket.push(trace)
				groups.set(group, bucket)
			}

			const rows = [...groups.entries()].map(([group, items]) => {
				const durations = items.map((item) => item.durationMs)
				const errorCount = items.filter((item) => item.errorCount > 0).length
				const value = input.agg === "count"
					? items.length
					: input.agg === "avg_duration"
						? durations.reduce((sum, duration) => sum + duration, 0) / Math.max(1, durations.length)
						: input.agg === "p95_duration"
							? percentile(durations, 0.95)
							: errorCount / Math.max(1, items.length)

				return { group, value, count: items.length }
			})

			return rows.sort((left, right) => right.value - left.value).slice(0, input.limit ?? 20)
		})

		const logStats = Effect.fn("leto/TelemetryStore.logStats")(function* (input: LogStatsSearch) {
			const logs = yield* searchLogs({
				serviceName: input.serviceName,
				traceId: input.traceId,
				spanId: input.spanId,
				body: input.body,
				attributeFilters: input.attributeFilters,
				limit: Math.max(5000, input.limit ?? config.otel.logFetchLimit),
			})

			const groups = new Map<string, number>()
			for (const log of logs) {
				const group = input.groupBy === "service"
					? log.serviceName
					: input.groupBy === "severity"
						? log.severityText
						: input.groupBy === "scope"
							? log.scopeName ?? "unknown"
							: input.groupBy.startsWith("attr.")
								? log.attributes[input.groupBy.slice(5)] ?? "unknown"
								: "unknown"
				groups.set(group, (groups.get(group) ?? 0) + 1)
			}

			return [...groups.entries()]
				.map(([group, count]) => ({ group, value: count, count }))
				.sort((left, right) => right.value - left.value)
				.slice(0, input.limit ?? 20)
		})

		const listRecentLogs = Effect.fn("leto/TelemetryStore.listRecentLogs")(function* (serviceName: string) {
			return yield* searchLogs({ serviceName, limit: config.otel.logFetchLimit })
		})

		const listFacets = Effect.fn("leto/TelemetryStore.listFacets")(function* (input: FacetSearch) {

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
			traceStats,
			getTrace,
			getSpan,
			listTraceSpans,
			searchSpans,
			searchLogs,
			logStats,
			listFacets,
			listRecentLogs,
			listTraceLogs,
		})
	}),
)
