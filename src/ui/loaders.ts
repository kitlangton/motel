import { Effect } from "effect"
import { config } from "../config.ts"
import { queryRuntime } from "../runtime.ts"
import { LogQueryService } from "../services/LogQueryService.ts"
import { TraceQueryService } from "../services/TraceQueryService.ts"

export const loadTraceServices = () =>
	queryRuntime.runPromise(
		Effect.flatMap(
			TraceQueryService.asEffect(),
			(service) => service.listServices,
		),
	)

export const loadRecentTraceSummaries = (serviceName: string) =>
	queryRuntime.runPromise(
		Effect.flatMap(TraceQueryService.asEffect(), (service) =>
			service.listTraceSummaries(serviceName),
		),
	)

/**
 * Server-side trace summary search. Accepts any combination of:
 *
 * - `attributeFilters` — exact-match span attributes (from the `f` picker)
 * - `aiText`           — FTS5-backed search across LLM prompt/response
 *                        content (AI_FTS_KEYS), from the `:ai <query>`
 *                        modifier in the `/` filter
 *
 * Both filters compose: when both are set, a trace must match both. When
 * neither is set, callers should prefer `loadRecentTraceSummaries` so
 * the server can skip the search path entirely.
 */
export const loadFilteredTraceSummaries = (
	serviceName: string,
	options: {
		readonly attributeFilters?: Readonly<Record<string, string>>
		readonly aiText?: string | null
	},
) =>
	queryRuntime.runPromise(
		Effect.flatMap(TraceQueryService.asEffect(), (service) =>
			service.searchTraceSummaries({
				serviceName,
				attributeFilters: options.attributeFilters,
				aiText: options.aiText ?? null,
				limit: config.otel.traceFetchLimit,
			}),
		),
	)

export const loadTraceAttributeKeys = (serviceName: string) =>
	queryRuntime.runPromise(
		Effect.flatMap(TraceQueryService.asEffect(), (service) =>
			service.listFacets({
				type: "traces",
				field: "attribute_keys",
				serviceName,
				limit: 200,
			}),
		),
	)

export const loadTraceAttributeValues = (serviceName: string, key: string) =>
	queryRuntime.runPromise(
		Effect.flatMap(TraceQueryService.asEffect(), (service) =>
			service.listFacets({
				type: "traces",
				field: "attribute_values",
				serviceName,
				key,
				limit: 200,
			}),
		),
	)

// ---------------------------------------------------------------------------
// Facet cache (drives the `f` attribute filter picker)
// ---------------------------------------------------------------------------

export interface FacetRow {
	readonly value: string
	readonly count: number
}

export interface FacetCacheEntry {
	readonly data: readonly FacetRow[]
	readonly fetchedAt: Date
}

const facetKeysCache = new Map<string, FacetCacheEntry>()
const facetValuesCache = new Map<string, FacetCacheEntry>()
const facetKeysInflight = new Map<string, Promise<FacetCacheEntry>>()
const facetValuesInflight = new Map<string, Promise<FacetCacheEntry>>()

const valuesKey = (service: string, key: string) => `${service}\u0000${key}`

export const getCachedFacetKeys = (service: string): FacetCacheEntry | null =>
	facetKeysCache.get(service) ?? null

export const getCachedFacetValues = (
	service: string,
	key: string,
): FacetCacheEntry | null =>
	facetValuesCache.get(valuesKey(service, key)) ?? null

export const ensureTraceAttributeKeys = (
	service: string,
): Promise<FacetCacheEntry> => {
	const existing = facetKeysInflight.get(service)
	if (existing) return existing
	const request = loadTraceAttributeKeys(service)
		.then((data) => {
			const entry = { data, fetchedAt: new Date() } satisfies FacetCacheEntry
			facetKeysCache.set(service, entry)
			return entry
		})
		.finally(() => {
			facetKeysInflight.delete(service)
		})
	facetKeysInflight.set(service, request)
	return request
}

export const ensureTraceAttributeValues = (
	service: string,
	key: string,
): Promise<FacetCacheEntry> => {
	const cacheKey = valuesKey(service, key)
	const existing = facetValuesInflight.get(cacheKey)
	if (existing) return existing
	const request = loadTraceAttributeValues(service, key)
		.then((data) => {
			const entry = { data, fetchedAt: new Date() } satisfies FacetCacheEntry
			facetValuesCache.set(cacheKey, entry)
			return entry
		})
		.finally(() => {
			facetValuesInflight.delete(cacheKey)
		})
	facetValuesInflight.set(cacheKey, request)
	return request
}

/** Called from the refreshNonce effect alongside the trace / log cache clears. */
export const invalidateFacetCaches = () => {
	facetKeysCache.clear()
	facetValuesCache.clear()
	facetKeysInflight.clear()
	facetValuesInflight.clear()
}

export const loadTraceDetail = (traceId: string) =>
	queryRuntime.runPromise(
		Effect.flatMap(TraceQueryService.asEffect(), (service) =>
			service.getTrace(traceId),
		),
	)

export const loadTraceLogs = (traceId: string) =>
	queryRuntime.runPromise(
		Effect.flatMap(LogQueryService.asEffect(), (service) =>
			service.listTraceLogs(traceId),
		),
	)

export const loadServiceLogs = (serviceName: string) =>
	queryRuntime.runPromise(
		Effect.flatMap(LogQueryService.asEffect(), (service) =>
			service.listRecentLogs(serviceName),
		),
	)
