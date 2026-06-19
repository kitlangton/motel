import { Database } from "bun:sqlite"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { dirname } from "node:path"
import { Cause, Clock, Effect, FileSystem, Layer, Schedule, Context } from "effect"
import { config } from "../config.js"
import type { AiCallDetail, AiCallSummary, FacetItem, LogItem, SpanItem, StatsItem, TraceItem, TraceSummaryItem, TraceSpanEvent, TraceSpanItem } from "../domain.js"
import { AI_ATTR_MAP, AI_FTS_KEYS, AI_TEXT_SEARCH_KEYS, truncatePreview } from "../domain.js"
import { attributeMap, nanosToMilliseconds, normalizeOtlpBinaryId, parseAnyValue, spanKindLabel, spanStatusLabel, stringifyValue, type OtlpLogExportRequest, type OtlpTraceExportRequest } from "../otlp.js"

const isSqliteLockError = (error: unknown) =>
	error instanceof Error && /(database is locked|database table is locked|SQLITE_BUSY)/i.test(error.message)

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
	readonly agg: "count" | "avg_duration" | "p95_duration" | "total_input_tokens" | "total_output_tokens"
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

const isSpanRunning = (startTimeMs: number, endTimeMs: number) => endTimeMs <= 0 || endTimeMs < startTimeMs

const liveDurationMs = (startTimeMs: number, endTimeMs: number, isRunning: boolean) =>
	Math.max(0, (isRunning ? Date.now() : endTimeMs) - startTimeMs)

const parseSummaryRow = (row: TraceSummaryRow): TraceSummaryItem => ({
	isRunning: row.active_span_count > 0,
	traceId: row.trace_id,
	serviceName: row.service_name ?? "unknown",
	rootOperationName: row.root_operation_name ?? "unknown",
	startedAt: new Date(row.started_at_ms),
	durationMs: row.active_span_count > 0 ? liveDurationMs(row.started_at_ms, row.ended_at_ms ?? 0, true) : Math.max(0, row.duration_ms),
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

// Memoize small repeated JSON records. Resource attributes are the primary
// beneficiary because many spans share the same serialized value; compact
// repeated span attributes also benefit while large unique payloads bypass
// the cache to keep memory bounded for long-running daemons.
const RECORD_PARSE_CACHE_MAX_VALUE_LEN = 1024
const RECORD_PARSE_CACHE_LIMIT = 256
const recordParseCache = new Map<string, Record<string, string>>()
const EMPTY_RECORD: Record<string, string> = {}

const parseRecord = (value: string): Record<string, string> => {
	if (value === "" || value === "{}") return EMPTY_RECORD
	const cacheable = value.length <= RECORD_PARSE_CACHE_MAX_VALUE_LEN
	if (cacheable) {
		const cached = recordParseCache.get(value)
		if (cached !== undefined) return cached
	}
	let parsed: Record<string, string>
	try {
		const json = JSON.parse(value) as Record<string, unknown>
		parsed = Object.fromEntries(Object.entries(json).map(([key, entry]) => [key, stringifyValue(entry)]))
	} catch {
		parsed = EMPTY_RECORD
	}
	if (cacheable && recordParseCache.size < RECORD_PARSE_CACHE_LIMIT) {
		recordParseCache.set(value, parsed)
	}
	return parsed
}

const EMPTY_EVENTS: readonly TraceSpanEvent[] = []

const parseEvents = (value: string): readonly TraceSpanEvent[] => {
	if (value === "" || value === "[]") return EMPTY_EVENTS
	try {
		const parsed = JSON.parse(value) as Array<{ name: string; timestamp: number; attributes: Record<string, string> }>
		if (parsed.length === 0) return EMPTY_EVENTS
		return parsed.map((event) => ({
			name: event.name,
			timestamp: new Date(event.timestamp),
			attributes: event.attributes,
		}))
	} catch {
		return EMPTY_EVENTS
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
		const key = span.parentSpanId && spanIds.has(span.parentSpanId) ? span.parentSpanId : null
		const siblings = childrenByParent.get(key) ?? []
		siblings.push(span)
		childrenByParent.set(key, siblings)
	}

	for (const siblings of childrenByParent.values()) {
		siblings.sort((left, right) =>
			left.startTime.getTime() - right.startTime.getTime() || Number(Boolean(left.syntheticMissingParent)) - Number(Boolean(right.syntheticMissingParent))
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

const buildTrace = (traceId: string, spanRows: readonly SpanRow[]): TraceItem => {
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

	const syntheticParents: InternalTraceSpanItem[] = [...missingParentGroups.entries()].map(([missingParentId, children]) => {
		const firstChild = children[0]!
		const startedAtMs = Math.min(...children.map((child) => child.startTime.getTime()))
		const endedAtMs = Math.max(...children.map((child) => child.startTime.getTime() + child.durationMs))
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
			warnings: [`missing span ${missingParentId} (${children.length} child${children.length === 1 ? "" : "ren"})`],
			events: [],
			syntheticMissingParent: true,
		}
	})

	const orderedSpans = orderTraceSpans([...parsedSpans, ...syntheticParents])
	const startedAtMs = Math.min(...orderedSpans.map((span) => span.startTime.getTime()))
	const endedAtMs = Math.max(...orderedSpans.map((span) => span.startTime.getTime() + span.durationMs))
	const isRunning = orderedSpans.some((span) => span.isRunning)
	const rootSpan = orderedSpans.find((span) => !span.syntheticMissingParent && span.parentSpanId === null)
		?? orderedSpans.find((span) => !span.syntheticMissingParent)
		?? orderedSpans[0]
		?? null
	const warnings = syntheticParents.map((span) => span.warnings[0]!).filter((warning) => warning.length > 0)

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

const matchesAttributeContains = (attributes: Readonly<Record<string, string>>, filters: Readonly<Record<string, string>> | undefined) =>
	!filters || Object.entries(filters).every(([key, needle]) => {
		const value = attributes[key]
		return value !== undefined && value.toLowerCase().includes(needle.toLowerCase())
	})

const percentile = (values: readonly number[], ratio: number) => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
	return sorted[index] ?? 0
}

const tokenizeFts = (value: string) => value.match(/[A-Za-z0-9_]+/g)?.filter((token) => token.length > 1) ?? []

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
	const disjunction = entries.map(() => "(key = ? AND value LIKE ? COLLATE NOCASE)").join(" OR ")
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

// Read-only surface of the telemetry store. Pulled out so a readonly
// SQLite connection (TUI / HTTP query handlers) can be expressed as a
// distinct service identifier from the writer, without re-declaring
// every query in a wrapper layer. The writer's value still satisfies
// this shape — TelemetryStoreLive can provide both identifiers from
// one underlying object if needed.
export interface TelemetryStoreReader {
	readonly listServices: Effect.Effect<readonly string[], Error>
	readonly listRecentTraces: (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number; readonly cursorStartedAtMs?: number; readonly cursorTraceId?: string }) => Effect.Effect<readonly TraceItem[], Error>
	readonly listTraceSummaries: (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number; readonly cursorStartedAtMs?: number; readonly cursorTraceId?: string }) => Effect.Effect<readonly TraceSummaryItem[], Error>
	readonly searchTraces: (input: TraceSearch) => Effect.Effect<readonly TraceItem[], Error>
	readonly searchTraceSummaries: (input: TraceSearch) => Effect.Effect<readonly TraceSummaryItem[], Error>
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
	readonly searchAiCalls: (input: AiCallSearch) => Effect.Effect<readonly AiCallSummary[], Error>
	readonly getAiCall: (spanId: string) => Effect.Effect<AiCallDetail | null, Error>
	readonly aiCallStats: (input: AiCallStatsSearch) => Effect.Effect<readonly StatsItem[], Error>
}

export class TelemetryStoreReadonly extends Context.Service<TelemetryStoreReadonly, TelemetryStoreReader>()("motel/TelemetryStoreReadonly") {}

export class TelemetryStore extends Context.Service<
	TelemetryStore,
	TelemetryStoreReader & {
		readonly ingestTraces: (payload: OtlpTraceExportRequest) => Effect.Effect<{ readonly insertedSpans: number }, Error>
		readonly ingestLogs: (payload: OtlpLogExportRequest) => Effect.Effect<{ readonly insertedLogs: number }, Error>
		readonly runRetentionNow: Effect.Effect<void, Error>
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
 *   time. The ingest worker owns it; the HTTP thread and TUI skip it.
 */
export interface TelemetryStoreOptions {
	readonly readonly: boolean
	readonly runRetention: boolean
}

const makeTelemetryStoreEffect = (opts: TelemetryStoreOptions) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem.FileSystem
		yield* fileSystem.makeDirectory(dirname(config.otel.databasePath), { recursive: true })
		const db = yield* Effect.acquireRelease(
			Effect.sync(() => new Database(config.otel.databasePath, {
				create: !opts.readonly,
				readonly: opts.readonly,
			})),
			(db) => Effect.sync(() => {
				if (!opts.readonly) {
					// `PRAGMA optimize` at close persists any stats SQLite gathered
					// during the session, so the next process start gets an accurate
					// query planner on the first query instead of a 3-second cold
					// run. Cheap: it skips work unless stats have drifted.
					try { db.exec(`PRAGMA optimize;`) } catch { /* nothing */ }
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
			// auto_vacuum is a header-level setting: it only takes effect on
			// an empty DB, or on the next VACUUM after a change. Setting it
			// here, BEFORE the first CREATE TABLE, is the only path that
			// makes incremental_vacuum work without a full VACUUM. For
			// existing DBs that predate this setting keep their current mode;
			// Motel never performs a surprise full-file VACUUM at startup.
			try { db.exec(`PRAGMA auto_vacuum = INCREMENTAL;`) } catch { /* ignore */ }
			try {
				db.exec(`
					PRAGMA journal_mode = WAL;
					PRAGMA synchronous = NORMAL;
					PRAGMA temp_store = MEMORY;
					-- WAL checkpoint automatically when it grows past ~16MB. Without
					-- this the WAL happily runs into the hundreds of MB and queries
					-- start paying the cost of walking the WAL on every read.
					PRAGMA wal_autocheckpoint = 4000;
					-- Hard floor for the WAL file. Auto-checkpoint controls *when*
					-- pages move out of the WAL; size_limit controls how much the
					-- WAL file is allowed to grow on disk. 128MB is generous enough
					-- to absorb a long write burst without blocking on truncation,
					-- tight enough that a wedged retention loop can't hide a 20GB
					-- WAL the way a default no-limit configuration can.
					PRAGMA journal_size_limit = 134217728;

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

					CREATE TABLE IF NOT EXISTS motel_maintenance (
						key TEXT PRIMARY KEY,
						value TEXT NOT NULL
					);
				`)
			} catch (err) {
				if (!isSqliteLockError(err)) throw err
				console.warn(`motel: writer bootstrap skipped during startup: ${(err as Error).message}`)
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
				const row = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='span_operation_fts'`).get()
				hasFts = row !== null
			} catch { hasFts = false }
			try {
				const row = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='span_attr_fts'`).get()
				const backfill = db.query(`SELECT value FROM motel_maintenance WHERE key = 'span_attr_fts_v1'`).get() as { value: string } | null
				hasAttrFts = row !== null && backfill?.value === "complete"
			} catch { hasAttrFts = false }
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
				const keyList = AI_FTS_KEYS.map((k) => `'${k.replace(/'/g, "''")}'`).join(", ")
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
			db.exec(`ALTER TABLE trace_summaries ADD COLUMN active_span_count INTEGER NOT NULL DEFAULT 0`)
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
		} catch {
			// ANALYZE / optimize failures are never fatal — queries still work,
			// they just run with default row estimates.
		}
			// Longer busy timeout: the ingest worker holds the write lock for up
			// to a few seconds during big OTLP batches, and the daemon's retention
			// passes can do the same. Apply this AFTER startup maintenance so
			// lock-conflicted bootstrap steps fail fast instead of stalling health
			// for the full 15s timeout.
			try { db.exec(`PRAGMA busy_timeout = 15000;`) } catch { /* ignore */ }
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

		const reconcileTraceSummaries = Effect.sync(() => {
			const marker = db.query(`SELECT value FROM motel_maintenance WHERE key = 'trace_summary_cursor'`).get() as { value: string } | null
			const cursor = Number(marker?.value ?? 0)
			const rows = db.query(`SELECT rowid, trace_id FROM spans WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`).all(cursor, config.otel.retentionTraceBatch) as Array<{ rowid: number; trace_id: string }>
			if (rows.length === 0) {
				db.query(`INSERT OR REPLACE INTO motel_maintenance(key, value) VALUES ('trace_summary_cursor', '0')`).run()
				return
			}
			const transaction = db.transaction(() => {
				for (const traceId of new Set(rows.map((row) => row.trace_id))) upsertTraceSummary.run(traceId)
				db.query(`INSERT OR REPLACE INTO motel_maintenance(key, value) VALUES ('trace_summary_cursor', ?)`).run(String(rows.at(-1)!.rowid))
			})
			transaction()
		})

		const deleteSpanAttributes = db.query(`DELETE FROM span_attributes WHERE trace_id = ? AND span_id = ?`)
		const insertSpanAttribute = db.query(`INSERT INTO span_attributes (trace_id, span_id, key, value) VALUES (?, ?, ?, ?)`)
		const spanAttributeInsertManyByCount = new Map<number, ReturnType<Database["query"]>>()
		const insertSpanAttributesMany = (traceId: string, spanId: string, attributes: Readonly<Record<string, string>>) => {
			const entries = Object.entries(attributes)
			if (entries.length === 0) return
			if (entries.length === 1) {
				const [key, value] = entries[0]!
				insertSpanAttribute.run(traceId, spanId, key, value)
				return
			}
			let query = spanAttributeInsertManyByCount.get(entries.length)
			if (!query) {
				query = db.query(`INSERT INTO span_attributes (trace_id, span_id, key, value) VALUES ${entries.map(() => "(?, ?, ?, ?)").join(", ")}`)
				spanAttributeInsertManyByCount.set(entries.length, query)
			}
			query.run(...entries.flatMap(([key, value]) => [traceId, spanId, key, value]))
		}
		const deleteSpanOperationSearch = db.query(`DELETE FROM span_operation_fts WHERE trace_id = ? AND span_id = ?`)
		const insertSpanOperationSearch = db.query(`INSERT INTO span_operation_fts (trace_id, span_id, operation_name) VALUES (?, ?, ?)`)
		const deleteSpanOperationSearchManyByCount = new Map<number, ReturnType<Database["query"]>>()
		const insertSpanOperationSearchManyByCount = new Map<number, ReturnType<Database["query"]>>()
		const updateSpanOperationSearchMany = (operations: ReadonlyArray<readonly [string, string, string]>) => {
			if (operations.length === 0) return
			if (operations.length === 1) {
				const [traceId, spanId, operationName] = operations[0]!
				deleteSpanOperationSearch.run(traceId, spanId)
				insertSpanOperationSearch.run(traceId, spanId, operationName)
				return
			}

			let deleteQuery = deleteSpanOperationSearchManyByCount.get(operations.length)
			if (!deleteQuery) {
				deleteQuery = db.query(`DELETE FROM span_operation_fts WHERE ${operations.map(() => "(trace_id = ? AND span_id = ?)").join(" OR ")}`)
				deleteSpanOperationSearchManyByCount.set(operations.length, deleteQuery)
			}
			deleteQuery.run(...operations.flatMap(([traceId, spanId]) => [traceId, spanId]))

			let insertQuery = insertSpanOperationSearchManyByCount.get(operations.length)
			if (!insertQuery) {
				insertQuery = db.query(`INSERT INTO span_operation_fts (trace_id, span_id, operation_name) VALUES ${operations.map(() => "(?, ?, ?)").join(", ")}`)
				insertSpanOperationSearchManyByCount.set(operations.length, insertQuery)
			}
			insertQuery.run(...operations.flatMap(([traceId, spanId, operationName]) => [traceId, spanId, operationName]))
		}
		const insertLogAttribute = db.query(`INSERT INTO log_attributes (log_id, key, value) VALUES (?, ?, ?)`)
		const logAttributeInsertManyByCount = new Map<number, ReturnType<Database["query"]>>()
		const insertLogAttributesMany = (logId: number, attributes: Readonly<Record<string, string>>) => {
			const entries = Object.entries(attributes)
			if (entries.length === 0) return
			if (entries.length === 1) {
				const [key, value] = entries[0]!
				insertLogAttribute.run(logId, key, value)
				return
			}
			let query = logAttributeInsertManyByCount.get(entries.length)
			if (!query) {
				query = db.query(`INSERT INTO log_attributes (log_id, key, value) VALUES ${entries.map(() => "(?, ?, ?)").join(", ")}`)
				logAttributeInsertManyByCount.set(entries.length, query)
			}
			query.run(...entries.flatMap(([key, value]) => [logId, key, value]))
		}
		const insertLogBodySearch = db.query(`INSERT INTO log_body_fts (log_id, body) VALUES (?, ?)`)
		const insertLogBodySearchManyByCount = new Map<number, ReturnType<Database["query"]>>()
		const insertLogBodySearchMany = (entries: ReadonlyArray<readonly [string, string]>) => {
			if (entries.length === 0) return
			if (entries.length === 1) {
				const [logId, body] = entries[0]!
				insertLogBodySearch.run(logId, body)
				return
			}
			let query = insertLogBodySearchManyByCount.get(entries.length)
			if (!query) {
				query = db.query(`INSERT INTO log_body_fts (log_id, body) VALUES ${entries.map(() => "(?, ?)").join(", ")}`)
				insertLogBodySearchManyByCount.set(entries.length, query)
			}
			query.run(...entries.flatMap(([logId, body]) => [logId, body]))
		}

		const maxDbSizeBytes = config.otel.maxDbSizeMb * 1024 * 1024

		// Freelist-ratio thresholds for the adaptive reclaim loop. Below the
		// LOW threshold there's nothing worth doing; above HIGH we are in the
		// 17GB-DB-with-10GB-freelist failure mode and need to reclaim aggressively
		// even if it costs writer-lock time.
		const FREELIST_LOW_RATIO = 0.05
		const FREELIST_MID_RATIO = 0.20
		const FREELIST_HIGH_RATIO = 0.50
		const VACUUM_PAGES_NORMAL = 2000     // ~8MB/pass
		const VACUUM_PAGES_BUSY = 20000      // ~80MB/pass — used when freelist > 20%
		const VACUUM_PAGES_PANIC = 50000     // ~200MB/pass — only when ratio > 50%

		const ftsTableNames = ["span_attr_fts", "log_body_fts", "span_operation_fts"] as const

		const incrementalFtsMerge = (pages: number) => {
			// FTS5 segment merges drop tombstone rows that DELETE leaves behind.
			// Without periodic merges, deleted FTS rows stay on disk indefinitely
			// — a major source of freelist pages on a heavy-deletion workload.
			// `merge=N` is a bounded, online operation: it merges at most N
			// pages of work and returns. Per FTS5 docs, missing tables silently
			// throw; we swallow because not every DB has every FTS table.
			for (const name of ftsTableNames) {
				try { db.query(`INSERT INTO ${name}(${name}) VALUES (?)`).run(`merge=${pages}`) } catch { /* table absent or older schema */ }
			}
		}

		const reclaimSpace = Effect.fn("motel/TelemetryStore.reclaimSpace")(function* () {
			yield* Effect.sync(() => {
				const pageCount = (db.query(`PRAGMA page_count`).get() as { page_count: number }).page_count
				const freePages = (db.query(`PRAGMA freelist_count`).get() as { freelist_count: number }).freelist_count
				if (pageCount === 0) return
				const ratio = freePages / pageCount
				if (ratio < FREELIST_LOW_RATIO) return

				// Adaptive vacuum sizing — fixed 2000 pages/min could not keep
				// up with sustained deletions, leaking 10GB of freelist over
				// time. Scale the per-pass work to the size of the backlog so
				// we stay roughly proportional to the deficit.
				const pages =
					ratio >= FREELIST_HIGH_RATIO ? VACUUM_PAGES_PANIC :
					ratio >= FREELIST_MID_RATIO ? VACUUM_PAGES_BUSY :
					VACUUM_PAGES_NORMAL

				try { db.exec(`PRAGMA incremental_vacuum(${pages});`) } catch { /* ignore */ }

				// In WAL mode incremental_vacuum only moves pages — the file
				// shrinks on the next checkpoint. PASSIVE silently skips when
				// readers are active (the failure mode the agent's research
				// flagged: checkpoint starvation). Use RESTART normally and
				// TRUNCATE in panic mode to physically shrink the WAL when it
				// has grown.
				const mode = ratio >= FREELIST_HIGH_RATIO ? "TRUNCATE" : "RESTART"
				try { db.exec(`PRAGMA wal_checkpoint(${mode});`) } catch { /* ignore */ }
			})
		})

		const cleanupExpired = Effect.fn("motel/TelemetryStore.cleanupExpired")(function* () {
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
				const timeExpired = db.query(
					`SELECT trace_id FROM trace_summaries WHERE active_span_count = 0 AND ended_at_ms > 0 AND ended_at_ms < ? ORDER BY ended_at_ms ASC LIMIT ?`,
				).all(cutoff, config.otel.retentionTraceBatch) as readonly { trace_id: string }[]
				for (const row of timeExpired) toEvict.add(row.trace_id)

				// Size-based: if actual data exceeds the target, drop one bounded
				// batch of the oldest completed traces. `(page_count - freelist_count)`
				// ignores freed-but-not-vacuumed pages so a large freelist doesn't
				// trigger a deletion death spiral.
				const pageCount = (db.query(`PRAGMA page_count`).get() as { page_count: number }).page_count
				const freePages = (db.query(`PRAGMA freelist_count`).get() as { freelist_count: number }).freelist_count
				const pageSize = (db.query(`PRAGMA page_size`).get() as { page_size: number }).page_size
				const dbSize = (pageCount - freePages) * pageSize
				if (dbSize > maxDbSizeBytes) {
					const oldest = db.query(
						`SELECT trace_id FROM trace_summaries WHERE active_span_count = 0 ORDER BY started_at_ms ASC LIMIT ?`,
					).all(config.otel.retentionTraceBatch) as readonly { trace_id: string }[]
					// Set.add dedupes overlap with the time-expired batch above.
					for (const row of oldest) toEvict.add(row.trace_id)
				}

				// Logs have their own retention boundary. A correlated log may refer
				// to a trace that was sampled elsewhere or never reached Motel, so
				// tying log eviction to trace_summaries lets those rows grow forever.
				const expiredLogs = db.query(`DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE timestamp_ms < ? ORDER BY timestamp_ms ASC LIMIT ?)`).run(cutoff, config.otel.retentionLogBatch)
				let deletedLogs = Number(expiredLogs.changes) > 0
				if (dbSize > maxDbSizeBytes) {
					const oversizedLogs = db.query(`DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY timestamp_ms ASC LIMIT ?)`).run(config.otel.retentionLogBatch)
					deletedLogs = deletedLogs || Number(oversizedLogs.changes) > 0
				}

				// Batch the trace-id list so the IN placeholders stay under
				// SQLite's default limit (~999). Each batch wipes every row
				// reachable from those trace_ids across the cascade tables.
				const traceIds = Array.from(toEvict)
				const BATCH_SIZE = 500
				for (let offset = 0; offset < traceIds.length; offset += BATCH_SIZE) {
					const batch = traceIds.slice(offset, offset + BATCH_SIZE)
					const placeholders = batch.map(() => "?").join(",")
					db.query(`DELETE FROM span_attributes WHERE trace_id IN (${placeholders})`).run(...batch)
					try {
						db.query(`DELETE FROM span_operation_fts WHERE trace_id IN (${placeholders})`).run(...batch)
					} catch {
						// FTS table may not exist on old DBs.
					}
					db.query(`DELETE FROM spans WHERE trace_id IN (${placeholders})`).run(...batch)
					db.query(`DELETE FROM logs WHERE trace_id IN (${placeholders})`).run(...batch)
					db.query(`DELETE FROM trace_summaries WHERE trace_id IN (${placeholders})`).run(...batch)
				}

				// Log-side orphans (log_attributes + FTS) are keyed by log.id,
				// so prune what no longer has a parent log row.
				const orphanAttributes = db.query(`DELETE FROM log_attributes WHERE rowid IN (SELECT log_attributes.rowid FROM log_attributes WHERE NOT EXISTS (SELECT 1 FROM logs WHERE logs.id = log_attributes.log_id) LIMIT ?)`).run(config.otel.retentionLogBatch)
				let deletedOrphans = Number(orphanAttributes.changes) > 0
				try {
					const orphanFts = db.query(`DELETE FROM log_body_fts WHERE rowid IN (SELECT rowid FROM log_body_fts WHERE NOT EXISTS (SELECT 1 FROM logs WHERE logs.id = CAST(log_body_fts.log_id AS INTEGER)) LIMIT ?)`).run(config.otel.retentionLogBatch)
					deletedOrphans = deletedOrphans || Number(orphanFts.changes) > 0
				} catch {
					// FTS table may not exist on old DBs.
				}

				// Checkpoint after a big delete pass so the freed pages land
				// in the main DB file and become eligible for incremental
				// vacuum. Use RESTART (not PASSIVE): PASSIVE silently no-ops
				// when readers are active, which is the documented mechanism
				// behind WAL/freelist starvation when ingest is busy.
				if (toEvict.size === 0 && !deletedLogs && !deletedOrphans) return
				try { db.exec(`PRAGMA wal_checkpoint(RESTART);`) } catch { /* ignore */ }

				// Incremental FTS5 merge — DELETE on an FTS5-indexed row
				// leaves a tombstone in the segment tree that only `merge`
				// reclaims. Skipping this is the second compounding cause
				// (after fixed-size vacuum) of the slow freelist accretion
				// that took the DB to 17GB. 100 pages of merge work per
				// retention tick is bounded and runs in milliseconds.
				incrementalFtsMerge(100)

				// Actual page reclamation lives in `reclaimSpace`, which
				// runs on its own faster cadence so the file shrinks even
				// when no traces are evicted in a given retention tick (e.g.
				// after a large historical eviction has already happened).
			})
		})

		// Retention only runs in the ingest worker so maintenance never blocks
		// the HTTP event loop and no second writer duplicates cleanup work.
		if (opts.runRetention) {
			// Cleanup runs on the telemetry worker, never the HTTP event loop.
			yield* Effect.forkScoped(Effect.repeat(
				Effect.andThen(reconcileTraceSummaries, cleanupExpired()).pipe(Effect.catchCause((cause) => Effect.logWarning(`motel: maintenance pass failed: ${Cause.pretty(cause)}`))),
				Schedule.spaced(`${config.otel.retentionIntervalSeconds} seconds`),
			))

			// Page reclamation runs on a separate, faster cadence (10s) and
			// is independent of the eviction loop. The reason: a single sweep
			// at 60s intervals can move only ~8MB of pages before the next
			// burst of inserts grows the freelist again. Decoupling lets us
			// catch up adaptively (see VACUUM_PAGES_BUSY/PANIC) without
			// changing the cost of the heavier delete sweep.
			yield* Effect.forkScoped(Effect.repeat(reclaimSpace(), Schedule.spaced("10 seconds")))

			// Periodically refresh query planner stats. `PRAGMA optimize` is a
			// no-op when nothing has changed, so this is essentially free on idle
			// servers and keeps facet/search planner estimates accurate as data
			// grows. 15 minutes is slower than ingestion rates we care about but
			// frequent enough that the attribute picker stays snappy.
			const refreshPlannerStats = Effect.sync(() => {
				try { db.exec(`PRAGMA optimize;`) } catch { /* ignore */ }
			})
			yield* Effect.forkScoped(Effect.repeat(refreshPlannerStats, Schedule.spaced("15 minutes")))
		}

		// Incrementally rebuild historical AI attributes in bounded batches.
		// Queries fall back to LIKE until the persistent marker is complete.
		if (hasAttrFts && !opts.readonly) {
			const backfillAttrFtsBatch = Effect.sync(() => {
				try {
					const keyList = AI_FTS_KEYS.map((k) => `'${k.replace(/'/g, "''")}'`).join(", ")
					const marker = db.query(`SELECT value FROM motel_maintenance WHERE key = 'span_attr_fts_v1'`).get() as { value: string } | null
					if (marker?.value === "complete") return false
					let cursor = 0
					let maxRowId = 0
					if (marker) {
						[cursor, maxRowId] = marker.value.split(":").map(Number)
					} else {
						maxRowId = (db.query(`SELECT COALESCE(MAX(rowid), 0) AS value FROM span_attributes`).get() as { value: number }).value
						db.query(`INSERT INTO span_attr_fts(span_attr_fts) VALUES ('delete-all')`).run()
						db.query(`INSERT OR REPLACE INTO motel_maintenance(key, value) VALUES ('span_attr_fts_v1', ?)`).run(`0:${maxRowId}`)
					}
					const rows = db.query(`SELECT rowid, value FROM span_attributes WHERE key IN (${keyList}) AND rowid > ? AND rowid <= ? ORDER BY rowid ASC LIMIT 500`).all(cursor, maxRowId) as Array<{ rowid: number; value: string }>
					if (rows.length === 0) {
						db.query(`UPDATE motel_maintenance SET value = 'complete' WHERE key = 'span_attr_fts_v1'`).run()
						hasAttrFts = true
						return false
					}
					const insert = db.query(`INSERT INTO span_attr_fts(rowid, value) VALUES (?, ?)`)
					const transaction = db.transaction(() => {
						for (const row of rows) insert.run(row.rowid, row.value)
						db.query(`UPDATE motel_maintenance SET value = ? WHERE key = 'span_attr_fts_v1'`).run(`${rows.at(-1)!.rowid}:${maxRowId}`)
					})
					transaction()
					return true
				} catch {
					// Backfill failure is never fatal — new ingests still
					// populate FTS via the trigger, and queries fall back to
					// LIKE when FTS lookups return empty.
					return true
				}
			})
			const backfillAttrFts: Effect.Effect<void> = Effect.suspend(() =>
				Effect.flatMap(backfillAttrFtsBatch, (pending) =>
					pending ? Effect.andThen(Effect.sleep("100 millis"), backfillAttrFts) : Effect.void,
				),
			)
			yield* Effect.forkScoped(backfillAttrFts)
		}

		const ingestTraces = Effect.fn("motel/TelemetryStore.ingestTraces")(function* (payload: OtlpTraceExportRequest) {
			return yield* Effect.sync(() => {
				let insertedSpans = 0
				const transaction = db.transaction((request: OtlpTraceExportRequest) => {
					const touchedTraceIds = new Set<string>()
					const touchedOperations: Array<readonly [string, string, string]> = []
					for (const resourceSpans of request.resourceSpans ?? []) {
						const resourceAttributes = attributeMap(resourceSpans.resource?.attributes)
						const serviceName = resourceAttributes["service.name"] || resourceAttributes["service_name"] || "unknown"

						for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
							const scopeName = scopeSpans.scope?.name ?? null

							for (const span of scopeSpans.spans ?? []) {
								// Accept both hex (OTLP/JSON spec) and base64 (proto3 JSON default
								// used by naive exporters like Python's google.protobuf.json_format).
								const traceId = normalizeOtlpBinaryId(span.traceId, 16)
								const spanId = normalizeOtlpBinaryId(span.spanId, 8)
								if (!traceId || !spanId) continue
								const parentSpanId = normalizeOtlpBinaryId(span.parentSpanId, 8)
								const spanAttributes = attributeMap(span.attributes)
								const mergedAttributes = { ...resourceAttributes, ...spanAttributes }
								const startTimeMs = nanosToMilliseconds(span.startTimeUnixNano)
								const endTimeMs = nanosToMilliseconds(span.endTimeUnixNano)
								const events = (span.events ?? []).map((event) => ({
									name: event.name ?? "event",
									timestamp: nanosToMilliseconds(event.timeUnixNano),
									attributes: attributeMap(event.attributes),
								}))

								insertSpan.run(
									traceId,
									spanId,
									parentSpanId,
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
								deleteSpanAttributes.run(traceId, spanId)
								insertSpanAttributesMany(traceId, spanId, mergedAttributes)
								touchedOperations.push([traceId, spanId, span.name ?? "unknown"])
								touchedTraceIds.add(traceId)
								insertedSpans += 1
							}
						}
					}
					try {
						const BATCH_SIZE = 500
						for (let offset = 0; offset < touchedOperations.length; offset += BATCH_SIZE) {
							updateSpanOperationSearchMany(touchedOperations.slice(offset, offset + BATCH_SIZE))
						}
					} catch {
						// FTS is optional.
					}
					for (const traceId of touchedTraceIds) {
						upsertTraceSummary.run(traceId)
					}
				})

				transaction(payload)
				return { insertedSpans }
			})
		})

		const ingestLogs = Effect.fn("motel/TelemetryStore.ingestLogs")(function* (payload: OtlpLogExportRequest) {
			return yield* Effect.sync(() => {
				let insertedLogs = 0
				const transaction = db.transaction((request: OtlpLogExportRequest) => {
					const touchedLogBodies: Array<readonly [string, string]> = []
					for (const resourceLogs of request.resourceLogs ?? []) {
						const resourceAttributes = attributeMap(resourceLogs.resource?.attributes)
						const serviceName = resourceAttributes["service.name"] || resourceAttributes["service_name"] || "unknown"

						for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
							const scopeName = scopeLogs.scope?.name ?? null

							for (const record of scopeLogs.logRecords ?? []) {
								const attributes = attributeMap(record.attributes)
								const mergedAttributes = { ...resourceAttributes, ...attributes }
								const timestampMs = nanosToMilliseconds(record.timeUnixNano ?? record.observedTimeUnixNano)
								const body = stringifyValue(parseAnyValue(record.body))
								const rawTraceId = attributes.traceId || attributes.trace_id || record.traceId || null
								const rawSpanId = attributes.spanId || attributes.span_id || record.spanId || null
								const result = insertLog.run(
									normalizeOtlpBinaryId(rawTraceId, 16),
									normalizeOtlpBinaryId(rawSpanId, 8),
									serviceName,
									scopeName,
									record.severityText ?? "INFO",
									timestampMs,
									body,
									JSON.stringify(attributes),
									JSON.stringify(resourceAttributes),
								)
								const logId = Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid)
								insertLogAttributesMany(logId, mergedAttributes)
								touchedLogBodies.push([String(logId), body])
								insertedLogs += 1
							}
						}
					}
					try {
						const BATCH_SIZE = 500
						for (let offset = 0; offset < touchedLogBodies.length; offset += BATCH_SIZE) {
							insertLogBodySearchMany(touchedLogBodies.slice(offset, offset + BATCH_SIZE))
						}
					} catch {
						// FTS is optional.
					}
				})

				transaction(payload)
				return { insertedLogs }
			})
		})

		const listServices = Effect.fn("motel/TelemetryStore.listServices")(function* () {
			const cutoff = (yield* Clock.currentTimeMillis) - config.otel.traceLookbackMinutes * 60 * 1000
			const services = yield* Effect.sync(() => {
				// Discover recent activity from span rows, not trace starts: a
				// long-running trace can emit a current child after its root ages
				// outside the lookback window.
				const rows = db.query(`
					SELECT service_name FROM spans WHERE start_time_ms >= ?
					UNION
					SELECT service_name FROM logs WHERE timestamp_ms >= ?
					ORDER BY service_name ASC
				`).all(cutoff, cutoff) as Array<{ service_name: string }>
				return rows.map((row) => row.service_name)
			})
			yield* Effect.annotateCurrentSpan("trace.service_count", services.length)
			return services
		})()

		const loadTracesByIds = (traceIds: readonly string[]) => {
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
		}

		const listRecentTraces = Effect.fn("motel/TelemetryStore.listRecentTraces")(function* (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) {
			yield* Effect.annotateCurrentSpan("trace.service_name", serviceName ?? "all")
			const summaries = yield* listTraceSummaries(serviceName, options)
			const traces = yield* Effect.sync(() => loadTracesByIds(summaries.map((summary) => summary.traceId)))
			yield* Effect.annotateCurrentSpan("trace.result_count", traces.length)
			return traces
		})

		const listTraceSummaries = Effect.fn("motel/TelemetryStore.listTraceSummaries")(function* (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number; readonly cursorStartedAtMs?: number; readonly cursorTraceId?: string }) {
			yield* Effect.annotateCurrentSpan("trace.service_name", serviceName ?? "all")
			const cutoff = (yield* Clock.currentTimeMillis) - (options?.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = options?.limit ?? config.otel.traceFetchLimit

			const summaries = yield* Effect.sync(() => {
				const clauses = ["started_at_ms >= ?"]
				const params: Array<string | number> = [cutoff]

				if (serviceName) {
					clauses.push("service_name = ?")
					params.push(serviceName)
				}

				if (options?.cursorStartedAtMs != null && options.cursorTraceId) {
					clauses.push("(started_at_ms < ? OR (started_at_ms = ? AND trace_id < ?))")
					params.push(options.cursorStartedAtMs, options.cursorStartedAtMs, options.cursorTraceId)
				}

				return db.query(`
					SELECT trace_id, service_name, root_operation_name, started_at_ms, ended_at_ms, active_span_count, duration_ms, span_count, error_count
					FROM trace_summaries
					WHERE ${clauses.join(" AND ")}
					ORDER BY started_at_ms DESC, trace_id DESC
					LIMIT ?
				`).all(...params, limit) as TraceSummaryRow[]
			}).pipe(Effect.map((rows) => rows.map(parseSummaryRow)))
			yield* Effect.annotateCurrentSpan("trace.result_count", summaries.length)
			return summaries
		})

		const searchTraceSummaries = Effect.fn("motel/TelemetryStore.searchTraceSummaries")(function* (input: TraceSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
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
					clauses.push("(started_at_ms < ? OR (started_at_ms = ? AND trace_id < ?))")
					params.push(input.cursorStartedAtMs, input.cursorStartedAtMs, input.cursorTraceId)
				}

				if (input.operation) {
					const ftsQuery = toFtsMatchQuery(input.operation)
					if (hasFts && ftsQuery) {
						clauses.push("trace_id IN (SELECT DISTINCT trace_id FROM span_operation_fts WHERE span_operation_fts MATCH ?)")
						params.push(ftsQuery)
					} else {
						clauses.push("trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE operation_name LIKE ? COLLATE NOCASE)")
						params.push(`%${input.operation}%`)
					}
				}

				const exactAttrMatch = buildExactAttributeMatchSubquery("span_attributes", ["trace_id", "span_id"], input.attributeFilters)
				if (exactAttrMatch) {
					clauses.push(`trace_id IN (SELECT DISTINCT trace_id FROM (${exactAttrMatch.sql}))`)
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

				const rows = db.query(`
					SELECT trace_id, service_name, root_operation_name, started_at_ms, ended_at_ms, active_span_count, duration_ms, span_count, error_count
					FROM trace_summaries
					WHERE ${clauses.join(" AND ")}
					ORDER BY started_at_ms DESC, trace_id DESC
					LIMIT ?
				`).all(...params, limit) as TraceSummaryRow[]

				return rows.map(parseSummaryRow)
			})
		})

		const getTrace = Effect.fn("motel/TelemetryStore.getTrace")(function* (traceId: string) {
			yield* Effect.annotateCurrentSpan("trace.trace_id", traceId)
			return yield* Effect.sync(() => {
				const rows = db.query(`
					SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC
				`).all(traceId) as SpanRow[]
				return rows.length === 0 ? null : buildTrace(traceId, rows)
			})
		})

		const getSpan = Effect.fn("motel/TelemetryStore.getSpan")(function* (spanId: string) {
			yield* Effect.annotateCurrentSpan("trace.span_id", spanId)
			return yield* Effect.sync(() => {
				// Fetch only the target span row (uses idx_spans_span_id)
				const spanRow = db.query(`SELECT * FROM spans WHERE span_id = ? LIMIT 1`).get(spanId) as SpanRow | null
				if (!spanRow) return null

				const traceId = spanRow.trace_id

				// Walk the parent chain in one recursive CTE instead of one query
				// per hop. Root context remains the earliest root in the trace,
				// matching full trace hydration even when input has multiple roots.
				let parentOperationName: string | null = null
				let depth = 0
				if (spanRow.parent_span_id) {
					const ancestors = db.query(`
						WITH RECURSIVE ancestors(span_id, parent_span_id, operation_name, hop) AS (
							SELECT span_id, parent_span_id, operation_name, 1
							FROM spans WHERE trace_id = ? AND span_id = ?
							UNION ALL
							SELECT s.span_id, s.parent_span_id, s.operation_name, a.hop + 1
							FROM ancestors a
							JOIN spans s ON s.trace_id = ? AND s.span_id = a.parent_span_id
						)
						SELECT span_id, parent_span_id, operation_name, hop FROM ancestors ORDER BY hop ASC
					`).all(traceId, spanRow.parent_span_id, traceId) as Array<{ span_id: string; parent_span_id: string | null; operation_name: string; hop: number }>

					parentOperationName = ancestors[0]?.operation_name ?? null
					depth = ancestors.length
				}

				const rootRow = db.query(`
					SELECT operation_name FROM spans
					WHERE trace_id = ? AND parent_span_id IS NULL
					ORDER BY start_time_ms ASC LIMIT 1
				`).get(traceId) as { operation_name: string } | null
				const rootOperationName = rootRow?.operation_name ?? "unknown"

				const parsed = parseSpanRow(spanRow)
				return {
					traceId,
					rootOperationName,
					parentOperationName,
					span: { ...parsed, depth },
				} satisfies SpanItem
			})
		})

		const listTraceSpans = Effect.fn("motel/TelemetryStore.listTraceSpans")(function* (traceId: string) {
			return yield* Effect.sync(() => {
				const rows = db.query(`SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC`).all(traceId) as SpanRow[]
				return rows.length === 0 ? [] as readonly SpanItem[] : buildSpanItems(traceId, rows)
			})
		})

		const searchSpans = Effect.fn("motel/TelemetryStore.searchSpans")(function* (input: SpanSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 100
			const hasContainsFilters = Object.keys(input.attributeContainsFilters ?? {}).length > 0
			// Only over-fetch when post-filtering will discard rows. Without
			// a parentOperation filter the SQL `LIMIT` already returns the
			// final set, and over-fetching just makes us parse JSON blobs
			// for rows we'll throw away.
			const needsPostFilter = !!input.parentOperation
			const candidateLimit = !needsPostFilter
				? limit
				: hasContainsFilters
					? Math.max(limit * 20, 500)
					: Math.max(limit * 10, 200)

			return yield* Effect.sync(() => {
				// First pass: fetch only the columns needed to filter and
				// to drive the parent-context lookup. Parsing the heavy
				// `*_json` blobs is deferred until after we've sliced down
				// to the final `limit`.
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

				const exactAttrMatch = buildExactAttributeMatchSubquery("span_attributes", ["trace_id", "span_id"], input.attributeFilters)
				if (exactAttrMatch) {
					clauses.push(`EXISTS (SELECT 1 FROM (${exactAttrMatch.sql}) AS span_attr_match WHERE span_attr_match.trace_id = s.trace_id AND span_attr_match.span_id = s.span_id)`)
					params.push(...exactAttrMatch.params)
				}

				const containsAttrMatch = buildContainsAttributeMatchSubquery("span_attributes", ["trace_id", "span_id"], input.attributeContainsFilters)
				if (containsAttrMatch) {
					clauses.push(`EXISTS (SELECT 1 FROM (${containsAttrMatch.sql}) AS span_attr_contains_match WHERE span_attr_contains_match.trace_id = s.trace_id AND span_attr_contains_match.span_id = s.span_id)`)
					params.push(...containsAttrMatch.params)
				}

				const candidateRows = db.query(`
					SELECT s.trace_id, s.span_id, s.parent_span_id, s.operation_name, s.start_time_ms
					${fromSql}
					WHERE ${clauses.join(" AND ")}
					ORDER BY s.start_time_ms DESC
					LIMIT ?
				`).all(...joinParams, ...params, candidateLimit) as Array<{ trace_id: string; span_id: string; parent_span_id: string | null; operation_name: string; start_time_ms: number }>

				const traceIds = [...new Set(candidateRows.map((row) => row.trace_id))]
				if (traceIds.length === 0) return [] as readonly SpanItem[]

				const keyOf = (traceId: string, spanId: string) => `${traceId}:${spanId}`
				const spanContextById = new Map<string, { readonly parentSpanId: string | null; readonly operationName: string }>()

				// Bulk-prefetch parent metadata for every span in every trace
				// touched by the candidate set. One indexed scan per trace_id
				// is much cheaper than a per-span lookup loop while computing
				// depth, and we get the trace-root lookup in the same pass.
				const placeholders = traceIds.map(() => "?").join(", ")
				const allSpanRows = db.query(`
					SELECT trace_id, span_id, parent_span_id, operation_name, start_time_ms
					FROM spans
					WHERE trace_id IN (${placeholders})
				`).all(...traceIds) as Array<{ trace_id: string; span_id: string; parent_span_id: string | null; operation_name: string; start_time_ms: number }>

				const rootOperationByTraceId = new Map<string, { operationName: string; startTimeMs: number }>()
				for (const row of allSpanRows) {
					spanContextById.set(keyOf(row.trace_id, row.span_id), {
						parentSpanId: row.parent_span_id,
						operationName: row.operation_name,
					})
					if (row.parent_span_id === null) {
						const existing = rootOperationByTraceId.get(row.trace_id)
						if (!existing || row.start_time_ms < existing.startTimeMs) {
							rootOperationByTraceId.set(row.trace_id, { operationName: row.operation_name, startTimeMs: row.start_time_ms })
						}
					}
				}

				const getSpanContext = (traceId: string, spanId: string) => spanContextById.get(keyOf(traceId, spanId)) ?? null

				const depthById = new Map<string, number>()
				const getDepth = (traceId: string, spanId: string, visiting = new Set<string>()): number => {
					const key = keyOf(traceId, spanId)
					const cached = depthById.get(key)
					if (cached !== undefined) return cached
					if (visiting.has(key)) return 0
					visiting.add(key)
					const context = getSpanContext(traceId, spanId)
					const depth = context?.parentSpanId ? getDepth(traceId, context.parentSpanId, visiting) + 1 : 0
					depthById.set(key, depth)
					return depth
				}

				// Apply parentOperation post-filter on the lite candidate set
				// (cheap — string compare against cached parent op) and then
				// slice down to the final result size before parsing any JSON.
				const parentOperationNeedle = input.parentOperation?.toLowerCase() ?? null
				const filteredLite: typeof candidateRows = []
				for (const row of candidateRows) {
					if (parentOperationNeedle) {
						const parent = row.parent_span_id ? getSpanContext(row.trace_id, row.parent_span_id) : null
						if (!parent?.operationName.toLowerCase().includes(parentOperationNeedle)) continue
					}
					filteredLite.push(row)
					if (filteredLite.length >= limit) break
				}

				if (filteredLite.length === 0) return [] as readonly SpanItem[]

				// Hydrate only the kept rows: one batched fetch of the full
				// SpanRow (with resource_json / attributes_json / events_json)
				// using SQLite's row-value `IN` syntax, then parseSpanRow per
				// kept row. Result order follows `filteredLite` so the caller
				// sees the same ordering the candidate scan produced.
				const keptValues = filteredLite.map(() => "(?, ?)").join(", ")
				const fullRows = db.query(`
					SELECT * FROM spans WHERE (trace_id, span_id) IN (VALUES ${keptValues})
				`).all(...filteredLite.flatMap((row) => [row.trace_id, row.span_id])) as SpanRow[]
				const fullRowByKey = new Map<string, SpanRow>()
				for (const row of fullRows) {
					fullRowByKey.set(keyOf(row.trace_id, row.span_id), row)
				}

				const items: SpanItem[] = []
				for (const lite of filteredLite) {
					const row = fullRowByKey.get(keyOf(lite.trace_id, lite.span_id))
					if (!row) continue
					const parentContext = row.parent_span_id ? getSpanContext(row.trace_id, row.parent_span_id) : null
					const parsedSpan = parseSpanRow(row)
					const span = {
						...parsedSpan,
						depth: getDepth(row.trace_id, row.span_id),
						warnings: row.parent_span_id && !parentContext
							? [`missing span ${row.parent_span_id} (1 child)`]
							: parsedSpan.warnings,
					}
					items.push({
						traceId: row.trace_id,
						rootOperationName: rootOperationByTraceId.get(row.trace_id)?.operationName ?? span.operationName,
						parentOperationName: parentContext?.operationName ?? null,
						span,
					})
				}
				return items
			})
		})

		const searchTraces = Effect.fn("motel/TelemetryStore.searchTraces")(function* (input: TraceSearch) {
			const summaries = yield* searchTraceSummaries(input)
			return yield* Effect.sync(() => loadTracesByIds(summaries.map((summary) => summary.traceId)))
		})

		const searchLogs = Effect.fn("motel/TelemetryStore.searchLogs")(function* (input: LogSearch) {
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
						clauses.push(`id IN (SELECT CAST(log_id AS INTEGER) FROM log_body_fts WHERE log_body_fts MATCH ?)`)
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
					clauses.push(`(timestamp_ms < ? OR (timestamp_ms = ? AND id < ?))`)
					params.push(input.cursorTimestampMs, input.cursorTimestampMs, Number(input.cursorId))
				}

				const exactAttrMatch = buildExactAttributeMatchSubquery("log_attributes", ["log_id"], input.attributeFilters)
				if (exactAttrMatch) {
					clauses.push(`id IN (${exactAttrMatch.sql})`)
					params.push(...exactAttrMatch.params)
				}

				const containsAttrMatch = buildContainsAttributeMatchSubquery("log_attributes", ["log_id"], input.attributeContainsFilters)
				if (containsAttrMatch) {
					clauses.push(`id IN (${containsAttrMatch.sql})`)
					params.push(...containsAttrMatch.params)
				}

				const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
				const limit = input.limit ?? config.otel.logFetchLimit
				const rows = db.query(`
					SELECT * FROM logs
					${where}
					ORDER BY timestamp_ms DESC, id DESC
					LIMIT ?
				`).all(...params, limit) as LogRow[]

				return rows.map(parseLogRow)
			})
		})

		const traceStats = Effect.fn("motel/TelemetryStore.traceStats")(function* (input: TraceStatsSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 20
			const hasAttrFilters = Object.keys(input.attributeFilters ?? {}).length > 0
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
						const rows = db.query(`
							SELECT trace_id, value
							FROM span_attributes
							WHERE key = ? AND trace_id IN (${placeholders})
							GROUP BY trace_id
						`).all(attrKey, ...traceIds) as Array<{ trace_id: string; value: string }>

						attrLookup = new Map()
						for (const row of rows) {
							attrLookup.set(row.trace_id, row.value)
						}
					}
				}

				const groups = new Map<string, { durations: number[]; errorTraces: number }>()
				for (const summary of summaries) {
					const group = input.groupBy === "service"
						? summary.serviceName
						: input.groupBy === "operation"
							? summary.rootOperationName
							: input.groupBy === "status"
								? summary.errorCount > 0 ? "error" : "ok"
								: isAttrGroupBy
									? attrLookup?.get(summary.traceId) ?? "unknown"
									: "unknown"

					const bucket = groups.get(group) ?? { durations: [], errorTraces: 0 }
					bucket.durations.push(summary.durationMs)
					if (summary.errorCount > 0) bucket.errorTraces++
					groups.set(group, bucket)
				}

				const rows = [...groups.entries()].map(([group, bucket]) => {
					const count = bucket.durations.length
					const value = input.agg === "count"
						? count
						: input.agg === "avg_duration"
							? bucket.durations.reduce((sum, d) => sum + d, 0) / Math.max(1, count)
							: input.agg === "p95_duration"
								? percentile(bucket.durations, 0.95)
								: bucket.errorTraces / Math.max(1, count)
					return { group, value, count }
				})

				return rows.sort((left, right) => right.value - left.value).slice(0, limit)
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

				const groupExpr = input.groupBy === "service"
					? "service_name"
					: input.groupBy === "operation"
						? "root_operation_name"
						: input.groupBy === "status"
							? "CASE WHEN error_count > 0 THEN 'error' ELSE 'ok' END"
							: "'unknown'"

				const aggExpr = input.agg === "count"
					? "COUNT(*)"
					: input.agg === "avg_duration"
						? "AVG(duration_ms)"
						: "CAST(SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)"

				if (input.agg === "p95_duration") {
					const rows = db.query(`
						SELECT ${groupExpr} AS grp, duration_ms
						FROM trace_summaries
						WHERE ${whereClauses.join(" AND ")}
					`).all(...whereParams) as Array<{ grp: string; duration_ms: number }>

					const groups = new Map<string, number[]>()
					for (const row of rows) {
						const bucket = groups.get(row.grp) ?? []
						bucket.push(row.duration_ms)
						groups.set(row.grp, bucket)
					}

					return [...groups.entries()]
						.map(([group, durations]) => ({ group, value: percentile(durations, 0.95), count: durations.length }))
						.sort((left, right) => right.value - left.value)
						.slice(0, limit)
				}

				const rows = db.query(`
					SELECT ${groupExpr} AS grp, ${aggExpr} AS value, COUNT(*) AS count
					FROM trace_summaries
					WHERE ${whereClauses.join(" AND ")}
					GROUP BY grp
					ORDER BY value DESC
					LIMIT ?
				`).all(...whereParams, limit) as Array<{ grp: string; value: number; count: number }>

				return rows.map((row) => ({ group: row.grp, value: row.value, count: row.count }))
			})
		})

		const logStats = Effect.fn("motel/TelemetryStore.logStats")(function* (input: LogStatsSearch) {
			const now = yield* Clock.currentTimeMillis
			const limit = input.limit ?? 20
			const hasAttrFilters = Object.keys(input.attributeFilters ?? {}).length > 0
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
					const group = input.groupBy === "service"
						? log.serviceName
						: input.groupBy === "severity"
							? log.severityText
							: input.groupBy === "scope"
								? log.scopeName ?? "unknown"
								: isAttrGroupBy
									? log.attributes[input.groupBy.slice(5)] ?? "unknown"
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

				const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""

				const groupExpr = input.groupBy === "service"
					? "service_name"
					: input.groupBy === "severity"
						? "severity_text"
						: input.groupBy === "scope"
							? "COALESCE(scope_name, 'unknown')"
							: "'unknown'"

				const rows = db.query(`
					SELECT ${groupExpr} AS grp, COUNT(*) AS count
					FROM logs
					${where}
					GROUP BY grp
					ORDER BY count DESC
					LIMIT ?
				`).all(...params, limit) as Array<{ grp: string; count: number }>

				return rows.map((row) => ({ group: row.grp, value: row.count, count: row.count }))
			})
		})

		const listRecentLogs = Effect.fn("motel/TelemetryStore.listRecentLogs")(function* (serviceName: string) {
			yield* Effect.annotateCurrentSpan("log.service_name", serviceName)
			const logs = yield* searchLogs({ serviceName, limit: config.otel.logFetchLimit })
			yield* Effect.annotateCurrentSpan("log.result_count", logs.length)
			return logs
		})

		const listFacets = Effect.fn("motel/TelemetryStore.listFacets")(function* (input: FacetSearch) {
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
							SELECT service_name AS value, COUNT(*) AS count
							FROM trace_summaries
							WHERE started_at_ms >= ?
							GROUP BY service_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(cutoff, limit) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "operation") {
						const rows = db.query(`
							SELECT root_operation_name AS value, COUNT(*) AS count
							FROM trace_summaries
							WHERE started_at_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY root_operation_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "status") {
						const rows = db.query(`
							SELECT CASE WHEN error_count > 0 THEN 'error' ELSE 'ok' END AS value, COUNT(*) AS count
							FROM trace_summaries
							WHERE started_at_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY value
							ORDER BY count DESC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
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
						// WHERE clause lets SQLite skip reading those pages from disk.
						// COUNT(DISTINCT ...) does its own per-group dedup via a temp B-tree,
						// so the outer query needs no DISTINCT subquery in front of it. We
						// pre-filter trace_ids through trace_summaries (an indexed lookup) so
						// the planner can use a SEMI JOIN against the small in-window set
						// instead of joining every span_attributes row to trace_summaries.
						const params: Array<string | number> = []
						let traceFilter: string
						if (input.serviceName) {
							traceFilter = `(SELECT trace_id FROM trace_summaries WHERE started_at_ms >= ? AND service_name = ?)`
							params.push(cutoff, input.serviceName)
						} else {
							traceFilter = `(SELECT trace_id FROM trace_summaries WHERE started_at_ms >= ?)`
							params.push(cutoff)
						}
						params.push(FACET_VALUE_MAX_LEN, limit)
						const rows = db.query(`
							SELECT key AS value,
							       COUNT(DISTINCT trace_id) AS count,
							       COUNT(DISTINCT value) AS distinct_values
							FROM span_attributes
							WHERE trace_id IN ${traceFilter}
							  AND LENGTH(value) < ?
							GROUP BY key
							ORDER BY (CASE WHEN distinct_values = 1 THEN 1 ELSE 0 END) ASC,
							         distinct_values DESC,
							         count DESC,
							         value ASC
							LIMIT ?
						`).all(...params) as Array<{ value: string; count: number; distinct_values: number }>
						return rows.map((row) => ({ value: row.value, count: row.count }))
					}
					if (input.field === "attribute_values") {
						if (!input.key) return [] as FacetItem[]
						// Skip multi-KB values here too — they blow up GROUP BY on big text.
						// Matches the attribute_keys pre-filter so the picker stays responsive
						// if someone hand-crafts a URL that targets a fat key.
						const params: Array<string | number> = [input.key, FACET_VALUE_MAX_LEN, cutoff]
						if (input.serviceName) params.push(input.serviceName)
						params.push(limit)
						const rows = db.query(`
							SELECT sa.value AS value, COUNT(DISTINCT sa.trace_id) AS count
							FROM span_attributes sa
							JOIN spans s ON s.trace_id = sa.trace_id AND s.span_id = sa.span_id
							WHERE sa.key = ? AND LENGTH(sa.value) < ?
							  AND s.start_time_ms >= ?
							${input.serviceName ? "AND s.service_name = ?" : ""}
							GROUP BY sa.value
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...params) as Array<{ value: string; count: number }>
						return rows
					}
				}

				return [] as FacetItem[]
			})
		})

		const listTraceLogs = Effect.fn("motel/TelemetryStore.listTraceLogs")(function* (traceId: string) {
			yield* Effect.annotateCurrentSpan("log.trace_id", traceId)
			const logs = yield* searchLogs({ traceId, limit: config.otel.logFetchLimit })
			yield* Effect.annotateCurrentSpan("log.result_count", logs.length)
			return logs
		})

		// ---------------------------------------------------------------------------
		// AI Call queries
		// ---------------------------------------------------------------------------

		/** Extracts ai.streamText -> "streamText", ai.streamText.doStream -> "streamText" */
		const parseAiOperation = (operationName: string): string => {
			const parts = operationName.replace(/^ai\./, "").split(".")
			return parts[0] ?? operationName
		}

		/** Builds WHERE clauses for AI call search against the spans table (aliased as s) */
		const buildAiWhereClauses = (input: AiCallSearch | AiCallStatsSearch, cutoff: number) => {
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
			if (input.sessionId) attrFilters.push([AI_ATTR_MAP.sessionId, input.sessionId])
			if (input.functionId) attrFilters.push([AI_ATTR_MAP.functionId, input.functionId])
			if (input.provider) attrFilters.push([AI_ATTR_MAP.provider, input.provider])
			if (input.model) attrFilters.push([AI_ATTR_MAP.model, input.model])

			for (const [key, value] of attrFilters) {
				clauses.push("EXISTS (SELECT 1 FROM span_attributes WHERE span_attributes.trace_id = s.trace_id AND span_attributes.span_id = s.span_id AND key = ? AND value = ?)")
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
					clauses.push(`EXISTS (SELECT 1 FROM span_attributes WHERE span_attributes.trace_id = s.trace_id AND span_attributes.span_id = s.span_id AND key IN (${textKeys}) AND value LIKE ? COLLATE NOCASE)`)
					params.push(...AI_TEXT_SEARCH_KEYS, `%${input.text}%`)
				}
			}

			return { clauses, params }
		}

		/** Load attribute values for a set of spans by key */
		const loadSpanAttrValues = (spans: ReadonlyArray<{ trace_id: string; span_id: string }>, keys: readonly string[]): Map<string, Map<string, string>> => {
			if (spans.length === 0 || keys.length === 0) return new Map()
			const spanPlaceholders = spans.map(() => "(?, ?)").join(", ")
			const keyPlaceholders = keys.map(() => "?").join(", ")
			const spanParams = spans.flatMap((s) => [s.trace_id, s.span_id])

			const rows = db.query(`
				SELECT trace_id, span_id, key, value
				FROM span_attributes
				WHERE (trace_id, span_id) IN (VALUES ${spanPlaceholders})
				AND key IN (${keyPlaceholders})
			`).all(...spanParams, ...keys) as Array<{ trace_id: string; span_id: string; key: string; value: string }>

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

		const searchAiCalls = Effect.fn("motel/TelemetryStore.searchAiCalls")(function* (input: AiCallSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 20

			return yield* Effect.sync(() => {
				const { clauses, params } = buildAiWhereClauses(input, cutoff)

				const rows = db.query(`
					SELECT s.trace_id, s.span_id, s.service_name, s.operation_name, s.start_time_ms, s.duration_ms, s.status
					FROM spans AS s
					WHERE ${clauses.join(" AND ")}
					ORDER BY s.start_time_ms DESC
					LIMIT ?
				`).all(...params, limit) as Array<{
					trace_id: string; span_id: string; service_name: string
					operation_name: string; start_time_ms: number; duration_ms: number; status: string
				}>

				if (rows.length === 0) return [] as readonly AiCallSummary[]

				// Batch-load the attributes we need for summaries
				const summaryAttrKeys = [
					AI_ATTR_MAP.functionId, AI_ATTR_MAP.provider, AI_ATTR_MAP.model,
					AI_ATTR_MAP.sessionId, AI_ATTR_MAP.userId, AI_ATTR_MAP.finishReason,
					AI_ATTR_MAP.inputTokens, AI_ATTR_MAP.outputTokens, AI_ATTR_MAP.totalTokens,
					AI_ATTR_MAP.cachedInputTokens, AI_ATTR_MAP.reasoningTokens,
					AI_ATTR_MAP.promptMessages, AI_ATTR_MAP.prompt, AI_ATTR_MAP.responseText,
				]
				const attrMap = loadSpanAttrValues(rows, summaryAttrKeys)

				// Count tool call child spans per AI span
				const spanPlaceholders = rows.map(() => "(?, ?)").join(", ")
				const spanParams = rows.flatMap((r) => [r.trace_id, r.span_id])
				const toolCountRows = db.query(`
					SELECT parent_span_id, COUNT(*) AS cnt
					FROM spans
					WHERE (trace_id, parent_span_id) IN (VALUES ${spanPlaceholders})
					AND operation_name LIKE 'ai.toolCall%'
					GROUP BY trace_id, parent_span_id
				`).all(...spanParams) as Array<{ parent_span_id: string; cnt: number }>
				const toolCounts = new Map(toolCountRows.map((r) => [r.parent_span_id, r.cnt]))

				return rows.map((row): AiCallSummary => {
					const spanKey = `${row.trace_id}:${row.span_id}`
					const attrs = attrMap.get(spanKey)
					const get = (key: string) => attrs?.get(key) ?? null
					const getNum = (key: string) => {
						const v = get(key)
						return v != null ? Number(v) : null
					}

					const promptContent = get(AI_ATTR_MAP.promptMessages) ?? get(AI_ATTR_MAP.prompt)

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
		})

		const getAiCall = Effect.fn("motel/TelemetryStore.getAiCall")(function* (spanId: string) {
			return yield* Effect.sync(() => {
				const row = db.query(`
					SELECT * FROM spans WHERE span_id = ? AND operation_name LIKE 'ai.%' LIMIT 1
				`).get(spanId) as SpanRow | null
				if (!row) return null

				// Load all attributes for this span
				const attrRows = db.query(`
					SELECT key, value FROM span_attributes
					WHERE trace_id = ? AND span_id = ?
				`).all(row.trace_id, row.span_id) as Array<{ key: string; value: string }>
				const attrs = new Map(attrRows.map((r) => [r.key, r.value]))
				const get = (key: string) => attrs.get(key) ?? null
				const getNum = (key: string) => {
					const v = get(key)
					return v != null ? Number(v) : null
				}

				// Load tool call child spans
				const toolCallRows = db.query(`
					SELECT span_id, operation_name, duration_ms, status, attributes_json
					FROM spans
					WHERE trace_id = ? AND parent_span_id = ? AND operation_name LIKE 'ai.toolCall%'
					ORDER BY start_time_ms ASC
				`).all(row.trace_id, row.span_id) as SpanRow[]

				const toolCalls = toolCallRows.map((tc) => {
					const tcAttrs = JSON.parse(tc.attributes_json) as Record<string, string>
					return {
						name: tcAttrs["ai.toolCall.name"] ?? tc.operation_name,
						spanId: tc.span_id,
						status: tc.status === "error" ? "error" as const : "ok" as const,
						durationMs: tc.duration_ms,
					}
				})

				// Load correlated logs
				const logRows = db.query(`
					SELECT * FROM logs WHERE span_id = ? ORDER BY timestamp_ms ASC
				`).all(row.span_id) as LogRow[]
				const logs = logRows.map(parseLogRow)

				// Parse prompt - try as JSON first for structured display
				const promptRaw = get(AI_ATTR_MAP.promptMessages) ?? get(AI_ATTR_MAP.prompt)
				let promptMessages: unknown = null
				if (promptRaw) {
					try { promptMessages = JSON.parse(promptRaw) } catch { promptMessages = promptRaw }
				}

				// Parse tools
				const toolsRaw = get(AI_ATTR_MAP.tools)
				let toolsAvailable: unknown = null
				if (toolsRaw) {
					try { toolsAvailable = JSON.parse(toolsRaw) } catch { toolsAvailable = toolsRaw }
				}

				// Parse provider metadata
				const providerMetaRaw = get(AI_ATTR_MAP.providerMetadata)
				let providerMetadata: unknown = null
				if (providerMetaRaw) {
					try { providerMetadata = JSON.parse(providerMetaRaw) } catch { providerMetadata = providerMetaRaw }
				}

				return {
					traceId: row.trace_id,
					spanId: row.span_id,
					operation: parseAiOperation(row.operation_name),
					service: row.service_name,
					functionId: get(AI_ATTR_MAP.functionId),
					provider: get(AI_ATTR_MAP.provider),
					model: get(AI_ATTR_MAP.model),
					status: row.status === "error" ? "error" as const : "ok" as const,
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
						avgOutputTokensPerSecond: getNum(AI_ATTR_MAP.avgOutputTokensPerSecond),
					},
					logs,
				} satisfies AiCallDetail
			})
		})

		const aiCallStats = Effect.fn("motel/TelemetryStore.aiCallStats")(function* (input: AiCallStatsSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 20

			return yield* Effect.sync(() => {
				const { clauses, params } = buildAiWhereClauses(input, cutoff)

				// For status groupBy, we can do it purely from the spans table
				if (input.groupBy === "status") {
					const rows = db.query(`
						SELECT s.status AS grp, COUNT(*) AS count, AVG(s.duration_ms) AS avg_dur
						FROM spans AS s
						WHERE ${clauses.join(" AND ")}
						GROUP BY s.status
						ORDER BY count DESC
						LIMIT ?
					`).all(...params, limit) as Array<{ grp: string; count: number; avg_dur: number }>

					if (input.agg === "count") return rows.map((r) => ({ group: r.grp, value: r.count, count: r.count }))
					if (input.agg === "avg_duration") return rows.map((r) => ({ group: r.grp, value: r.avg_dur, count: r.count }))
				}

				// For attribute-based groupBy, we need to join span_attributes
				const groupByAttrKey = input.groupBy === "provider" ? AI_ATTR_MAP.provider
					: input.groupBy === "model" ? AI_ATTR_MAP.model
					: input.groupBy === "functionId" ? AI_ATTR_MAP.functionId
					: input.groupBy === "sessionId" ? AI_ATTR_MAP.sessionId
					: null

				if (!groupByAttrKey) return []

				// First get the matching spans with their group values
				const rows = db.query(`
					SELECT
						COALESCE(ga.value, 'unknown') AS grp,
						s.span_id,
						s.duration_ms,
						s.status
					FROM spans AS s
					LEFT JOIN span_attributes AS ga
						ON ga.trace_id = s.trace_id AND ga.span_id = s.span_id AND ga.key = ?
					WHERE ${clauses.join(" AND ")}
				`).all(groupByAttrKey, ...params) as Array<{ grp: string; span_id: string; duration_ms: number; status: string }>

				// Group and aggregate in JS (need p95 and token aggregation)
				const groups = new Map<string, { durations: number[]; count: number; spanIds: string[] }>()
				for (const row of rows) {
					const bucket = groups.get(row.grp) ?? { durations: [], count: 0, spanIds: [] }
					bucket.durations.push(row.duration_ms)
					bucket.count++
					bucket.spanIds.push(row.span_id)
					groups.set(row.grp, bucket)
				}

				// For token aggregations, batch-load from span_attributes
				if (input.agg === "total_input_tokens" || input.agg === "total_output_tokens") {
					const tokenKey = input.agg === "total_input_tokens" ? AI_ATTR_MAP.inputTokens : AI_ATTR_MAP.outputTokens
					const allSpanIds = [...groups.values()].flatMap((b) => b.spanIds)
					if (allSpanIds.length > 0) {
						const placeholders = allSpanIds.map(() => "?").join(", ")
						const tokenRows = db.query(`
							SELECT span_id, CAST(value AS REAL) AS tokens
							FROM span_attributes
							WHERE key = ? AND span_id IN (${placeholders})
						`).all(tokenKey, ...allSpanIds) as Array<{ span_id: string; tokens: number }>

						const tokenBySpan = new Map(tokenRows.map((r) => [r.span_id, r.tokens]))

						return [...groups.entries()]
							.map(([group, bucket]) => {
								const total = bucket.spanIds.reduce((sum, sid) => sum + (tokenBySpan.get(sid) ?? 0), 0)
								return { group, value: total, count: bucket.count }
							})
							.sort((a, b) => b.value - a.value)
							.slice(0, limit)
					}
				}

				return [...groups.entries()]
					.map(([group, bucket]) => {
						const value = input.agg === "count"
							? bucket.count
							: input.agg === "avg_duration"
								? bucket.durations.reduce((s, d) => s + d, 0) / Math.max(1, bucket.count)
								: input.agg === "p95_duration"
									? percentile(bucket.durations, 0.95)
									: bucket.count
						return { group, value, count: bucket.count }
					})
					.sort((a, b) => b.value - a.value)
					.slice(0, limit)
			})
		})

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
			runRetentionNow: cleanupExpired(),
		})
	})

/** Compatibility factory for callers constructing a writer/query-capable store layer. */
export const makeTelemetryStoreLayer = (opts: TelemetryStoreOptions) =>
	Layer.effect(TelemetryStore, makeTelemetryStoreEffect(opts)).pipe(Layer.provide(BunFileSystem.layer))

/**
 * Default writer runtime used by tests and direct store consumers.
 */
export const TelemetryStoreLive = makeTelemetryStoreLayer({ readonly: false, runRetention: true })

/**
 * The ingest worker's writer. It is the managed daemon's sole owner of
 * schema migrations, FTS backfill, retention, and page reclamation.
 */
export const TelemetryStoreWorkerLive = TelemetryStoreLive

/**
 * Read-only instance for query-only processes (currently the TUI and
 * HTTP query handlers). Skips every DDL/DML statement at startup so
 * the connection can be opened while a writer is mid-transaction
 * without racing for the write lock. Provided as TelemetryStoreReadonly
 * — a distinct service identifier so it can coexist with the writer
 * TelemetryStore in the same runtime.
 */
export const TelemetryStoreReadonlyLive = Layer.effect(TelemetryStoreReadonly, makeTelemetryStoreEffect({ readonly: true, runRetention: false })).pipe(Layer.provide(BunFileSystem.layer))

/** Query-worker reader that waits for the sole writer to finish schema bootstrap. */
export const TelemetryStoreQueryWorkerLive = Layer.effect(
	TelemetryStoreReadonly,
	makeTelemetryStoreEffect({ readonly: true, runRetention: false }).pipe(
		Effect.map((store) => TelemetryStoreReadonly.of(store)),
		Effect.retry(Schedule.spaced("50 millis")),
	),
).pipe(Layer.provide(BunFileSystem.layer))
