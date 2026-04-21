import type { LogItem, TraceSpanItem } from "../domain.ts"
import { formatDuration } from "./format.ts"

/** Filter spans to only those visible given a set of collapsed span IDs. */
export const getVisibleSpans = (
	spans: readonly TraceSpanItem[],
	collapsedIds: ReadonlySet<string>,
): readonly TraceSpanItem[] => {
	if (collapsedIds.size === 0) return spans
	const result: TraceSpanItem[] = []
	let skipDepth = -1
	for (const span of spans) {
		if (skipDepth >= 0 && span.depth > skipDepth) continue
		skipDepth = -1
		result.push(span)
		if (collapsedIds.has(span.spanId)) {
			skipDepth = span.depth
		}
	}
	return result
}

/** Find the index of a span's parent in the visible list. */
export const findParentIndex = (
	spans: readonly TraceSpanItem[],
	index: number,
): number | null => {
	const span = spans[index]
	if (!span || span.depth === 0) return null
	for (let i = index - 1; i >= 0; i--) {
		if (spans[i]!.depth < span.depth) return i
	}
	return null
}

/** Find the index of a span's first child in the visible list. */
export const findFirstChildIndex = (
	spans: readonly TraceSpanItem[],
	index: number,
): number | null => {
	const span = spans[index]
	const next = spans[index + 1]
	if (span && next && next.depth > span.depth) return index + 1
	return null
}

export const buildTreePrefix = (
	spans: readonly TraceSpanItem[],
	index: number,
): string => {
	const span = spans[index]
	if (span.depth === 0) return ""

	const parts: string[] = []

	const isLastChild = (spanIndex: number, depth: number): boolean => {
		for (let i = spanIndex + 1; i < spans.length; i++) {
			if (spans[i].depth < depth) return true
			if (spans[i].depth === depth) return false
		}
		return true
	}

	parts.push(isLastChild(index, span.depth) ? "\u2514\u2500" : "\u251c\u2500")

	for (let d = span.depth - 1; d >= 1; d--) {
		let parentIndex = index
		for (let i = index - 1; i >= 0; i--) {
			if (spans[i].depth === d) {
				parentIndex = i
				break
			}
			if (spans[i].depth < d) break
		}
		parts.push(isLastChild(parentIndex, d) ? "  " : "\u2502 ")
	}

	return parts.reverse().join("")
}

const INTERESTING_TAGS = [
	"http.method",
	"http.url",
	"http.status_code",
	"http.route",
	"db.system",
	"db.statement",
	"db.name",
	"messaging.system",
	"messaging.destination",
	"error",
	"error.message",
	"net.peer.name",
	"net.peer.port",
] as const

export const getWaterfallLayout = (
	contentWidth: number,
	suffixWidth: number,
) => {
	const gapsAndSuffix = suffixWidth + 2
	const remaining = Math.max(4, contentWidth - gapsAndSuffix)
	const labelMaxWidth = Math.max(4, Math.min(Math.floor(remaining * 0.5), 32))
	const barWidth = Math.max(1, contentWidth - labelMaxWidth - gapsAndSuffix)
	return { labelMaxWidth, barWidth } as const
}

export type WaterfallSuffixMetrics = {
	readonly maxDurationWidth: number
	readonly suffixWidth: number
}

export const getWaterfallSuffixMetrics = (
	spans: readonly { readonly durationMs: number; readonly spanId: string }[],
): WaterfallSuffixMetrics => {
	let maxDurationWidth = 0
	for (const span of spans) {
		const d = formatDuration(Math.max(0, span.durationMs)).length
		if (d > maxDurationWidth) maxDurationWidth = d
	}
	return { maxDurationWidth, suffixWidth: maxDurationWidth }
}

export const getWaterfallColumns = (
	contentWidth: number,
	metrics: WaterfallSuffixMetrics,
) => {
	const { labelMaxWidth, barWidth } = getWaterfallLayout(
		contentWidth,
		metrics.suffixWidth,
	)
	return { labelMaxWidth, barWidth, suffixWidth: metrics.suffixWidth } as const
}

export const spanPreviewEntries = (
	span: TraceSpanItem,
	logs: readonly LogItem[],
	maxEntries: number,
): Array<{ key: string; value: string; isWarning?: boolean }> => {
	const entries = Object.entries(span.tags)
	const interesting = entries.filter(
		([key]) =>
			INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) ||
			key.startsWith("error"),
	)
	const rest = entries.filter(
		([key]) =>
			!INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) &&
			!key.startsWith("error") &&
			!key.startsWith("otel.") &&
			key !== "span.kind",
	)
	const tagResults: Array<{ key: string; value: string; isWarning?: boolean }> =
		[]
	if (logs.length > 0) {
		tagResults.push({ key: "logs", value: `${logs.length} correlated` })
		tagResults.push({ key: "log", value: logs[0]!.body.replace(/\s+/g, " ") })
	}

	tagResults.push(
		...[...interesting, ...rest]
			.slice(0, maxEntries - span.warnings.length)
			.map(([key, value]) => ({ key, value })),
	)
	for (const warning of span.warnings) {
		tagResults.push({ key: "warning", value: warning, isWarning: true })
	}
	return tagResults.slice(0, maxEntries)
}
