import type { TraceSpanItem } from "../domain.ts"

/**
 * Case-insensitive substring match against a span's operation name and
 * any of its tag values. Keys aren't checked — they're dotted
 * identifiers the user never types, so matching them just creates false
 * positives on bare tokens like "ai" or "response".
 */
export const spanMatchesFilter = (
	span: TraceSpanItem,
	needle: string,
): boolean => {
	if (!needle) return true
	if (span.operationName.toLowerCase().includes(needle)) return true
	for (const value of Object.values(span.tags)) {
		if (typeof value === "string" && value.toLowerCase().includes(needle))
			return true
	}
	return false
}

/**
 * Compute the set of span IDs that match the given filter text. Returns
 * null when the filter is empty so callers can skip dimming entirely
 * (hot path during waterfall scrolling).
 */
export const computeMatchingSpanIds = (
	spans: readonly TraceSpanItem[],
	filterText: string,
): ReadonlySet<string> | null => {
	const needle = filterText.trim().toLowerCase()
	if (!needle) return null
	const matches = new Set<string>()
	for (const span of spans) {
		if (spanMatchesFilter(span, needle)) matches.add(span.spanId)
	}
	return matches
}

/**
 * Find the next (direction=1) or previous (direction=-1) matching span
 * index in `filteredSpans` relative to `currentIndex`. Wraps around the
 * ends. Returns `null` when the list has no matches at all. When
 * `currentIndex` is null (nothing selected), starts from either end
 * based on direction.
 */
export const findAdjacentMatch = (
	filteredSpans: readonly TraceSpanItem[],
	matchingSpanIds: ReadonlySet<string>,
	currentIndex: number | null,
	direction: 1 | -1,
): number | null => {
	if (filteredSpans.length === 0 || matchingSpanIds.size === 0) return null
	const start = currentIndex ?? (direction === 1 ? -1 : filteredSpans.length)
	const n = filteredSpans.length
	// Walk the ring exactly once so we wrap but never loop forever.
	for (let step = 1; step <= n; step++) {
		const idx = (((start + direction * step) % n) + n) % n
		const span = filteredSpans[idx]
		if (span && matchingSpanIds.has(span.spanId)) return idx
	}
	return null
}
