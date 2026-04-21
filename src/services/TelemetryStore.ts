import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Clock, Effect, Layer, Schedule, Context } from "effect"
import { config } from "../config.js"
import type {
	AiCallDetail,
	AiCallSummary,
	FacetItem,
	LogItem,
	SpanItem,
	StatsItem,
	TraceItem,
	TraceSummaryItem,
	TraceSpanEvent,
	TraceSpanItem,
} from "../domain.js"
import {
	AI_ATTR_MAP,
	AI_FTS_KEYS,
	AI_TEXT_SEARCH_KEYS,
	truncatePreview,
} from "../domain.js"
import {
	attributeMap,
	nanosToMilliseconds,
	parseAnyValue,
	spanKindLabel,
	spanStatusLabel,
	stringifyValue,
	type OtlpLogExportRequest,
	type OtlpTraceExportRequest,
} from "../otlp.js"

const isSqliteLockError = (error: unknown) =>
	error instanceof Error &&
	/(database is locked|database table is locked|SQLITE_BUSY)/i.test(
		error.message,
	)

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
}

interface TraceSearch {
	readonly serviceName?: string | null
	readonly operation?: string | null
	readonly status?: "ok" | "error" | null
	readonly minDurationMs?: number | null
	readonly attributeFilters?: Readonly<Record<string, string>>
	/**
	 * Full-text match against the AI prompt/response/tool attribute values
	 * on any span in the trace (see AI_FTS_KEYS). When set, traces are
	 * filtered to those containing at least one span whose indexed LLM
	 * content matches. Powered by span_attr_fts (FTS5).
	 */
	readonly aiText?: string | null
	readonly lookbackMinutes?: number
	readonly limit?: number
	readonly cursorStartedAtMs?: number
	readonly cursorTraceId?: string
}

interface SpanSearch {
	readonly serviceName?: string | null
	readonly traceId?: string | null
	readonly operation?: string | null
	readonly parentOperation?: string | null
	readonly status?: "ok" | "error" | null
	readonly lookbackMinutes?: number
	readonly limit?: number
	readonly attributeFilters?: Readonly<Record<string, string>>
	readonly attributeContainsFilters?: Readonly<Record<string, string>>
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

// FacetItem and StatsItem imported from domain.ts

interface FacetSearch {
	readonly type: "traces" | "logs"
	readonly field: string
	readonly serviceName?: string | null
	readonly key?: string | null
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface AiCallSearch {
	readonly service?: string | null
	readonly traceId?: string | null
	readonly sessionId?: string | null
	readonly functionId?: string | null
	readonly provider?: string | null
	readonly model?: string | null
	readonly operation?: string | null
	readonly status?: "ok" | "error" | null
	readonly minDurationMs?: number | null
	readonly text?: string | null
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface AiCallStatsSearch {
	readonly groupBy: "provider" | "model" | "functionId" | "sessionId" | "status"
	readonly agg:
		| "count"
		| "avg_duration"
		| "p95_duration"
		| "total_input_tokens"
		| "total_output_tokens"
	readonly service?: string | null
	readonly traceId?: string | null
	readonly sessionId?: string | null
	readonly functionId?: string | null
	readonly provider?: string | null
	readonly model?: string | null
	readonly operation?: string | null
	readonly status?: "ok" | "error" | null
	readonly minDurationMs?: number | null
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface TraceSummaryRow {
	readonly trace_id: string
	readonly service_name: string
	readonly root_operation_name: string
	readonly started_at_ms: number
	readonly ended_at_ms?: number
	readonly active_span_count: number
	readonly duration_ms: number
	readonly span_count: number
	readonly error_count: number
}

type InternalTraceSpanItem = TraceSpanItem & {
	readonly syntheticMissingParent?: boolean
}

const isSpanRunning = (startTimeMs: number, endTimeMs: number) =>
	endTimeMs <= 0 || endTimeMs < startTimeMs

const liveDurationMs = (
	startTimeMs: number,
	endTimeMs: number,
	isRunning: boolean,
) => Math.max(0, (isRunning ? Date.now() : endTimeMs) - startTimeMs)

const parseSummaryRow = (row: TraceSummaryRow): TraceSummaryItem => ({
	isRunning: row.active_span_count > 0,
	traceId: row.trace_id,
	serviceName: row.service_name ?? "unknown",
	rootOperationName: row.root_operation_name ?? "unknown",
	startedAt: new Date(row.started_at_ms),
	durationMs:
		row.active_span_count > 0
			? liveDurationMs(row.started_at_ms, row.ended_at_ms ?? 0, true)
			: Math.max(0, row.duration_ms),
	spanCount: row.span_count,
	errorCount: row.error_count,
	warnings: [],
})

// Skip attribute facet rows whose value blob is longer than this. Prevents
// multi-MB text attrs (ai.prompt, ai.prompt.messages, etc.) from dominating
// picker-open time — SQLite skips reading those pages from disk when the
// length predicate is evaluated against the page header, taking queries over
// a 2GB database from ~1.2s down to ~370ms. Keys whose values are ALL fat
// simply don't appear in the picker, which is the desired behaviour: you'd
// never want to filter traces by exact-match on a 1MB prompt blob anyway.
const FACET_VALUE_MAX_LEN = 512

const TRACE_SUMMARY_SELECT_SQL = `
	SELECT
		trace_id,
		COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN service_name END), MIN(service_name)) AS service_name,
		COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN operation_name END), MIN(operation_name)) AS root_operation_name,
		MIN(start_time_ms) AS started_at_ms,
		MAX(end_time_ms) AS ended_at_ms,
		SUM(CASE WHEN end_time_ms <= 0 OR end_time_ms < start_time_ms THEN 1 ELSE 0 END) AS active_span_count,
		MAX(end_time_ms) - MIN(start_time_ms) AS duration_ms,
		COUNT(*) AS span_count,
		SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
	FROM spans
`

const parseRecord = (value: string): Record<string, string> => {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>
		return Object.fromEntries(
			Object.entries(parsed).map(([key, entry]) => [
				key,
				stringifyValue(entry),
			]),
		)
	} catch {
		return {}
	}
}

const parseEvents = (value: string): readonly TraceSpanEvent[] => {
	try {
		const parsed = JSON.parse(value) as Array<{
			name: string
			timestamp: number
			attributes: Record<string, string>
		}>
		return parsed.map((event) => ({
			name: event.name,
			timestamp: new Date(event.timestamp),
			attributes: event.attributes,
		}))
	} catch {
		return []
	}
}

const parseSpanRow = (row: SpanRow): InternalTraceSpanItem => {
	const isRunning = isSpanRunning(row.start_time_ms, row.end_time_ms)
	return {
		spanId: row.span_id,
		parentSpanId: row.parent_span_id,
		serviceName: row.service_name,
		scopeName: row.scope_name,
		kind: row.kind,
		operationName: row.operation_name,
		startTime: new Date(row.start_time_ms),
		isRunning,
		durationMs: liveDurationMs(row.start_time_ms, row.end_time_ms, isRunning),
		status: row.status === "error" ? "error" : "ok",
		depth: 0,
		tags: {
			...parseRecord(row.resource_json),
			...parseRecord(row.attributes_json),
		},
		warnings: [],
		events: parseEvents(row.events_json),
	}
}

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

const orderTraceSpans = (spans: readonly InternalTraceSpanItem[]) => {
	const childrenByParent = new Map<string | null, InternalTraceSpanItem[]>()
	const spanIds = new Set(spans.map((span) => span.spanId))

	for (const span of spans) {
		const key =
			span.parentSpanId && spanIds.has(span.parentSpanId)
				? span.parentSpanId
				: null
		const siblings = childrenByParent.get(key) ?? []
		siblings.push(span)
		childrenByParent.set(key, siblings)
	}

	for (const siblings of childrenByParent.values()) {
		siblings.sort(
			(left, right) =>
				left.startTime.getTime() - right.startTime.getTime() ||
				Number(Boolean(left.syntheticMissingParent)) -
					Number(Boolean(right.syntheticMissingParent)),
		)
	}

	const ordered: Array<InternalTraceSpanItem> = []
	const visit = (parent: string | null, depth: number) => {
		for (const child of childrenByParent.get(parent) ?? []) {
			ordered.push({ ...child, depth })
			visit(child.spanId, depth + 1)
		}
	}

	visit(null, 0)
	return ordered
}

const buildTrace = (
	traceId: string,
	spanRows: readonly SpanRow[],
): TraceItem => {
	const parsedSpans = spanRows.map(parseSpanRow)
	const spanIds = new Set(parsedSpans.map((span) => span.spanId))
	const missingParentGroups = new Map<string, InternalTraceSpanItem[]>()

	for (const span of parsedSpans) {
		if (span.parentSpanId !== null && !spanIds.has(span.parentSpanId)) {
			const siblings = missingParentGroups.get(span.parentSpanId) ?? []
			siblings.push(span)
			missingParentGroups.set(span.parentSpanId, siblings)
		}
	}

	const syntheticParents: InternalTraceSpanItem[] = [
		...missingParentGroups.entries(),
	].map(([missingParentId, children]) => {
		const firstChild = children[0]!
		const startedAtMs = Math.min(
			...children.map((child) => child.startTime.getTime()),
		)
		const endedAtMs = Math.max(
			...children.map((child) => child.startTime.getTime() + child.durationMs),
		)
		return {
			spanId: missingParentId,
			parentSpanId: null,
			serviceName: firstChild.serviceName,
			scopeName: null,
			kind: null,
			operationName: `[missing parent ${missingParentId.slice(0, 8)}]`,
			startTime: new Date(startedAtMs),
			isRunning: children.some((child) => child.isRunning),
			durationMs: Math.max(0, endedAtMs - startedAtMs),
			status: "error",
			depth: 0,
			tags: {},
			warnings: [
				`missing span ${missingParentId} (${children.length} child${children.length === 1 ? "" : "ren"})`,
			],
			events: [],
			syntheticMissingParent: true,
		}
	})

	const orderedSpans = orderTraceSpans([...parsedSpans, ...syntheticParents])
	const startedAtMs = Math.min(
		...orderedSpans.map((span) => span.startTime.getTime()),
	)
	const endedAtMs = Math.max(
		...orderedSpans.map((span) => span.startTime.getTime() + span.durationMs),
	)
	const isRunning = orderedSpans.some((span) => span.isRunning)
	const rootSpan =
		orderedSpans.find(
			(span) => !span.syntheticMissingParent && span.parentSpanId === null,
		) ??
		orderedSpans.find((span) => !span.syntheticMissingParent) ??
		orderedSpans[0] ??
		null
	const warnings = syntheticParents
		.map((span) => span.warnings[0]!)
		.filter((warning) => warning.length > 0)

	return {
		traceId,
		serviceName: rootSpan?.serviceName ?? "unknown",
		rootOperationName: rootSpan?.operationName ?? "unknown",
		startedAt: new Date(startedAtMs),
		isRunning,
		durationMs: Math.max(0, endedAtMs - startedAtMs),
		spanCount: orderedSpans.length,
		errorCount: orderedSpans.filter((span) => span.status === "error").length,
		warnings,
		spans: orderedSpans.map(({ syntheticMissingParent: _, ...span }) => span),
	}
}

const buildSpanItems = (
	traceId: string,
	spanRows: readonly SpanRow[],
): readonly SpanItem[] => {
	const trace = buildTrace(traceId, spanRows)
	const spanById = new Map(trace.spans.map((span) => [span.spanId, span]))
	return trace.spans.map((span) => ({
		traceId,
		rootOperationName: trace.rootOperationName,
		parentOperationName: span.parentSpanId
			? (spanById.get(span.parentSpanId)?.operationName ?? null)
			: null,
		span,
	}))
}

const buildSpanItem = (
	traceId: string,
	spanRows: readonly SpanRow[],
	spanId: string,
): SpanItem | null =>
	buildSpanItems(traceId, spanRows).find(
		(item) => item.span.spanId === spanId,
	) ?? null

const matchesAttributes = (
	attributes: Readonly<Record<string, string>>,
	filters: Readonly<Record<string, string>> | undefined,
) =>
	!filters ||
	Object.entries(filters).every(([key, value]) => attributes[key] === value)

const matchesAttributeContains = (
	attributes: Readonly<Record<string, string>>,
	filters: Readonly<Record<string, string>> | undefined,
) =>
	!filters ||
	Object.entries(filters).every(([key, needle]) => {
		const value = attributes[key]
		return (
			value !== undefined && value.toLowerCase().includes(needle.toLowerCase())
		)
	})

const percentile = (values: readonly number[], ratio: number) => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * ratio) - 1),
	)
	return sorted[index] ?? 0
}

const tokenizeFts = (value: string) =>
	value.match(/[A-Za-z0-9_]+/g)?.filter((token) => token.length > 1) ?? []

const toFtsMatchQuery = (value: string) => {
	const tokens = tokenizeFts(value)
	if (tokens.length === 0) return null
	return tokens.map((token) => `${token}*`).join(" AND ")
}

const buildExactAttributeMatchSubquery = (
	tableName: "span_attributes" | "log_attributes",
	idColumns: readonly string[],
	filters: Readonly<Record<string, string>> | undefined,
) => {
	const entries = Object.entries(filters ?? {})
	if (entries.length === 0) return null
	const disjunction = entries.map(() => "(key = ? AND value = ?)").join(" OR ")
	return {
		sql: `
			SELECT ${idColumns.join(", ")}
			FROM ${tableName}
			WHERE ${disjunction}
			GROUP BY ${idColumns.join(", ")}
			HAVING COUNT(DISTINCT key) = ${entries.length}
		`,
		params: entries.flatMap(([key, value]) => [key, value]),
	}
}

const buildContainsAttributeMatchSubquery = (
	tableName: "span_attributes" | "log_attributes",
	idColumns: readonly string[],
	filters: Readonly<Record<string, string>> | undefined,
) => {
	const entries = Object.entries(filters ?? {})
	if (entries.length === 0) return null
	const disjunction = entries
		.map(() => "(key = ? AND value LIKE ? COLLATE NOCASE)")
		.join(" OR ")
	return {
		sql: `
			SELECT ${idColumns.join(", ")}
			FROM ${tableName}
			WHERE ${disjunction}
			GROUP BY ${idColumns.join(", ")}
			HAVING COUNT(DISTINCT key) = ${entries.length}
		`,
		params: entries.flatMap(([key, value]) => [key, `%${value}%`]),
	}
}

export class TelemetryStore extends Context.Service<
	TelemetryStore,
	{
		readonly ingestTraces: (
			payload: OtlpTraceExportRequest,
		) => Effect.Effect<{ readonly insertedSpans: number }, Error>
		readonly ingestLogs: (
			payload: OtlpLogExportRequest,
		) => Effect.Effect<{ readonly insertedLogs: number }, Error>
		readonly listServices: Effect.Effect<readonly string[], Error>
		readonly listRecentTraces: (
			serviceName: string | null,
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
		readonly searchTraces: (
			input: TraceSearch,
		) => Effect.Effect<readonly TraceItem[], Error>
		readonly searchTraceSummaries: (
			input: TraceSearch,
		) => Effect.Effect<readonly TraceSummaryItem[], Error>
		readonly traceStats: (
			input: TraceStatsSearch,
		) => Effect.Effect<readonly StatsItem[], Error>
		readonly getTrace: (
			traceId: string,
		) => Effect.Effect<TraceItem | null, Error>
		readonly getSpan: (spanId: string) => Effect.Effect<SpanItem | null, Error>
		readonly listTraceSpans: (
			traceId: string,
		) => Effect.Effect<readonly SpanItem[], Error>
		readonly searchSpans: (
			input: SpanSearch,
		) => Effect.Effect<readonly SpanItem[], Error>
		readonly searchLogs: (
			input: LogSearch,
		) => Effect.Effect<readonly LogItem[], Error>
		readonly logStats: (
			input: LogStatsSearch,
		) => Effect.Effect<readonly StatsItem[], Error>
		readonly listFacets: (
			input: FacetSearch,
		) => Effect.Effect<readonly FacetItem[], Error>
		readonly listRecentLogs: (
			serviceName: string,
		) => Effect.Effect<readonly LogItem[], Error>
		readonly listTraceLogs: (
			traceId: string,
		) => Effect.Effect<readonly LogItem[], Error>
		readonly searchAiCalls: (
			input: AiCallSearch,
		) => Effect.Effect<readonly AiCallSummary[], Error>
		readonly getAiCall: (
			spanId: string,
		) => Effect.Effect<AiCallDetail | null, Error>
		readonly aiCallStats: (
			input: AiCallStatsSearch,
		) => Effect.Effect<readonly StatsItem[], Error>
	}
>()("motel/TelemetryStore") {}

/**
 * How this TelemetryStore instance behaves:
 *
 * - `readonly` — opens the SQLite connection read-only and skips every
 *   DDL/DML initialisation. Use this from the TUI (and anywhere else
 *   that only queries); it avoids the "database is locked" race that
 *   happens when a TUI process races a daemon's writer for the schema
 *   pragmas on startup. Writes through the service interface become
 *   runtime errors — but readers don't call them.
 *
 * - `runRetention` — fork the background cleanup loop (age + size cap
 *   eviction, WAL checkpoint). Only one process should own this at a
 *   time. Currently the main daemon (localServer) does; the ingest
 *   worker and the TUI skip it.
 */
export interface TelemetryStoreOptions {
	readonly readonly: boolean
	readonly runRetention: boolean
}

export const makeTelemetryStoreLayer = (opts: TelemetryStoreOptions) =>
	Layer.effect(
		TelemetryStore,
		Effect.gen(function* () {
			mkdirSync(dirname(config.otel.databasePath), { recursive: true })
			const db = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new Database(config.otel.databasePath, {
							create: !opts.readonly,
							readonly: opts.readonly,
						}),
				),
				(db) =>
					Effect.sync(() => {
						if (!opts.readonly) {
							// `PRAGMA optimize` at close persists any stats SQLite gathered
							// during the session, so the next process start gets an accurate
							// query planner on the first query instead of a 3-second cold
							// run. Cheap: it skips work unless stats have drifted.
							try {
								db.exec(`PRAGMA optimize;`)
							} catch {
								/* nothing */
							}
						}
						db.close()
					}),
			)
			if (opts.readonly) {
				// Readonly connections skip schema init entirely — the schema
				// already exists (a writer created it) and any `CREATE TABLE IF
				// NOT EXISTS` / `PRAGMA journal_mode = WAL` statement would
				// attempt a write and fight the daemon for the write lock.
				// `query_only = 1` logically blocks any DML the app might
				// accidentally send; still bump cache + mmap since those are
				// safe and keep queries fast.
				db.exec(`
				PRAGMA query_only = 1;
				PRAGMA busy_timeout = 15000;
				PRAGMA cache_size = -65536;
				PRAGMA mmap_size = 268435456;
			`)
			} else {
				db.exec(`
				-- Bump cache above the 2MB default. 64MB fits most hot index pages
				-- (trace_summaries, spans, span_attributes indexes) in RAM even on
				-- multi-GB databases, cutting cold-read latency meaningfully on
				-- picker / search queries that sweep the index.
				PRAGMA cache_size = -65536;
				-- Let SQLite memory-map the first 256MB of the file. This is a
				-- cheap way to avoid read() syscalls on hot pages and lets the OS
				-- page cache serve index lookups directly. Safe on macOS and Linux;
				-- SQLite silently caps at actual file size for smaller DBs.
				PRAGMA mmap_size = 268435456;
			`)
				try {
					db.exec(`
					PRAGMA journal_mode = WAL;
					PRAGMA synchronous = NORMAL;
					PRAGMA temp_store = MEMORY;
					-- WAL checkpoint automatically when it grows past ~16MB. Without
					-- this the WAL happily runs into the hundreds of MB and queries
					-- start paying the cost of walking the WAL on every read.
					PRAGMA wal_autocheckpoint = 4000;

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
					CREATE INDEX IF NOT EXISTS idx_spans_span_id ON spans(span_id);
					CREATE INDEX IF NOT EXISTS idx_spans_status_time ON spans(status, start_time_ms DESC);

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
					CREATE INDEX IF NOT EXISTS idx_logs_severity_time ON logs(severity_text, timestamp_ms DESC);

					CREATE TABLE IF NOT EXISTS trace_summaries (
						trace_id TEXT PRIMARY KEY,
						service_name TEXT NOT NULL,
						root_operation_name TEXT NOT NULL,
						started_at_ms INTEGER NOT NULL,
						ended_at_ms INTEGER NOT NULL,
						active_span_count INTEGER NOT NULL DEFAULT 0,
						duration_ms REAL NOT NULL,
						span_count INTEGER NOT NULL,
						error_count INTEGER NOT NULL
					);

					CREATE INDEX IF NOT EXISTS idx_trace_summaries_started_at ON trace_summaries(started_at_ms DESC, trace_id DESC);
					CREATE INDEX IF NOT EXISTS idx_trace_summaries_service_started_at ON trace_summaries(service_name, started_at_ms DESC, trace_id DESC);
					CREATE INDEX IF NOT EXISTS idx_trace_summaries_duration ON trace_summaries(duration_ms DESC);

					CREATE TABLE IF NOT EXISTS span_attributes (
						trace_id TEXT NOT NULL,
						span_id TEXT NOT NULL,
						key TEXT NOT NULL,
						value TEXT NOT NULL,
						PRIMARY KEY (trace_id, span_id, key)
					);

					CREATE INDEX IF NOT EXISTS idx_span_attributes_key_value ON span_attributes(key, value, trace_id, span_id);
					CREATE INDEX IF NOT EXISTS idx_span_attributes_trace_span ON span_attributes(trace_id, span_id);

					CREATE TABLE IF NOT EXISTS log_attributes (
						log_id INTEGER NOT NULL,
						key TEXT NOT NULL,
						value TEXT NOT NULL,
						PRIMARY KEY (log_id, key)
					);

					CREATE INDEX IF NOT EXISTS idx_log_attributes_key_value ON log_attributes(key, value, log_id);
					CREATE INDEX IF NOT EXISTS idx_log_attributes_log_id ON log_attributes(log_id);
				`)
				} catch (err) {
					if (!isSqliteLockError(err)) throw err
					console.warn(
						`motel: writer bootstrap skipped during startup: ${(err as Error).message}`,
					)
				}
			}

			// Tables detected at runtime. For writer connections these flags are
			// set by the FTS `CREATE VIRTUAL TABLE IF NOT EXISTS` try/catch; for
			// readonly connections we probe `sqlite_master` and set them based on
			// what the writer has already provisioned.
			let hasFts = true
			let hasAttrFts = true
			if (opts.readonly) {
				try {
					const row = db
						.query(
							`SELECT name FROM sqlite_master WHERE type='table' AND name='span_operation_fts'`,
						)
						.get()
					hasFts = row !== null
				} catch {
					hasFts = false
				}
				try {
					const row = db
						.query(
							`SELECT name FROM sqlite_master WHERE type='table' AND name='span_attr_fts'`,
						)
						.get()
					hasAttrFts = row !== null
				} catch {
					hasAttrFts = false
				}
			}

			if (!opts.readonly) {
				try {
					db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS span_operation_fts USING fts5(
					trace_id UNINDEXED,
					span_id UNINDEXED,
					operation_name,
					tokenize='unicode61'
				);

				CREATE VIRTUAL TABLE IF NOT EXISTS log_body_fts USING fts5(
					log_id UNINDEXED,
					body,
					tokenize='unicode61'
				);
			`)
				} catch {
					hasFts = false
					// FTS is optional; queries will fall back to LIKE if unavailable.
				}

				// External-content FTS5 over the subset of span_attributes.value rows
				// whose key is in AI_FTS_KEYS (LLM prompts, responses, tool calls,
				// etc.). External content means the inverted index is the only
				// FTS storage — the value text itself continues to live once in
				// span_attributes, not duplicated into the FTS table. On a 2 GB DB
				// with 270 MB of prompt JSON this typically adds ~50-120 MB of
				// index, turning a 500-800ms LIKE scan into a <50ms MATCH.
				//
				// Keys are inlined into the trigger DDL rather than looked up in a
				// side table so the `WHEN` guard stays constant-cost (a subquery
				// would run on every span_attributes insert — ~60/span).
				if (hasFts) {
					try {
						const keyList = AI_FTS_KEYS.map(
							(k) => `'${k.replace(/'/g, "''")}'`,
						).join(", ")
						db.exec(`
					CREATE VIRTUAL TABLE IF NOT EXISTS span_attr_fts USING fts5(
						value,
						content='span_attributes',
						content_rowid='rowid',
						tokenize='unicode61 remove_diacritics 2'
					);

					-- Mirror inserts into FTS when the key carries LLM content.
					-- NOTE: triggers MUST use fully-qualified name (new.rowid,
					-- new.value) and emit rowid so external-content FTS can
					-- fetch the value back via span_attributes.rowid.
					CREATE TRIGGER IF NOT EXISTS span_attr_fts_ai AFTER INSERT ON span_attributes
					WHEN new.key IN (${keyList})
					BEGIN
						INSERT INTO span_attr_fts(rowid, value) VALUES (new.rowid, new.value);
					END;

					-- Delete with the same guard so retention & re-ingest stay
					-- in sync. External-content 'delete' command needs the
					-- original value to remove from the inverted index.
					CREATE TRIGGER IF NOT EXISTS span_attr_fts_ad AFTER DELETE ON span_attributes
					WHEN old.key IN (${keyList})
					BEGIN
						INSERT INTO span_attr_fts(span_attr_fts, rowid, value)
						VALUES ('delete', old.rowid, old.value);
					END;

					-- Handle in-place updates (rare; re-ingest usually goes
					-- DELETE then INSERT but belt-and-braces).
					CREATE TRIGGER IF NOT EXISTS span_attr_fts_au AFTER UPDATE ON span_attributes
					WHEN old.key IN (${keyList}) OR new.key IN (${keyList})
					BEGIN
						INSERT INTO span_attr_fts(span_attr_fts, rowid, value)
						VALUES ('delete', old.rowid, old.value);
						INSERT INTO span_attr_fts(rowid, value)
						SELECT new.rowid, new.value
						WHERE new.key IN (${keyList});
					END;
				`)
					} catch {
						hasAttrFts = false
					}
				}

				try {
					db.exec(
						`ALTER TABLE trace_summaries ADD COLUMN active_span_count INTEGER NOT NULL DEFAULT 0`,
					)
				} catch {
					// Existing databases may already have the column.
				}

				// Prime the query planner. `PRAGMA optimize` is SQLite's modern,
				// lightweight stats refresh: it only re-ANALYZEs indexes whose row
				// counts have drifted significantly since the last run, capped at
				// `analysis_limit` iterations per index so it finishes in a
				// bounded time even on large databases. Without this, queries like
				// the attribute picker facet run with guessed row estimates and
				// pay 3-4s on cold open instead of 400ms.
				try {
					db.exec(`PRAGMA analysis_limit = 1000; PRAGMA optimize;`)
					// First-time databases won't have sqlite_stat1 until we run a
					// real ANALYZE. Force it once if stats haven't been collected.
					const hasStats =
						db
							.query(
								`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1' LIMIT 1`,
							)
							.get() !== null
					if (!hasStats) db.exec(`ANALYZE;`)
				} catch {
					// ANALYZE / optimize failures are never fatal — queries still work,
					// they just run with default row estimates.
				}
				// Longer busy timeout: the ingest worker holds the write lock for up
				// to a few seconds during big OTLP batches, and the daemon's retention
				// passes can do the same. Apply this AFTER startup maintenance so
				// lock-conflicted bootstrap steps fail fast instead of stalling health
				// for the full 15s timeout.
				try {
					db.exec(`PRAGMA busy_timeout = 15000;`)
				} catch {
					/* ignore */
				}
			} // end: if (!opts.readonly) writer init

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

			const upsertTraceSummary = db.query(`
			INSERT OR REPLACE INTO trace_summaries (
				trace_id, service_name, root_operation_name, started_at_ms, ended_at_ms, active_span_count, duration_ms, span_count, error_count
			)
			SELECT trace_id, service_name, root_operation_name, started_at_ms, ended_at_ms, active_span_count, duration_ms, span_count, error_count
			FROM (
				${TRACE_SUMMARY_SELECT_SQL}
				WHERE trace_id = ?
				GROUP BY trace_id
			)
		`)

			const rebuildTraceSummaries = db.query(`
			INSERT INTO trace_summaries (
				trace_id, service_name, root_operation_name, started_at_ms, ended_at_ms, active_span_count, duration_ms, span_count, error_count
			)
			${TRACE_SUMMARY_SELECT_SQL}
			GROUP BY trace_id
		`)

			const reconcileTraceSummaries = Effect.sync(() => {
				try {
					db.query(`DELETE FROM trace_summaries`).run()
					rebuildTraceSummaries.run()
				} catch (err) {
					if (!isSqliteLockError(err)) throw err
					console.warn(
						`motel: trace summary rebuild skipped during startup: ${(err as Error).message}`,
					)
				}
			})

			const deleteSpanAttributes = db.query(
				`DELETE FROM span_attributes WHERE trace_id = ? AND span_id = ?`,
			)
			const insertSpanAttribute = db.query(
				`INSERT INTO span_attributes (trace_id, span_id, key, value) VALUES (?, ?, ?, ?)`,
			)
			const spanAttributeInsertManyByCount = new Map<
				number,
				ReturnType<Database["query"]>
			>()
			const insertSpanAttributesMany = (
				traceId: string,
				spanId: string,
				attributes: Readonly<Record<string, string>>,
			) => {
				const entries = Object.entries(attributes)
				if (entries.length === 0) return
				if (entries.length === 1) {
					const [key, value] = entries[0]!
					insertSpanAttribute.run(traceId, spanId, key, value)
					return
				}
				let query = spanAttributeInsertManyByCount.get(entries.length)
				if (!query) {
					query = db.query(
						`INSERT INTO span_attributes (trace_id, span_id, key, value) VALUES ${entries.map(() => "(?, ?, ?, ?)").join(", ")}`,
					)
					spanAttributeInsertManyByCount.set(entries.length, query)
				}
				query.run(
					...entries.flatMap(([key, value]) => [traceId, spanId, key, value]),
				)
			}
			const deleteSpanOperationSearch = db.query(
				`DELETE FROM span_operation_fts WHERE trace_id = ? AND span_id = ?`,
			)
			const insertSpanOperationSearch = db.query(
				`INSERT INTO span_operation_fts (trace_id, span_id, operation_name) VALUES (?, ?, ?)`,
			)
			const deleteSpanOperationSearchManyByCount = new Map<
				number,
				ReturnType<Database["query"]>
			>()
			const insertSpanOperationSearchManyByCount = new Map<
				number,
				ReturnType<Database["query"]>
			>()
			const updateSpanOperationSearchMany = (
				operations: ReadonlyArray<readonly [string, string, string]>,
			) => {
				if (operations.length === 0) return
				if (operations.length === 1) {
					const [traceId, spanId, operationName] = operations[0]!
					deleteSpanOperationSearch.run(traceId, spanId)
					insertSpanOperationSearch.run(traceId, spanId, operationName)
					return
				}

				let deleteQuery = deleteSpanOperationSearchManyByCount.get(
					operations.length,
				)
				if (!deleteQuery) {
					deleteQuery = db.query(
						`DELETE FROM span_operation_fts WHERE ${operations.map(() => "(trace_id = ? AND span_id = ?)").join(" OR ")}`,
					)
					deleteSpanOperationSearchManyByCount.set(
						operations.length,
						deleteQuery,
					)
				}
				deleteQuery.run(
					...operations.flatMap(([traceId, spanId]) => [traceId, spanId]),
				)

				let insertQuery = insertSpanOperationSearchManyByCount.get(
					operations.length,
				)
				if (!insertQuery) {
					insertQuery = db.query(
						`INSERT INTO span_operation_fts (trace_id, span_id, operation_name) VALUES ${operations.map(() => "(?, ?, ?)").join(", ")}`,
					)
					insertSpanOperationSearchManyByCount.set(
						operations.length,
						insertQuery,
					)
				}
				insertQuery.run(
					...operations.flatMap(([traceId, spanId, operationName]) => [
						traceId,
						spanId,
						operationName,
					]),
				)
			}
			const insertLogAttribute = db.query(
				`INSERT INTO log_attributes (log_id, key, value) VALUES (?, ?, ?)`,
			)
			const logAttributeInsertManyByCount = new Map<
				number,
				ReturnType<Database["query"]>
			>()
			const insertLogAttributesMany = (
				logId: number,
				attributes: Readonly<Record<string, string>>,
			) => {
				const entries = Object.entries(attributes)
				if (entries.length === 0) return
				if (entries.length === 1) {
					const [key, value] = entries[0]!
					insertLogAttribute.run(logId, key, value)
					return
				}
				let query = logAttributeInsertManyByCount.get(entries.length)
				if (!query) {
					query = db.query(
						`INSERT INTO log_attributes (log_id, key, value) VALUES ${entries.map(() => "(?, ?, ?)").join(", ")}`,
					)
					logAttributeInsertManyByCount.set(entries.length, query)
				}
				query.run(...entries.flatMap(([key, value]) => [logId, key, value]))
			}
			const insertLogBodySearch = db.query(
				`INSERT INTO log_body_fts (log_id, body) VALUES (?, ?)`,
			)
			const insertLogBodySearchManyByCount = new Map<
				number,
				ReturnType<Database["query"]>
			>()
			const insertLogBodySearchMany = (
				entries: ReadonlyArray<readonly [string, string]>,
			) => {
				if (entries.length === 0) return
				if (entries.length === 1) {
					const [logId, body] = entries[0]!
					insertLogBodySearch.run(logId, body)
					return
				}
				let query = insertLogBodySearchManyByCount.get(entries.length)
				if (!query) {
					query = db.query(
						`INSERT INTO log_body_fts (log_id, body) VALUES ${entries.map(() => "(?, ?)").join(", ")}`,
					)
					insertLogBodySearchManyByCount.set(entries.length, query)
				}
				query.run(...entries.flatMap(([logId, body]) => [logId, body]))
			}

			const maxDbSizeBytes = config.otel.maxDbSizeMb * 1024 * 1024

			const cleanupExpired = Effect.fn("motel/TelemetryStore.cleanupExpired")(
				function* () {
					const now = yield* Clock.currentTimeMillis

					yield* Effect.sync(() => {
						const cutoff = now - config.otel.retentionHours * 60 * 60 * 1000

						// Evict at TRACE granularity so we never leave a trace half-gutted
						// (previous logic deleted oldest 20% of spans, which happily sliced
						// across traces and corrupted the summary rebuild). Running traces
						// are protected — only `active_span_count = 0` summaries are in
						// scope for eviction.
						const toEvict = new Set<string>()

						// Time-based: completed traces whose last span ended before cutoff.
						const timeExpired = db
							.query(
								`SELECT trace_id FROM trace_summaries WHERE active_span_count = 0 AND ended_at_ms > 0 AND ended_at_ms < ?`,
							)
							.all(cutoff) as readonly { trace_id: string }[]
						for (const row of timeExpired) toEvict.add(row.trace_id)

						// Size-based: if actual data exceeds cap, drop oldest 20% of the
						// remaining completed traces. `(page_count - freelist_count)`
						// ignores freed-but-not-vacuumed pages so a large freelist doesn't
						// trigger a deletion death spiral.
						const pageCount = (
							db.query(`PRAGMA page_count`).get() as { page_count: number }
						).page_count
						const freePages = (
							db.query(`PRAGMA freelist_count`).get() as {
								freelist_count: number
							}
						).freelist_count
						const pageSize = (
							db.query(`PRAGMA page_size`).get() as { page_size: number }
						).page_size
						const dbSize = (pageCount - freePages) * pageSize
						if (dbSize > maxDbSizeBytes) {
							const completedCount = (
								db
									.query(
										`SELECT COUNT(*) AS c FROM trace_summaries WHERE active_span_count = 0`,
									)
									.get() as { c: number }
							).c
							const traceCutCount = Math.max(
								1,
								Math.floor(completedCount * 0.2),
							)
							const oldest = db
								.query(
									`SELECT trace_id FROM trace_summaries WHERE active_span_count = 0 ORDER BY started_at_ms ASC LIMIT ?`,
								)
								.all(traceCutCount) as readonly { trace_id: string }[]
							// Set.add dedupes overlap with the time-expired batch above.
							for (const row of oldest) toEvict.add(row.trace_id)
						}

						// Always prune orphan logs (no trace_id) by timestamp — they're
						// not covered by trace eviction.
						db.query(
							`DELETE FROM logs WHERE trace_id IS NULL AND timestamp_ms < ?`,
						).run(cutoff)

						if (toEvict.size === 0) return

						// Batch the trace-id list so the IN placeholders stay under
						// SQLite's default limit (~999). Each batch wipes every row
						// reachable from those trace_ids across the cascade tables.
						const traceIds = Array.from(toEvict)
						const BATCH_SIZE = 500
						for (
							let offset = 0;
							offset < traceIds.length;
							offset += BATCH_SIZE
						) {
							const batch = traceIds.slice(offset, offset + BATCH_SIZE)
							const placeholders = batch.map(() => "?").join(",")
							db.query(
								`DELETE FROM span_attributes WHERE trace_id IN (${placeholders})`,
							).run(...batch)
							try {
								db.query(
									`DELETE FROM span_operation_fts WHERE trace_id IN (${placeholders})`,
								).run(...batch)
							} catch {
								// FTS table may not exist on old DBs.
							}
							db.query(
								`DELETE FROM spans WHERE trace_id IN (${placeholders})`,
							).run(...batch)
							db.query(
								`DELETE FROM logs WHERE trace_id IN (${placeholders})`,
							).run(...batch)
							db.query(
								`DELETE FROM trace_summaries WHERE trace_id IN (${placeholders})`,
							).run(...batch)
						}

						// Log-side orphans (log_attributes + FTS) are keyed by log.id,
						// so prune what no longer has a parent log row.
						db.query(
							`DELETE FROM log_attributes WHERE NOT EXISTS (SELECT 1 FROM logs WHERE logs.id = log_attributes.log_id)`,
						).run()
						try {
							db.query(
								`DELETE FROM log_body_fts WHERE NOT EXISTS (SELECT 1 FROM logs WHERE logs.id = CAST(log_body_fts.log_id AS INTEGER))`,
							).run()
						} catch {
							// FTS table may not exist on old DBs.
						}

						// Truncate the WAL after a big delete pass. Without this the
						// WAL keeps growing (observed: 640MB) because wal_autocheckpoint
						// only triggers when WAL pages exceed the threshold during
						// writes — a retention pass that evicts millions of rows can
						// blow far past that before the auto-checkpoint fires. Using
						// PASSIVE so active readers aren't interrupted; if the WAL
						// can't be fully reclaimed right now, we'll try again next
						// cycle.
						try {
							db.exec(`PRAGMA wal_checkpoint(PASSIVE);`)
						} catch {
							/* ignore */
						}

						// Incremental vacuum reclaims some of the freed pages back
						// to the OS so the file size actually shrinks over time
						// instead of just growing the freelist. Bounded to 2000
						// pages per pass (≈8MB) to avoid a long-running transaction.
						try {
							db.exec(`PRAGMA incremental_vacuum(2000);`)
						} catch {
							/* ignore */
						}
					})
				},
			)

			// Retention only runs in processes that opt in (currently the main
			// daemon). The ingest worker and TUI skip it to avoid two writers
			// competing for the write lock with overlapping DELETE passes.
			if (opts.runRetention) {
				// Reconcile any summary drift from interrupted ingests, but do it
				// after the server becomes healthy. Running this synchronously at
				// open can sit behind another writer's lock for ~15s and make the
				// daemon look hung even though the port is already bound.
				yield* Effect.forkScoped(reconcileTraceSummaries)

				// Enable incremental vacuum so retention can reclaim freed
				// pages over time instead of needing a stop-the-world VACUUM.
				// Idempotent: repeat calls after the first are no-ops.
				try {
					db.exec(`PRAGMA auto_vacuum = INCREMENTAL;`)
				} catch {
					/* ignore */
				}

				// Run cleanup every 60 seconds in the background, tied to the layer's scope
				yield* Effect.forkScoped(
					Effect.repeat(cleanupExpired(), Schedule.spaced("60 seconds")),
				)

				// Periodically refresh query planner stats. `PRAGMA optimize` is a
				// no-op when nothing has changed, so this is essentially free on idle
				// servers and keeps facet/search planner estimates accurate as data
				// grows. 15 minutes is slower than ingestion rates we care about but
				// frequent enough that the attribute picker stays snappy.
				const refreshPlannerStats = Effect.sync(() => {
					try {
						db.exec(`PRAGMA optimize;`)
					} catch {
						/* ignore */
					}
				})
				yield* Effect.forkScoped(
					Effect.repeat(refreshPlannerStats, Schedule.spaced("15 minutes")),
				)
			}

			// One-time backfill for existing DBs: if span_attr_fts is empty but
			// span_attributes has rows with AI_FTS_KEYS, populate the index.
			// Runs forked so server startup isn't blocked; queries hitting the
			// FTS will just return empty until the fill lands. On a 2 GB DB with
			// ~400 matching rows this takes ~3-8 seconds. Writer-only because
			// it does INSERT INTO ... — readonly connections would error.
			if (hasAttrFts && !opts.readonly) {
				const backfillAttrFts = Effect.sync(() => {
					try {
						const ftsCount = (
							db.query(`SELECT COUNT(*) AS c FROM span_attr_fts`).get() as {
								c: number
							}
						).c
						if (ftsCount > 0) return
						const keyList = AI_FTS_KEYS.map(
							(k) => `'${k.replace(/'/g, "''")}'`,
						).join(", ")
						const attrCount = (
							db
								.query(
									`SELECT COUNT(*) AS c FROM span_attributes WHERE key IN (${keyList})`,
								)
								.get() as { c: number }
						).c
						if (attrCount === 0) return
						// Single INSERT..SELECT is atomic and fast; FTS5 batches
						// its internal segment writes. No transaction wrapper
						// needed — it runs as one statement.
						db.exec(`
						INSERT INTO span_attr_fts(rowid, value)
						SELECT rowid, value FROM span_attributes WHERE key IN (${keyList})
					`)
					} catch {
						// Backfill failure is never fatal — new ingests still
						// populate FTS via the trigger, and queries fall back to
						// LIKE when FTS lookups return empty.
					}
				})
				yield* Effect.forkScoped(backfillAttrFts)
			}

			const ingestTraces = Effect.fn("motel/TelemetryStore.ingestTraces")(
				function* (payload: OtlpTraceExportRequest) {
					return yield* Effect.sync(() => {
						let insertedSpans = 0
						const transaction = db.transaction(
							(request: OtlpTraceExportRequest) => {
								const touchedTraceIds = new Set<string>()
								const touchedOperations: Array<
									readonly [string, string, string]
								> = []
								for (const resourceSpans of request.resourceSpans ?? []) {
									const resourceAttributes = attributeMap(
										resourceSpans.resource?.attributes,
									)
									const serviceName =
										resourceAttributes["service.name"] ||
										resourceAttributes["service_name"] ||
										"unknown"

									for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
										const scopeName = scopeSpans.scope?.name ?? null

										for (const span of scopeSpans.spans ?? []) {
											const spanAttributes = attributeMap(span.attributes)
											const mergedAttributes = {
												...resourceAttributes,
												...spanAttributes,
											}
											const startTimeMs = nanosToMilliseconds(
												span.startTimeUnixNano,
											)
											const endTimeMs = nanosToMilliseconds(
												span.endTimeUnixNano,
											)
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
												JSON.stringify(spanAttributes),
												JSON.stringify(resourceAttributes),
												JSON.stringify(events),
											)
											deleteSpanAttributes.run(span.traceId, span.spanId)
											insertSpanAttributesMany(
												span.traceId,
												span.spanId,
												mergedAttributes,
											)
											touchedOperations.push([
												span.traceId,
												span.spanId,
												span.name ?? "unknown",
											])
											touchedTraceIds.add(span.traceId)
											insertedSpans += 1
										}
									}
								}
								try {
									const BATCH_SIZE = 500
									for (
										let offset = 0;
										offset < touchedOperations.length;
										offset += BATCH_SIZE
									) {
										updateSpanOperationSearchMany(
											touchedOperations.slice(offset, offset + BATCH_SIZE),
										)
									}
								} catch {
									// FTS is optional.
								}
								for (const traceId of touchedTraceIds) {
									upsertTraceSummary.run(traceId)
								}
							},
						)

						transaction(payload)
						return { insertedSpans }
					})
				},
			)

			const ingestLogs = Effect.fn("motel/TelemetryStore.ingestLogs")(
				function* (payload: OtlpLogExportRequest) {
					return yield* Effect.sync(() => {
						let insertedLogs = 0
						const transaction = db.transaction(
							(request: OtlpLogExportRequest) => {
								const touchedLogBodies: Array<readonly [string, string]> = []
								for (const resourceLogs of request.resourceLogs ?? []) {
									const resourceAttributes = attributeMap(
										resourceLogs.resource?.attributes,
									)
									const serviceName =
										resourceAttributes["service.name"] ||
										resourceAttributes["service_name"] ||
										"unknown"

									for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
										const scopeName = scopeLogs.scope?.name ?? null

										for (const record of scopeLogs.logRecords ?? []) {
											const attributes = attributeMap(record.attributes)
											const mergedAttributes = {
												...resourceAttributes,
												...attributes,
											}
											const timestampMs = nanosToMilliseconds(
												record.timeUnixNano ?? record.observedTimeUnixNano,
											)
											const body = stringifyValue(parseAnyValue(record.body))
											const result = insertLog.run(
												attributes.traceId ||
													attributes.trace_id ||
													record.traceId ||
													null,
												attributes.spanId ||
													attributes.span_id ||
													record.spanId ||
													null,
												serviceName,
												scopeName,
												record.severityText ?? "INFO",
												timestampMs,
												body,
												JSON.stringify(attributes),
												JSON.stringify(resourceAttributes),
											)
											const logId = Number(
												(result as { lastInsertRowid: number | bigint })
													.lastInsertRowid,
											)
											insertLogAttributesMany(logId, mergedAttributes)
											touchedLogBodies.push([String(logId), body])
											insertedLogs += 1
										}
									}
								}
								try {
									const BATCH_SIZE = 500
									for (
										let offset = 0;
										offset < touchedLogBodies.length;
										offset += BATCH_SIZE
									) {
										insertLogBodySearchMany(
											touchedLogBodies.slice(offset, offset + BATCH_SIZE),
										)
									}
								} catch {
									// FTS is optional.
								}
							},
						)

						transaction(payload)
						return { insertedLogs }
					})
				},
			)

			const listServices = Effect.fn("motel/TelemetryStore.listServices")(
				function* () {
					const cutoff =
						(yield* Clock.currentTimeMillis) -
						config.otel.traceLookbackMinutes * 60 * 1000
					return yield* Effect.sync(() => {
						const rows = db
							.query(
								`
					SELECT service_name FROM spans WHERE start_time_ms >= ?
					UNION
					SELECT service_name FROM logs WHERE timestamp_ms >= ?
					ORDER BY service_name ASC
				`,
							)
							.all(cutoff, cutoff) as Array<{ service_name: string }>
						return rows.map((row) => row.service_name)
					})
				},
			)()

			const loadTracesByIds = (traceIds: readonly string[]) => {
				if (traceIds.length === 0) return [] as readonly TraceItem[]
				const placeholders = traceIds.map(() => "?").join(", ")
				const rows = db
					.query(
						`
				SELECT * FROM spans
				WHERE trace_id IN (${placeholders})
				ORDER BY start_time_ms ASC
			`,
					)
					.all(...traceIds) as SpanRow[]

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
			}

			const listRecentTraces = Effect.fn(
				"motel/TelemetryStore.listRecentTraces",
			)(function* (
				serviceName: string | null,
				options?: {
					readonly lookbackMinutes?: number
					readonly limit?: number
				},
			) {
				const summaries = yield* listTraceSummaries(serviceName, options)
				return yield* Effect.sync(() =>
					loadTracesByIds(summaries.map((summary) => summary.traceId)),
				)
			})

			const listTraceSummaries = Effect.fn(
				"motel/TelemetryStore.listTraceSummaries",
			)(function* (
				serviceName: string | null,
				options?: {
					readonly lookbackMinutes?: number
					readonly limit?: number
					readonly cursorStartedAtMs?: number
					readonly cursorTraceId?: string
				},
			) {
				const cutoff =
					(yield* Clock.currentTimeMillis) -
					(options?.lookbackMinutes ?? config.otel.traceLookbackMinutes) *
						60 *
						1000
				const limit = options?.limit ?? config.otel.traceFetchLimit

				return yield* Effect.sync(() => {
					const clauses = ["started_at_ms >= ?"]
					const params: Array<string | number> = [cutoff]

					if (serviceName) {
						clauses.push("service_name = ?")
						params.push(serviceName)
					}

					if (options?.cursorStartedAtMs != null && options.cursorTraceId) {
						clauses.push(
							"(started_at_ms < ? OR (started_at_ms = ? AND trace_id < ?))",
						)
						params.push(
							options.cursorStartedAtMs,
							options.cursorStartedAtMs,
							options.cursorTraceId,
						)
					}

					return db
						.query(
							`
					SELECT trace_id, service_name, root_operation_name, started_at_ms, ended_at_ms, active_span_count, duration_ms, span_count, error_count
					FROM trace_summaries
					WHERE ${clauses.join(" AND ")}
					ORDER BY started_at_ms DESC, trace_id DESC
					LIMIT ?
				`,
						)
						.all(...params, limit) as TraceSummaryRow[]
				}).pipe(Effect.map((rows) => rows.map(parseSummaryRow)))
			})

			const searchTraceSummaries = Effect.fn(
				"motel/TelemetryStore.searchTraceSummaries",
			)(function* (input: TraceSearch) {
				const cutoff =
					(yield* Clock.currentTimeMillis) -
					(input.lookbackMinutes ?? config.otel.traceLookbackMinutes) *
						60 *
						1000
				const limit = input.limit ?? config.otel.traceFetchLimit

				return yield* Effect.sync(() => {
					const clauses: string[] = ["started_at_ms >= ?"]
					const params: Array<string | number> = [cutoff]

					if (input.serviceName) {
						clauses.push("service_name = ?")
						params.push(input.serviceName)
					}
					if (input.status === "error") {
						clauses.push("error_count > 0")
					}
					if (input.status === "ok") {
						clauses.push("error_count = 0")
					}
					if (input.minDurationMs != null) {
						clauses.push("duration_ms >= ?")
						params.push(input.minDurationMs)
					}
					if (input.cursorStartedAtMs != null && input.cursorTraceId) {
						clauses.push(
							"(started_at_ms < ? OR (started_at_ms = ? AND trace_id < ?))",
						)
						params.push(
							input.cursorStartedAtMs,
							input.cursorStartedAtMs,
							input.cursorTraceId,
						)
					}

					if (input.operation) {
						const ftsQuery = toFtsMatchQuery(input.operation)
						if (hasFts && ftsQuery) {
							clauses.push(
								"trace_id IN (SELECT DISTINCT trace_id FROM span_operation_fts WHERE span_operation_fts MATCH ?)",
							)
							params.push(ftsQuery)
						} else {
							clauses.push(
								"trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE operation_name LIKE ? COLLATE NOCASE)",
							)
							params.push(`%${input.operation}%`)
						}
					}

					const exactAttrMatch = buildExactAttributeMatchSubquery(
						"span_attributes",
						["trace_id", "span_id"],
						input.attributeFilters,
					)
					if (exactAttrMatch) {
						clauses.push(
							`trace_id IN (SELECT DISTINCT trace_id FROM (${exactAttrMatch.sql}))`,
						)
						params.push(...exactAttrMatch.params)
					}

					// `:ai <query>` — FTS match against LLM content keys. Joins
					// span_attr_fts back to span_attributes to collect trace_ids
					// whose spans carry matching prompt/response content. Falls
					// through to no-op when the query tokenizes empty (e.g. only
					// stopwords or operator-chars) so users don't get a silently
					// empty list.
					if (input.aiText) {
						const aiFtsQuery = toFtsMatchQuery(input.aiText)
						if (hasAttrFts && aiFtsQuery) {
							clauses.push(`trace_id IN (
							SELECT DISTINCT sa.trace_id
							FROM span_attr_fts fts
							JOIN span_attributes sa ON sa.rowid = fts.rowid
							WHERE fts.value MATCH ?
						)`)
							params.push(aiFtsQuery)
						}
					}

					const rows = db
						.query(
							`
					SELECT trace_id, service_name, root_operation_name, started_at_ms, ended_at_ms, active_span_count, duration_ms, span_count, error_count
					FROM trace_summaries
					WHERE ${clauses.join(" AND ")}
					ORDER BY started_at_ms DESC, trace_id DESC
					LIMIT ?
				`,
						)
						.all(...params, limit) as TraceSummaryRow[]

					return rows.map(parseSummaryRow)
				})
			})

			const getTrace = Effect.fn("motel/TelemetryStore.getTrace")(function* (
				traceId: string,
			) {
				return yield* Effect.sync(() => {
					const rows = db
						.query(
							`
					SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC
				`,
						)
						.all(traceId) as SpanRow[]
					return rows.length === 0 ? null : buildTrace(traceId, rows)
				})
			})

			const getSpan = Effect.fn("motel/TelemetryStore.getSpan")(function* (
				spanId: string,
			) {
				return yield* Effect.sync(() => {
					// Fetch only the target span row (uses idx_spans_span_id)
					const spanRow = db
						.query(`SELECT * FROM spans WHERE span_id = ? LIMIT 1`)
						.get(spanId) as SpanRow | null
					if (!spanRow) return null

					const traceId = spanRow.trace_id

					// Get root operation name (indexed by trace_id)
					const rootRow = db
						.query(
							`
					SELECT operation_name FROM spans
					WHERE trace_id = ? AND parent_span_id IS NULL
					ORDER BY start_time_ms ASC LIMIT 1
				`,
						)
						.get(traceId) as { operation_name: string } | null
					const rootOperationName = rootRow?.operation_name ?? "unknown"

					// Get parent operation name if span has a parent (PK lookup)
					let parentOperationName: string | null = null
					if (spanRow.parent_span_id) {
						const parentRow = db
							.query(
								`
						SELECT operation_name FROM spans
						WHERE trace_id = ? AND span_id = ?
					`,
							)
							.get(traceId, spanRow.parent_span_id) as {
							operation_name: string
						} | null
						parentOperationName = parentRow?.operation_name ?? null
					}

					// Compute depth by walking up parent chain (typically 3-5 hops)
					let depth = 0
					let currentParentId = spanRow.parent_span_id
					while (currentParentId) {
						const parentRow = db
							.query(
								`
						SELECT parent_span_id FROM spans WHERE trace_id = ? AND span_id = ?
					`,
							)
							.get(traceId, currentParentId) as {
							parent_span_id: string | null
						} | null
						if (!parentRow) break
						depth++
						currentParentId = parentRow.parent_span_id
					}

					const parsed = parseSpanRow(spanRow)
					return {
						traceId,
						rootOperationName,
						parentOperationName,
						span: { ...parsed, depth },
					} satisfies SpanItem
				})
			})

			const listTraceSpans = Effect.fn("motel/TelemetryStore.listTraceSpans")(
				function* (traceId: string) {
					return yield* Effect.sync(() => {
						const rows = db
							.query(
								`SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC`,
							)
							.all(traceId) as SpanRow[]
						return rows.length === 0
							? ([] as readonly SpanItem[])
							: buildSpanItems(traceId, rows)
					})
				},
			)

			const searchSpans = Effect.fn("motel/TelemetryStore.searchSpans")(
				function* (input: SpanSearch) {
					const cutoff =
						(yield* Clock.currentTimeMillis) -
						(input.lookbackMinutes ?? config.otel.traceLookbackMinutes) *
							60 *
							1000
					const limit = input.limit ?? 100
					const hasContainsFilters =
						Object.keys(input.attributeContainsFilters ?? {}).length > 0
					const candidateLimit = hasContainsFilters
						? Math.max(limit * 20, 500)
						: Math.max(limit * 10, 200)

					return yield* Effect.sync(() => {
						let fromSql = "FROM spans AS s"
						const joinParams: Array<string | number> = []
						const clauses: string[] = ["s.start_time_ms >= ?"]
						const params: Array<string | number> = [cutoff]

						if (input.traceId) {
							clauses.push("s.trace_id = ?")
							params.push(input.traceId)
						}
						if (input.serviceName) {
							clauses.push("s.service_name = ?")
							params.push(input.serviceName)
						}
						if (input.operation) {
							const ftsQuery = toFtsMatchQuery(input.operation)
							if (hasFts && ftsQuery) {
								fromSql += ` INNER JOIN (SELECT trace_id, span_id FROM span_operation_fts WHERE span_operation_fts MATCH ?) AS span_operation_match ON span_operation_match.trace_id = s.trace_id AND span_operation_match.span_id = s.span_id`
								joinParams.push(ftsQuery)
							} else {
								clauses.push("s.operation_name LIKE ? COLLATE NOCASE")
								params.push(`%${input.operation}%`)
							}
						}
						if (input.status) {
							clauses.push("s.status = ?")
							params.push(input.status)
						}

						const exactAttrMatch = buildExactAttributeMatchSubquery(
							"span_attributes",
							["trace_id", "span_id"],
							input.attributeFilters,
						)
						if (exactAttrMatch) {
							clauses.push(
								`EXISTS (SELECT 1 FROM (${exactAttrMatch.sql}) AS span_attr_match WHERE span_attr_match.trace_id = s.trace_id AND span_attr_match.span_id = s.span_id)`,
							)
							params.push(...exactAttrMatch.params)
						}

						const containsAttrMatch = buildContainsAttributeMatchSubquery(
							"span_attributes",
							["trace_id", "span_id"],
							input.attributeContainsFilters,
						)
						if (containsAttrMatch) {
							clauses.push(
								`EXISTS (SELECT 1 FROM (${containsAttrMatch.sql}) AS span_attr_contains_match WHERE span_attr_contains_match.trace_id = s.trace_id AND span_attr_contains_match.span_id = s.span_id)`,
							)
							params.push(...containsAttrMatch.params)
						}

						const rows = db
							.query(
								`
					SELECT *
					${fromSql}
					WHERE ${clauses.join(" AND ")}
					ORDER BY s.start_time_ms DESC
					LIMIT ?
				`,
							)
							.all(...joinParams, ...params, candidateLimit) as SpanRow[]

						const traceIds = [...new Set(rows.map((row) => row.trace_id))]
						if (traceIds.length === 0) return [] as readonly SpanItem[]

						const keyOf = (traceId: string, spanId: string) =>
							`${traceId}:${spanId}`
						const spanContextById = new Map<
							string,
							{
								readonly parentSpanId: string | null
								readonly operationName: string
							}
						>()
						for (const row of rows) {
							spanContextById.set(keyOf(row.trace_id, row.span_id), {
								parentSpanId: row.parent_span_id,
								operationName: row.operation_name,
							})
						}

						const placeholders = traceIds.map(() => "?").join(", ")
						const rootRows = db
							.query(
								`
					SELECT trace_id, operation_name
					FROM spans
					WHERE trace_id IN (${placeholders}) AND parent_span_id IS NULL
					ORDER BY start_time_ms ASC
				`,
							)
							.all(...traceIds) as Array<{
							trace_id: string
							operation_name: string
						}>
						const rootOperationByTraceId = new Map<string, string>()
						for (const row of rootRows) {
							if (!rootOperationByTraceId.has(row.trace_id)) {
								rootOperationByTraceId.set(row.trace_id, row.operation_name)
							}
						}

						const spanContextLookup = db.query(`
					SELECT parent_span_id, operation_name
					FROM spans
					WHERE trace_id = ? AND span_id = ?
				`)

						const getSpanContext = (traceId: string, spanId: string) => {
							const key = keyOf(traceId, spanId)
							const cached = spanContextById.get(key)
							if (cached !== undefined) return cached
							const row = spanContextLookup.get(traceId, spanId) as {
								parent_span_id: string | null
								operation_name: string
							} | null
							if (!row) return null
							const value = {
								parentSpanId: row.parent_span_id,
								operationName: row.operation_name,
							}
							spanContextById.set(key, value)
							return value
						}

						const depthById = new Map<string, number>()
						const getDepth = (
							traceId: string,
							spanId: string,
							visiting = new Set<string>(),
						): number => {
							const key = keyOf(traceId, spanId)
							const cached = depthById.get(key)
							if (cached !== undefined) return cached
							if (visiting.has(key)) return 0
							visiting.add(key)
							const context = getSpanContext(traceId, spanId)
							const depth = context?.parentSpanId
								? getDepth(traceId, context.parentSpanId, visiting) + 1
								: 0
							depthById.set(key, depth)
							return depth
						}

						return rows
							.map((row) => {
								const parentContext = row.parent_span_id
									? getSpanContext(row.trace_id, row.parent_span_id)
									: null
								const parsedSpan = parseSpanRow(row)
								const span = {
									...parsedSpan,
									depth: getDepth(row.trace_id, row.span_id),
									warnings:
										row.parent_span_id && !parentContext
											? [`missing span ${row.parent_span_id} (1 child)`]
											: parsedSpan.warnings,
								}
								return {
									traceId: row.trace_id,
									rootOperationName:
										rootOperationByTraceId.get(row.trace_id) ??
										span.operationName,
									parentOperationName: parentContext?.operationName ?? null,
									span,
								} satisfies SpanItem
							})
							.filter((item) => {
								if (input.parentOperation) {
									const needle = input.parentOperation.toLowerCase()
									if (!item.parentOperationName?.toLowerCase().includes(needle))
										return false
								}
								return true
							})
							.slice(0, limit)
					})
				},
			)

			const searchTraces = Effect.fn("motel/TelemetryStore.searchTraces")(
				function* (input: TraceSearch) {
					const summaries = yield* searchTraceSummaries(input)
					return yield* Effect.sync(() =>
						loadTracesByIds(summaries.map((summary) => summary.traceId)),
					)
				},
			)

			const searchLogs = Effect.fn("motel/TelemetryStore.searchLogs")(
				function* (input: LogSearch) {
					const now = yield* Clock.currentTimeMillis
					return yield* Effect.sync(() => {
						const clauses: string[] = []
						const params: Array<string | number> = []

						if (input.serviceName) {
							clauses.push(`service_name = ?`)
							params.push(input.serviceName)
						}
						if (input.severity) {
							clauses.push(`severity_text = ?`)
							params.push(input.severity.toUpperCase())
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
							const ftsQuery = toFtsMatchQuery(input.body)
							if (hasFts && ftsQuery) {
								clauses.push(
									`id IN (SELECT CAST(log_id AS INTEGER) FROM log_body_fts WHERE log_body_fts MATCH ?)`,
								)
								params.push(ftsQuery)
							} else {
								clauses.push(`body LIKE ? COLLATE NOCASE`)
								params.push(`%${input.body}%`)
							}
						}
						if (input.lookbackMinutes) {
							const cutoff = now - input.lookbackMinutes * 60 * 1000
							clauses.push(`timestamp_ms >= ?`)
							params.push(cutoff)
						}
						if (input.cursorTimestampMs != null && input.cursorId) {
							clauses.push(
								`(timestamp_ms < ? OR (timestamp_ms = ? AND id < ?))`,
							)
							params.push(
								input.cursorTimestampMs,
								input.cursorTimestampMs,
								Number(input.cursorId),
							)
						}

						const exactAttrMatch = buildExactAttributeMatchSubquery(
							"log_attributes",
							["log_id"],
							input.attributeFilters,
						)
						if (exactAttrMatch) {
							clauses.push(`id IN (${exactAttrMatch.sql})`)
							params.push(...exactAttrMatch.params)
						}

						const containsAttrMatch = buildContainsAttributeMatchSubquery(
							"log_attributes",
							["log_id"],
							input.attributeContainsFilters,
						)
						if (containsAttrMatch) {
							clauses.push(`id IN (${containsAttrMatch.sql})`)
							params.push(...containsAttrMatch.params)
						}

						const where =
							clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
						const limit = input.limit ?? config.otel.logFetchLimit
						const rows = db
							.query(
								`
					SELECT * FROM logs
					${where}
					ORDER BY timestamp_ms DESC, id DESC
					LIMIT ?
				`,
							)
							.all(...params, limit) as LogRow[]

						return rows.map(parseLogRow)
					})
				},
			)

			const traceStats = Effect.fn("motel/TelemetryStore.traceStats")(
				function* (input: TraceStatsSearch) {
					const cutoff =
						(yield* Clock.currentTimeMillis) -
						(input.lookbackMinutes ?? config.otel.traceLookbackMinutes) *
							60 *
							1000
					const limit = input.limit ?? 20
					const hasAttrFilters =
						Object.keys(input.attributeFilters ?? {}).length > 0
					const isAttrGroupBy = input.groupBy.startsWith("attr.")

					if (isAttrGroupBy || hasAttrFilters || input.operation) {
						const summaries = yield* searchTraceSummaries({
							serviceName: input.serviceName,
							operation: input.operation,
							status: input.status,
							minDurationMs: input.minDurationMs,
							attributeFilters: input.attributeFilters,
							lookbackMinutes: input.lookbackMinutes,
							limit: 5000,
						})

						// For attr.* groupBy, we need to check span attributes — but only the groupBy key
						let attrLookup: Map<string, string> | null = null
						if (isAttrGroupBy) {
							const attrKey = input.groupBy.slice(5)
							const traceIds = summaries.map((s) => s.traceId)
							if (traceIds.length > 0) {
								const placeholders = traceIds.map(() => "?").join(", ")
								const rows = db
									.query(
										`
							SELECT trace_id, value
							FROM span_attributes
							WHERE key = ? AND trace_id IN (${placeholders})
							GROUP BY trace_id
						`,
									)
									.all(attrKey, ...traceIds) as Array<{
									trace_id: string
									value: string
								}>

								attrLookup = new Map()
								for (const row of rows) {
									attrLookup.set(row.trace_id, row.value)
								}
							}
						}

						const groups = new Map<
							string,
							{ durations: number[]; errorTraces: number }
						>()
						for (const summary of summaries) {
							const group =
								input.groupBy === "service"
									? summary.serviceName
									: input.groupBy === "operation"
										? summary.rootOperationName
										: input.groupBy === "status"
											? summary.errorCount > 0
												? "error"
												: "ok"
											: isAttrGroupBy
												? (attrLookup?.get(summary.traceId) ?? "unknown")
												: "unknown"

							const bucket = groups.get(group) ?? {
								durations: [],
								errorTraces: 0,
							}
							bucket.durations.push(summary.durationMs)
							if (summary.errorCount > 0) bucket.errorTraces++
							groups.set(group, bucket)
						}

						const rows = [...groups.entries()].map(([group, bucket]) => {
							const count = bucket.durations.length
							const value =
								input.agg === "count"
									? count
									: input.agg === "avg_duration"
										? bucket.durations.reduce((sum, d) => sum + d, 0) /
											Math.max(1, count)
										: input.agg === "p95_duration"
											? percentile(bucket.durations, 0.95)
											: bucket.errorTraces / Math.max(1, count)
							return { group, value, count }
						})

						return rows
							.sort((left, right) => right.value - left.value)
							.slice(0, limit)
					}

					return yield* Effect.sync(() => {
						const whereClauses: string[] = ["started_at_ms >= ?"]
						const whereParams: Array<string | number> = [cutoff]

						if (input.serviceName) {
							whereClauses.push("service_name = ?")
							whereParams.push(input.serviceName)
						}

						if (input.status === "error") whereClauses.push("error_count > 0")
						if (input.status === "ok") whereClauses.push("error_count = 0")
						if (input.minDurationMs != null) {
							whereClauses.push("duration_ms >= ?")
							whereParams.push(input.minDurationMs)
						}

						const groupExpr =
							input.groupBy === "service"
								? "service_name"
								: input.groupBy === "operation"
									? "root_operation_name"
									: input.groupBy === "status"
										? "CASE WHEN error_count > 0 THEN 'error' ELSE 'ok' END"
										: "'unknown'"

						const aggExpr =
							input.agg === "count"
								? "COUNT(*)"
								: input.agg === "avg_duration"
									? "AVG(duration_ms)"
									: "CAST(SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)"

						if (input.agg === "p95_duration") {
							const rows = db
								.query(
									`
						SELECT ${groupExpr} AS grp, duration_ms
						FROM trace_summaries
						WHERE ${whereClauses.join(" AND ")}
					`,
								)
								.all(...whereParams) as Array<{
								grp: string
								duration_ms: number
							}>

							const groups = new Map<string, number[]>()
							for (const row of rows) {
								const bucket = groups.get(row.grp) ?? []
								bucket.push(row.duration_ms)
								groups.set(row.grp, bucket)
							}

							return [...groups.entries()]
								.map(([group, durations]) => ({
									group,
									value: percentile(durations, 0.95),
									count: durations.length,
								}))
								.sort((left, right) => right.value - left.value)
								.slice(0, limit)
						}

						const rows = db
							.query(
								`
					SELECT ${groupExpr} AS grp, ${aggExpr} AS value, COUNT(*) AS count
					FROM trace_summaries
					WHERE ${whereClauses.join(" AND ")}
					GROUP BY grp
					ORDER BY value DESC
					LIMIT ?
				`,
							)
							.all(...whereParams, limit) as Array<{
							grp: string
							value: number
							count: number
						}>

						return rows.map((row) => ({
							group: row.grp,
							value: row.value,
							count: row.count,
						}))
					})
				},
			)

			const logStats = Effect.fn("motel/TelemetryStore.logStats")(function* (
				input: LogStatsSearch,
			) {
				const now = yield* Clock.currentTimeMillis
				const limit = input.limit ?? 20
				const hasAttrFilters =
					Object.keys(input.attributeFilters ?? {}).length > 0
				const isAttrGroupBy = input.groupBy.startsWith("attr.")

				// For attr.* groupBy or attr filters, fall back to in-memory grouping
				if (isAttrGroupBy || hasAttrFilters) {
					const logs = yield* searchLogs({
						serviceName: input.serviceName,
						traceId: input.traceId,
						spanId: input.spanId,
						body: input.body,
						lookbackMinutes: input.lookbackMinutes,
						attributeFilters: input.attributeFilters,
						limit: 5000,
					})

					const groups = new Map<string, number>()
					for (const log of logs) {
						const group =
							input.groupBy === "service"
								? log.serviceName
								: input.groupBy === "severity"
									? log.severityText
									: input.groupBy === "scope"
										? (log.scopeName ?? "unknown")
										: isAttrGroupBy
											? (log.attributes[input.groupBy.slice(5)] ?? "unknown")
											: "unknown"
						groups.set(group, (groups.get(group) ?? 0) + 1)
					}

					return [...groups.entries()]
						.map(([group, count]) => ({ group, value: count, count }))
						.sort((left, right) => right.value - left.value)
						.slice(0, limit)
				}

				// Pure SQL path for standard groupBy fields
				return yield* Effect.sync(() => {
					const clauses: string[] = []
					const params: Array<string | number> = []

					if (input.serviceName) {
						clauses.push("service_name = ?")
						params.push(input.serviceName)
					}
					if (input.traceId) {
						clauses.push("trace_id = ?")
						params.push(input.traceId)
					}
					if (input.spanId) {
						clauses.push("span_id = ?")
						params.push(input.spanId)
					}
					if (input.body) {
						clauses.push("body LIKE ?")
						params.push(`%${input.body}%`)
					}
					if (input.lookbackMinutes) {
						clauses.push("timestamp_ms >= ?")
						params.push(now - input.lookbackMinutes * 60 * 1000)
					}

					const where =
						clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""

					const groupExpr =
						input.groupBy === "service"
							? "service_name"
							: input.groupBy === "severity"
								? "severity_text"
								: input.groupBy === "scope"
									? "COALESCE(scope_name, 'unknown')"
									: "'unknown'"

					const rows = db
						.query(
							`
					SELECT ${groupExpr} AS grp, COUNT(*) AS count
					FROM logs
					${where}
					GROUP BY grp
					ORDER BY count DESC
					LIMIT ?
				`,
						)
						.all(...params, limit) as Array<{ grp: string; count: number }>

					return rows.map((row) => ({
						group: row.grp,
						value: row.count,
						count: row.count,
					}))
				})
			})

			const listRecentLogs = Effect.fn("motel/TelemetryStore.listRecentLogs")(
				function* (serviceName: string) {
					return yield* searchLogs({
						serviceName,
						limit: config.otel.logFetchLimit,
					})
				},
			)

			const listFacets = Effect.fn("motel/TelemetryStore.listFacets")(
				function* (input: FacetSearch) {
					const cutoff =
						(yield* Clock.currentTimeMillis) -
						(input.lookbackMinutes ?? config.otel.traceLookbackMinutes) *
							60 *
							1000
					const limit = input.limit ?? 20

					return yield* Effect.sync(() => {
						if (input.type === "logs") {
							if (input.field === "service") {
								const rows = db
									.query(
										`
							SELECT service_name AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							GROUP BY service_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`,
									)
									.all(cutoff, limit) as Array<{ value: string; count: number }>
								return rows
							}
							if (input.field === "severity") {
								const rows = db
									.query(
										`
							SELECT severity_text AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY severity_text
							ORDER BY count DESC, value ASC
							LIMIT ?
						`,
									)
									.all(
										...(input.serviceName
											? [cutoff, input.serviceName, limit]
											: [cutoff, limit]),
									) as Array<{ value: string; count: number }>
								return rows
							}
							if (input.field === "scope") {
								const rows = db
									.query(
										`
							SELECT COALESCE(scope_name, 'unknown') AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY COALESCE(scope_name, 'unknown')
							ORDER BY count DESC, value ASC
							LIMIT ?
						`,
									)
									.all(
										...(input.serviceName
											? [cutoff, input.serviceName, limit]
											: [cutoff, limit]),
									) as Array<{ value: string; count: number }>
								return rows
							}
						}

						if (input.type === "traces") {
							if (input.field === "service") {
								const rows = db
									.query(
										`
							SELECT service_name AS value, COUNT(*) AS count
							FROM trace_summaries
							WHERE started_at_ms >= ?
							GROUP BY service_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`,
									)
									.all(cutoff, limit) as Array<{ value: string; count: number }>
								return rows
							}
							if (input.field === "operation") {
								const rows = db
									.query(
										`
							SELECT root_operation_name AS value, COUNT(*) AS count
							FROM trace_summaries
							WHERE started_at_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY root_operation_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`,
									)
									.all(
										...(input.serviceName
											? [cutoff, input.serviceName, limit]
											: [cutoff, limit]),
									) as Array<{ value: string; count: number }>
								return rows
							}
							if (input.field === "status") {
								const rows = db
									.query(
										`
							SELECT CASE WHEN error_count > 0 THEN 'error' ELSE 'ok' END AS value, COUNT(*) AS count
							FROM trace_summaries
							WHERE started_at_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY value
							ORDER BY count DESC
							LIMIT ?
						`,
									)
									.all(
										...(input.serviceName
											? [cutoff, input.serviceName, limit]
											: [cutoff, limit]),
									) as Array<{ value: string; count: number }>
								return rows
							}
							if (input.field === "attribute_keys") {
								// Count distinct traces each attribute key appears on, optionally
								// scoped to a service. Keys with many distinct values (e.g. sessionId,
								// user id, model) rank higher than keys that are constant across every
								// trace (service.name, telemetry.sdk.*) — the latter can't discriminate
								// between traces so they're useless as filters.
								//
								// Performance note: we skip rows whose value blob is larger than
								// FACET_VALUE_MAX_LEN. For opencode this hides `ai.prompt`,
								// `ai.prompt.messages`, and `ai.prompt.tools` — which are 1-6MB text
								// blobs that you'd never want to filter by exact match anyway. The
								// WHERE clause lets SQLite skip reading those pages from disk. We also
								// dedupe to one (trace, key, value) row before grouping so repeated
								// span-level duplicates don't blow up the temp B-trees used for the
								// picker ranking query.
								const params: Array<string | number> = [
									FACET_VALUE_MAX_LEN,
									cutoff,
								]
								if (input.serviceName) params.push(input.serviceName)
								params.push(limit)
								const rows = db
									.query(
										`
							SELECT scoped.key AS value,
							       COUNT(DISTINCT scoped.trace_id) AS count,
							       COUNT(DISTINCT scoped.value) AS distinct_values
							FROM (
								SELECT DISTINCT sa.trace_id, sa.key, sa.value
								FROM span_attributes sa
								JOIN trace_summaries ts ON ts.trace_id = sa.trace_id
								WHERE LENGTH(sa.value) < ?
								  AND ts.started_at_ms >= ?
								  ${input.serviceName ? "AND ts.service_name = ?" : ""}
							) AS scoped
							GROUP BY scoped.key
							ORDER BY (CASE WHEN distinct_values = 1 THEN 1 ELSE 0 END) ASC,
							         distinct_values DESC,
							         count DESC,
							         value ASC
							LIMIT ?
						`,
									)
									.all(...params) as Array<{
									value: string
									count: number
									distinct_values: number
								}>
								return rows.map((row) => ({
									value: row.value,
									count: row.count,
								}))
							}
							if (input.field === "attribute_values") {
								if (!input.key) return [] as FacetItem[]
								// Skip multi-KB values here too — they blow up GROUP BY on big text.
								// Matches the attribute_keys pre-filter so the picker stays responsive
								// if someone hand-crafts a URL that targets a fat key.
								const params: Array<string | number> = [
									input.key,
									FACET_VALUE_MAX_LEN,
									cutoff,
								]
								if (input.serviceName) params.push(input.serviceName)
								params.push(limit)
								const rows = db
									.query(
										`
							SELECT sa.value AS value, COUNT(DISTINCT sa.trace_id) AS count
							FROM span_attributes sa
							JOIN spans s ON s.trace_id = sa.trace_id AND s.span_id = sa.span_id
							WHERE sa.key = ? AND LENGTH(sa.value) < ?
							  AND s.start_time_ms >= ?
							${input.serviceName ? "AND s.service_name = ?" : ""}
							GROUP BY sa.value
							ORDER BY count DESC, value ASC
							LIMIT ?
						`,
									)
									.all(...params) as Array<{ value: string; count: number }>
								return rows
							}
						}

						return [] as FacetItem[]
					})
				},
			)

			const listTraceLogs = Effect.fn("motel/TelemetryStore.listTraceLogs")(
				function* (traceId: string) {
					return yield* searchLogs({
						traceId,
						limit: config.otel.logFetchLimit,
					})
				},
			)

			// ---------------------------------------------------------------------------
			// AI Call queries
			// ---------------------------------------------------------------------------

			/** Extracts ai.streamText -> "streamText", ai.streamText.doStream -> "streamText" */
			const parseAiOperation = (operationName: string): string => {
				const parts = operationName.replace(/^ai\./, "").split(".")
				return parts[0] ?? operationName
			}

			/** Builds WHERE clauses for AI call search against the spans table (aliased as s) */
			const buildAiWhereClauses = (
				input: AiCallSearch | AiCallStatsSearch,
				cutoff: number,
			) => {
				const clauses: string[] = [
					"s.operation_name LIKE 'ai.%'",
					"s.operation_name NOT LIKE 'ai.%.do%'",
					"s.start_time_ms >= ?",
				]
				const params: Array<string | number> = [cutoff]

				if (input.service) {
					clauses.push("s.service_name = ?")
					params.push(input.service)
				}
				if (input.traceId) {
					clauses.push("s.trace_id = ?")
					params.push(input.traceId)
				}
				if (input.status) {
					clauses.push("s.status = ?")
					params.push(input.status)
				}
				if (input.minDurationMs != null) {
					clauses.push("s.duration_ms >= ?")
					params.push(input.minDurationMs)
				}
				if (input.operation) {
					clauses.push("s.operation_name LIKE ?")
					params.push(`ai.${input.operation}%`)
				}

				// Named attribute filters via span_attributes
				const attrFilters: Array<[string, string]> = []
				if (input.sessionId)
					attrFilters.push([AI_ATTR_MAP.sessionId, input.sessionId])
				if (input.functionId)
					attrFilters.push([AI_ATTR_MAP.functionId, input.functionId])
				if (input.provider)
					attrFilters.push([AI_ATTR_MAP.provider, input.provider])
				if (input.model) attrFilters.push([AI_ATTR_MAP.model, input.model])

				for (const [key, value] of attrFilters) {
					clauses.push(
						"EXISTS (SELECT 1 FROM span_attributes WHERE span_attributes.trace_id = s.trace_id AND span_attributes.span_id = s.span_id AND key = ? AND value = ?)",
					)
					params.push(key, value)
				}

				// Text search across prompt/response/tool attribute values via
				// FTS5. Prefers the external-content span_attr_fts index when
				// available, falls back to case-insensitive LIKE so old DBs
				// without FTS still work. FTS turns ~500ms full scans of 3 MB
				// prompt JSON into <50ms MATCH lookups.
				if ("text" in input && input.text) {
					const ftsQuery = toFtsMatchQuery(input.text)
					if (hasAttrFts && ftsQuery) {
						clauses.push(`EXISTS (
						SELECT 1 FROM span_attr_fts fts
						JOIN span_attributes sa ON sa.rowid = fts.rowid
						WHERE sa.trace_id = s.trace_id
						AND sa.span_id = s.span_id
						AND fts.value MATCH ?
					)`)
						params.push(ftsQuery)
					} else {
						const textKeys = AI_TEXT_SEARCH_KEYS.map(() => "?").join(", ")
						clauses.push(
							`EXISTS (SELECT 1 FROM span_attributes WHERE span_attributes.trace_id = s.trace_id AND span_attributes.span_id = s.span_id AND key IN (${textKeys}) AND value LIKE ? COLLATE NOCASE)`,
						)
						params.push(...AI_TEXT_SEARCH_KEYS, `%${input.text}%`)
					}
				}

				return { clauses, params }
			}

			/** Load attribute values for a set of spans by key */
			const loadSpanAttrValues = (
				spans: ReadonlyArray<{ trace_id: string; span_id: string }>,
				keys: readonly string[],
			): Map<string, Map<string, string>> => {
				if (spans.length === 0 || keys.length === 0) return new Map()
				const spanPlaceholders = spans.map(() => "(?, ?)").join(", ")
				const keyPlaceholders = keys.map(() => "?").join(", ")
				const spanParams = spans.flatMap((s) => [s.trace_id, s.span_id])

				const rows = db
					.query(
						`
				SELECT trace_id, span_id, key, value
				FROM span_attributes
				WHERE (trace_id, span_id) IN (VALUES ${spanPlaceholders})
				AND key IN (${keyPlaceholders})
			`,
					)
					.all(...spanParams, ...keys) as Array<{
					trace_id: string
					span_id: string
					key: string
					value: string
				}>

				const result = new Map<string, Map<string, string>>()
				for (const row of rows) {
					const spanKey = `${row.trace_id}:${row.span_id}`
					let attrs = result.get(spanKey)
					if (!attrs) {
						attrs = new Map()
						result.set(spanKey, attrs)
					}
					attrs.set(row.key, row.value)
				}
				return result
			}

			const searchAiCalls = Effect.fn("motel/TelemetryStore.searchAiCalls")(
				function* (input: AiCallSearch) {
					const cutoff =
						(yield* Clock.currentTimeMillis) -
						(input.lookbackMinutes ?? config.otel.traceLookbackMinutes) *
							60 *
							1000
					const limit = input.limit ?? 20

					return yield* Effect.sync(() => {
						const { clauses, params } = buildAiWhereClauses(input, cutoff)

						const rows = db
							.query(
								`
					SELECT s.trace_id, s.span_id, s.service_name, s.operation_name, s.start_time_ms, s.duration_ms, s.status
					FROM spans AS s
					WHERE ${clauses.join(" AND ")}
					ORDER BY s.start_time_ms DESC
					LIMIT ?
				`,
							)
							.all(...params, limit) as Array<{
							trace_id: string
							span_id: string
							service_name: string
							operation_name: string
							start_time_ms: number
							duration_ms: number
							status: string
						}>

						if (rows.length === 0) return [] as readonly AiCallSummary[]

						// Batch-load the attributes we need for summaries
						const summaryAttrKeys = [
							AI_ATTR_MAP.functionId,
							AI_ATTR_MAP.provider,
							AI_ATTR_MAP.model,
							AI_ATTR_MAP.sessionId,
							AI_ATTR_MAP.userId,
							AI_ATTR_MAP.finishReason,
							AI_ATTR_MAP.inputTokens,
							AI_ATTR_MAP.outputTokens,
							AI_ATTR_MAP.totalTokens,
							AI_ATTR_MAP.cachedInputTokens,
							AI_ATTR_MAP.reasoningTokens,
							AI_ATTR_MAP.promptMessages,
							AI_ATTR_MAP.prompt,
							AI_ATTR_MAP.responseText,
						]
						const attrMap = loadSpanAttrValues(rows, summaryAttrKeys)

						// Count tool call child spans per AI span
						const spanPlaceholders = rows.map(() => "(?, ?)").join(", ")
						const spanParams = rows.flatMap((r) => [r.trace_id, r.span_id])
						const toolCountRows = db
							.query(
								`
					SELECT parent_span_id, COUNT(*) AS cnt
					FROM spans
					WHERE (trace_id, parent_span_id) IN (VALUES ${spanPlaceholders})
					AND operation_name LIKE 'ai.toolCall%'
					GROUP BY trace_id, parent_span_id
				`,
							)
							.all(...spanParams) as Array<{
							parent_span_id: string
							cnt: number
						}>
						const toolCounts = new Map(
							toolCountRows.map((r) => [r.parent_span_id, r.cnt]),
						)

						return rows.map((row): AiCallSummary => {
							const spanKey = `${row.trace_id}:${row.span_id}`
							const attrs = attrMap.get(spanKey)
							const get = (key: string) => attrs?.get(key) ?? null
							const getNum = (key: string) => {
								const v = get(key)
								return v != null ? Number(v) : null
							}

							const promptContent =
								get(AI_ATTR_MAP.promptMessages) ?? get(AI_ATTR_MAP.prompt)

							return {
								traceId: row.trace_id,
								spanId: row.span_id,
								operation: parseAiOperation(row.operation_name),
								service: row.service_name,
								functionId: get(AI_ATTR_MAP.functionId),
								provider: get(AI_ATTR_MAP.provider),
								model: get(AI_ATTR_MAP.model),
								status: row.status === "error" ? "error" : "ok",
								startedAt: new Date(row.start_time_ms).toISOString(),
								durationMs: row.duration_ms,
								sessionId: get(AI_ATTR_MAP.sessionId),
								userId: get(AI_ATTR_MAP.userId),
								promptPreview: truncatePreview(promptContent),
								responsePreview: truncatePreview(get(AI_ATTR_MAP.responseText)),
								finishReason: get(AI_ATTR_MAP.finishReason),
								toolCallCount: toolCounts.get(row.span_id) ?? 0,
								usage: {
									inputTokens: getNum(AI_ATTR_MAP.inputTokens),
									outputTokens: getNum(AI_ATTR_MAP.outputTokens),
									totalTokens: getNum(AI_ATTR_MAP.totalTokens),
									cachedInputTokens: getNum(AI_ATTR_MAP.cachedInputTokens),
									reasoningTokens: getNum(AI_ATTR_MAP.reasoningTokens),
								},
							}
						})
					})
				},
			)

			const getAiCall = Effect.fn("motel/TelemetryStore.getAiCall")(function* (
				spanId: string,
			) {
				return yield* Effect.sync(() => {
					const row = db
						.query(
							`
					SELECT * FROM spans WHERE span_id = ? AND operation_name LIKE 'ai.%' LIMIT 1
				`,
						)
						.get(spanId) as SpanRow | null
					if (!row) return null

					// Load all attributes for this span
					const attrRows = db
						.query(
							`
					SELECT key, value FROM span_attributes
					WHERE trace_id = ? AND span_id = ?
				`,
						)
						.all(row.trace_id, row.span_id) as Array<{
						key: string
						value: string
					}>
					const attrs = new Map(attrRows.map((r) => [r.key, r.value]))
					const get = (key: string) => attrs.get(key) ?? null
					const getNum = (key: string) => {
						const v = get(key)
						return v != null ? Number(v) : null
					}

					// Load tool call child spans
					const toolCallRows = db
						.query(
							`
					SELECT span_id, operation_name, duration_ms, status, attributes_json
					FROM spans
					WHERE trace_id = ? AND parent_span_id = ? AND operation_name LIKE 'ai.toolCall%'
					ORDER BY start_time_ms ASC
				`,
						)
						.all(row.trace_id, row.span_id) as SpanRow[]

					const toolCalls = toolCallRows.map((tc) => {
						const tcAttrs = JSON.parse(tc.attributes_json) as Record<
							string,
							string
						>
						return {
							name: tcAttrs["ai.toolCall.name"] ?? tc.operation_name,
							spanId: tc.span_id,
							status:
								tc.status === "error" ? ("error" as const) : ("ok" as const),
							durationMs: tc.duration_ms,
						}
					})

					// Load correlated logs
					const logRows = db
						.query(
							`
					SELECT * FROM logs WHERE span_id = ? ORDER BY timestamp_ms ASC
				`,
						)
						.all(row.span_id) as LogRow[]
					const logs = logRows.map(parseLogRow)

					// Parse prompt - try as JSON first for structured display
					const promptRaw =
						get(AI_ATTR_MAP.promptMessages) ?? get(AI_ATTR_MAP.prompt)
					let promptMessages: unknown = null
					if (promptRaw) {
						try {
							promptMessages = JSON.parse(promptRaw)
						} catch {
							promptMessages = promptRaw
						}
					}

					// Parse tools
					const toolsRaw = get(AI_ATTR_MAP.tools)
					let toolsAvailable: unknown = null
					if (toolsRaw) {
						try {
							toolsAvailable = JSON.parse(toolsRaw)
						} catch {
							toolsAvailable = toolsRaw
						}
					}

					// Parse provider metadata
					const providerMetaRaw = get(AI_ATTR_MAP.providerMetadata)
					let providerMetadata: unknown = null
					if (providerMetaRaw) {
						try {
							providerMetadata = JSON.parse(providerMetaRaw)
						} catch {
							providerMetadata = providerMetaRaw
						}
					}

					return {
						traceId: row.trace_id,
						spanId: row.span_id,
						operation: parseAiOperation(row.operation_name),
						service: row.service_name,
						functionId: get(AI_ATTR_MAP.functionId),
						provider: get(AI_ATTR_MAP.provider),
						model: get(AI_ATTR_MAP.model),
						status:
							row.status === "error" ? ("error" as const) : ("ok" as const),
						startedAt: new Date(row.start_time_ms).toISOString(),
						durationMs: row.duration_ms,
						sessionId: get(AI_ATTR_MAP.sessionId),
						userId: get(AI_ATTR_MAP.userId),
						finishReason: get(AI_ATTR_MAP.finishReason),
						promptMessages,
						responseText: get(AI_ATTR_MAP.responseText),
						toolCalls,
						toolsAvailable,
						providerMetadata,
						usage: {
							inputTokens: getNum(AI_ATTR_MAP.inputTokens),
							outputTokens: getNum(AI_ATTR_MAP.outputTokens),
							totalTokens: getNum(AI_ATTR_MAP.totalTokens),
							cachedInputTokens: getNum(AI_ATTR_MAP.cachedInputTokens),
							reasoningTokens: getNum(AI_ATTR_MAP.reasoningTokens),
						},
						timing: {
							msToFirstChunk: getNum(AI_ATTR_MAP.msToFirstChunk),
							msToFinish: getNum(AI_ATTR_MAP.msToFinish),
							avgOutputTokensPerSecond: getNum(
								AI_ATTR_MAP.avgOutputTokensPerSecond,
							),
						},
						logs,
					} satisfies AiCallDetail
				})
			})

			const aiCallStats = Effect.fn("motel/TelemetryStore.aiCallStats")(
				function* (input: AiCallStatsSearch) {
					const cutoff =
						(yield* Clock.currentTimeMillis) -
						(input.lookbackMinutes ?? config.otel.traceLookbackMinutes) *
							60 *
							1000
					const limit = input.limit ?? 20

					return yield* Effect.sync(() => {
						const { clauses, params } = buildAiWhereClauses(input, cutoff)

						// For status groupBy, we can do it purely from the spans table
						if (input.groupBy === "status") {
							const rows = db
								.query(
									`
						SELECT s.status AS grp, COUNT(*) AS count, AVG(s.duration_ms) AS avg_dur
						FROM spans AS s
						WHERE ${clauses.join(" AND ")}
						GROUP BY s.status
						ORDER BY count DESC
						LIMIT ?
					`,
								)
								.all(...params, limit) as Array<{
								grp: string
								count: number
								avg_dur: number
							}>

							if (input.agg === "count")
								return rows.map((r) => ({
									group: r.grp,
									value: r.count,
									count: r.count,
								}))
							if (input.agg === "avg_duration")
								return rows.map((r) => ({
									group: r.grp,
									value: r.avg_dur,
									count: r.count,
								}))
						}

						// For attribute-based groupBy, we need to join span_attributes
						const groupByAttrKey =
							input.groupBy === "provider"
								? AI_ATTR_MAP.provider
								: input.groupBy === "model"
									? AI_ATTR_MAP.model
									: input.groupBy === "functionId"
										? AI_ATTR_MAP.functionId
										: input.groupBy === "sessionId"
											? AI_ATTR_MAP.sessionId
											: null

						if (!groupByAttrKey) return []

						// First get the matching spans with their group values
						const rows = db
							.query(
								`
					SELECT
						COALESCE(ga.value, 'unknown') AS grp,
						s.span_id,
						s.duration_ms,
						s.status
					FROM spans AS s
					LEFT JOIN span_attributes AS ga
						ON ga.trace_id = s.trace_id AND ga.span_id = s.span_id AND ga.key = ?
					WHERE ${clauses.join(" AND ")}
				`,
							)
							.all(groupByAttrKey, ...params) as Array<{
							grp: string
							span_id: string
							duration_ms: number
							status: string
						}>

						// Group and aggregate in JS (need p95 and token aggregation)
						const groups = new Map<
							string,
							{ durations: number[]; count: number; spanIds: string[] }
						>()
						for (const row of rows) {
							const bucket = groups.get(row.grp) ?? {
								durations: [],
								count: 0,
								spanIds: [],
							}
							bucket.durations.push(row.duration_ms)
							bucket.count++
							bucket.spanIds.push(row.span_id)
							groups.set(row.grp, bucket)
						}

						// For token aggregations, batch-load from span_attributes
						if (
							input.agg === "total_input_tokens" ||
							input.agg === "total_output_tokens"
						) {
							const tokenKey =
								input.agg === "total_input_tokens"
									? AI_ATTR_MAP.inputTokens
									: AI_ATTR_MAP.outputTokens
							const allSpanIds = [...groups.values()].flatMap((b) => b.spanIds)
							if (allSpanIds.length > 0) {
								const placeholders = allSpanIds.map(() => "?").join(", ")
								const tokenRows = db
									.query(
										`
							SELECT span_id, CAST(value AS REAL) AS tokens
							FROM span_attributes
							WHERE key = ? AND span_id IN (${placeholders})
						`,
									)
									.all(tokenKey, ...allSpanIds) as Array<{
									span_id: string
									tokens: number
								}>

								const tokenBySpan = new Map(
									tokenRows.map((r) => [r.span_id, r.tokens]),
								)

								return [...groups.entries()]
									.map(([group, bucket]) => {
										const total = bucket.spanIds.reduce(
											(sum, sid) => sum + (tokenBySpan.get(sid) ?? 0),
											0,
										)
										return { group, value: total, count: bucket.count }
									})
									.sort((a, b) => b.value - a.value)
									.slice(0, limit)
							}
						}

						return [...groups.entries()]
							.map(([group, bucket]) => {
								const value =
									input.agg === "count"
										? bucket.count
										: input.agg === "avg_duration"
											? bucket.durations.reduce((s, d) => s + d, 0) /
												Math.max(1, bucket.count)
											: input.agg === "p95_duration"
												? percentile(bucket.durations, 0.95)
												: bucket.count
								return { group, value, count: bucket.count }
							})
							.sort((a, b) => b.value - a.value)
							.slice(0, limit)
					})
				},
			)

			return TelemetryStore.of({
				ingestTraces,
				ingestLogs,
				listServices,
				listRecentTraces,
				listTraceSummaries,
				searchTraces,
				searchTraceSummaries,
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
				searchAiCalls,
				getAiCall,
				aiCallStats,
			})
		}),
	)

/**
 * Default writer instance: the main daemon uses this. Owns schema
 * migrations, FTS backfill, and the retention loop.
 */
export const TelemetryStoreLive = makeTelemetryStoreLayer({
	readonly: false,
	runRetention: true,
})

/**
 * Writer instance that SKIPS retention. The ingest worker uses this
 * so the daemon and the worker aren't both running DELETE passes at
 * the same time (they'd just serialise behind the write lock and
 * duplicate work).
 */
export const TelemetryStoreWorkerLive = makeTelemetryStoreLayer({
	readonly: false,
	runRetention: false,
})

/**
 * Read-only instance for query-only processes (currently the TUI).
 * Skips every DDL/DML statement at startup so the connection can be
 * opened while a writer is mid-transaction without racing for the
 * write lock. Writes through the service interface will throw.
 */
export const TelemetryStoreReadonlyLive = makeTelemetryStoreLayer({
	readonly: true,
	runRetention: false,
})
