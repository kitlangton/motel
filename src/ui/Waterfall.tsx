import { memo, useRef } from "react"
import type { LogItem, TraceItem, TraceSpanItem } from "../domain.ts"
import { formatDuration, lifecycleLabel, splitDuration, truncateText } from "./format.ts"
import { BlankRow, TextLine } from "./primitives.tsx"
import { colors, waterfallColors } from "./theme.ts"

/** Filter spans to only those visible given a set of collapsed span IDs. */
export const getVisibleSpans = (spans: readonly TraceSpanItem[], collapsedIds: ReadonlySet<string>): readonly TraceSpanItem[] => {
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
export const findParentIndex = (spans: readonly TraceSpanItem[], index: number): number | null => {
	const span = spans[index]
	if (!span || span.depth === 0) return null
	for (let i = index - 1; i >= 0; i--) {
		if (spans[i]!.depth < span.depth) return i
	}
	return null
}

/** Find the index of a span's first child in the visible list. */
export const findFirstChildIndex = (spans: readonly TraceSpanItem[], index: number): number | null => {
	const span = spans[index]
	const next = spans[index + 1]
	if (span && next && next.depth > span.depth) return index + 1
	return null
}

const INTERESTING_TAGS = [
	"http.method", "http.url", "http.status_code", "http.route",
	"db.system", "db.statement", "db.name",
	"messaging.system", "messaging.destination",
	"error", "error.message",
	"net.peer.name", "net.peer.port",
] as const

const buildTreePrefix = (spans: readonly TraceSpanItem[], index: number): string => {
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

const PARTIAL_BLOCKS = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589", "\u2588"] as const
const ULTRA_SHORT_MARKERS = ["\u258f", "\u258e", "\u258d", "\u258c"] as const

type WaterfallBarSegment = {
	readonly text: string
	readonly fg: string
	readonly bg?: string
}

const renderWaterfallBar = (
	span: TraceSpanItem,
	trace: TraceItem,
	barWidth: number,
	barColor: string,
	laneColor: string,
	rowBg: string,
): { readonly segments: readonly WaterfallBarSegment[] } => {
	// Timeline semantics: the leading gap (before the bar starts) is the
	// "runway" showing how long after trace start this span kicked in — render
	// it in the lane color. The trailing gap (after the bar ends) is post-span
	// dead time — render it in the row bg so it visually disappears.
	if (barWidth < 3 || trace.durationMs === 0) {
		const trailing = Math.max(0, barWidth - 1)
		const segs: WaterfallBarSegment[] = [{ text: "\u2588", fg: barColor }]
		if (trailing > 0) segs.push({ text: " ".repeat(trailing), fg: rowBg, bg: rowBg })
		return { segments: segs }
	}

	const traceStart = trace.startedAt.getTime()
	const spanStart = span.startTime.getTime()
	const relativeStart = Math.max(0, spanStart - traceStart)
	const startFrac = relativeStart / trace.durationMs
	const endFrac = Math.min(1, Math.max(startFrac, (relativeStart + Math.max(0, span.durationMs)) / trace.durationMs))
	const totalUnits = barWidth * 8
	const startUnits = Math.max(0, Math.min(totalUnits - 1, Math.floor(startFrac * totalUnits)))
	const endUnits = Math.max(startUnits + 1, Math.min(totalUnits, Math.ceil(endFrac * totalUnits)))
	const startCell = Math.floor(startUnits / 8)
	const endCell = Math.floor((endUnits - 1) / 8)
	const startOffset = startUnits % 8
	const endOffset = endUnits % 8
	const segments: WaterfallBarSegment[] = []

	const pushLeading = (cells: number) => {
		if (cells > 0) segments.push({ text: " ".repeat(cells), fg: laneColor, bg: laneColor })
	}
	const pushTrailing = (cells: number) => {
		if (cells > 0) segments.push({ text: " ".repeat(cells), fg: rowBg, bg: rowBg })
	}

	pushLeading(startCell)

	if (startCell === endCell) {
		const singleCellUnits = Math.max(1, endUnits - startUnits)
		if (singleCellUnits <= 4) {
			const centeredMarker = ULTRA_SHORT_MARKERS[Math.max(0, singleCellUnits - 1)] ?? "\u258f"
			// The marker is a left-aligned sliver — the rest of the cell is
			// post-bar space, so it uses the row bg (transparent) rather than
			// carrying the dark lane track past where the span ended.
			segments.push({ text: centeredMarker, fg: barColor, bg: rowBg })
			pushTrailing(Math.max(0, barWidth - startCell - 1))
			return { segments }
		}

		if (startOffset === 0) {
			// Bar fills from the left of the cell; post-bar pixels fall to row bg.
			segments.push({ text: PARTIAL_BLOCKS[singleCellUnits], fg: barColor, bg: rowBg })
		} else {
			// Bar starts partway into the cell; left pixels are lane, right is bar.
			segments.push({ text: PARTIAL_BLOCKS[startOffset], fg: laneColor, bg: barColor })
		}
		pushTrailing(Math.max(0, barWidth - startCell - 1))
		return { segments }
	}

	if (startOffset > 0) {
		// Leading partial: left portion is lane (runway), right is bar.
		segments.push({ text: PARTIAL_BLOCKS[startOffset], fg: laneColor, bg: barColor })
	}

	const fullStartCell = startCell + (startOffset > 0 ? 1 : 0)
	const fullEndCell = endCell - (endOffset > 0 ? 1 : 0)
	const fullCells = Math.max(0, fullEndCell - fullStartCell + 1)
	if (fullCells > 0) {
		segments.push({ text: "\u2588".repeat(fullCells), fg: barColor })
	}

	if (endOffset > 0) {
		// Trailing partial: left portion is bar, right is row bg (transparent).
		segments.push({ text: PARTIAL_BLOCKS[endOffset], fg: barColor, bg: rowBg })
	}

	pushTrailing(Math.max(0, barWidth - endCell - 1))
	return { segments }
}

const durationColor = (durationMs: number) => {
	if (durationMs >= 10_000) return colors.warning
	if (durationMs >= 1_000) return colors.accent
	if (durationMs >= 100) return colors.count
	if (durationMs > 0) return colors.muted
	return colors.muted
}

export const getWaterfallLayout = (contentWidth: number, suffixWidth: number) => {
	const labelMaxWidth = Math.min(Math.floor(contentWidth * 0.4), 32)
	// Two single-space gaps: one between label and bar, one between bar and suffix.
	const barWidth = Math.max(6, contentWidth - labelMaxWidth - suffixWidth - 2)
	return { labelMaxWidth, barWidth } as const
}

export type WaterfallSuffixMetrics = {
	readonly maxDurationWidth: number
	readonly suffixWidth: number
}

/**
 * Compute a shared suffix (duration) width from the visible viewport.
 * Reserving the width once keeps every row's duration right-aligned on the
 * same column regardless of per-row content. Log correlation lives in the
 * span detail pane, not the row suffix.
 */
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

// Retained for tests: per-row view of the shared layout.
export const getWaterfallColumns = (
	contentWidth: number,
	metrics: WaterfallSuffixMetrics,
) => {
	const { labelMaxWidth, barWidth } = getWaterfallLayout(contentWidth, metrics.suffixWidth)
	return { labelMaxWidth, barWidth, suffixWidth: metrics.suffixWidth } as const
}

export const spanPreviewEntries = (span: TraceSpanItem, logs: readonly LogItem[], maxEntries: number): Array<{ key: string; value: string; isWarning?: boolean }> => {
	const entries = Object.entries(span.tags)
	const interesting = entries.filter(([key]) =>
		INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) || key.startsWith("error"),
	)
	const rest = entries.filter(([key]) =>
		!INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) && !key.startsWith("error") && !key.startsWith("otel.") && key !== "span.kind",
	)
	const tagResults: Array<{ key: string; value: string; isWarning?: boolean }> = []
	if (logs.length > 0) {
		tagResults.push({ key: "logs", value: `${logs.length} correlated` })
		tagResults.push({ key: "log", value: logs[0]!.body.replace(/\s+/g, " ") })
	}

	tagResults.push(...[...interesting, ...rest]
		.slice(0, maxEntries - span.warnings.length)
		.map(([key, value]) => ({ key, value })))
	for (const warning of span.warnings) {
		tagResults.push({ key: "warning", value: warning, isWarning: true })
	}
	return tagResults.slice(0, maxEntries)
}

const WaterfallRow = memo(({
	span,
	trace,
	index,
	spans,
	contentWidth,
	selected,
	collapsed,
	hasChildSpans,
	suffixMetrics,
	onSelect,
}: {
	span: TraceSpanItem
	trace: TraceItem
	index: number
	spans: readonly TraceSpanItem[]
	contentWidth: number
	selected: boolean
	collapsed: boolean
	hasChildSpans: boolean
	suffixMetrics: WaterfallSuffixMetrics
	onSelect: () => void
}) => {
	const prefix = buildTreePrefix(spans, index)
	// Match the trace list indicator: `!` on error, chevron on collapsible parents, `·` on leaves.
	const indicator = span.status === "error" ? "!" : hasChildSpans ? (collapsed ? "\u25b8" : "\u25be") : "\u00b7"
	const opName = span.isRunning ? `${span.operationName} [${lifecycleLabel(span)}]` : span.operationName

	const { labelMaxWidth, barWidth } = getWaterfallLayout(contentWidth, suffixMetrics.suffixWidth)

	const opMaxWidth = Math.max(4, labelMaxWidth - prefix.length - 2)
	const opTruncated = opName.length > opMaxWidth ? `${opName.slice(0, opMaxWidth - 1)}\u2026` : opName
	const labelLen = prefix.length + 2 + opTruncated.length
	const labelPad = " ".repeat(Math.max(0, labelMaxWidth - labelLen))

	const isError = span.status === "error"
	const barColor = selected ? (isError ? waterfallColors.barSelectedError : waterfallColors.barSelected) : isError ? waterfallColors.barError : waterfallColors.bar
	const laneColor = selected ? waterfallColors.barLane : waterfallColors.barBg
	const rowBg = selected ? colors.selectedBg : colors.screenBg
	const { segments } = renderWaterfallBar(span, trace, barWidth, barColor, laneColor, rowBg)
	const bg = selected ? colors.selectedBg : undefined
	const treeColor = selected ? colors.separator : colors.treeLine
	const indicatorColor = isError ? colors.error : hasChildSpans ? (selected ? colors.selectedText : colors.muted) : colors.passing
	const opColor = selected ? colors.selectedText : span.isRunning ? colors.warning : colors.text

	const durationFg = durationColor(span.durationMs)
	const unitFg = colors.muted

	// Split the duration so the unit (s/ms) renders dimmer than the number.
	const { number: durNumber, unit: durUnit } = splitDuration(Math.max(0, span.durationMs))
	const durationCell = `${durNumber}${durUnit}`
	const durationPad = " ".repeat(Math.max(0, suffixMetrics.maxDurationWidth - durationCell.length))

	return (
		<box height={1} onMouseDown={onSelect}>
			<TextLine bg={bg}>
				{prefix ? <span fg={treeColor}>{prefix}</span> : null}
				<span fg={indicatorColor}>{indicator}</span>
				<span fg={opColor}>{` ${opTruncated}`}</span>
				<span>{labelPad}</span>
				<span> </span>
				{segments.map((segment, index) => (
					<span key={`${span.spanId}-bar-${index}`} fg={segment.fg} bg={segment.bg}>{segment.text}</span>
				))}
				<span> </span>
				<span>{durationPad}</span>
				<span fg={durationFg}>{durNumber}</span>
				<span fg={unitFg}>{durUnit}</span>
			</TextLine>
		</box>
	)
})
WaterfallRow.displayName = "WaterfallRow"

export const SpanPreview = ({
	span,
	logs,
	contentWidth,
	maxLines,
}: {
	span: TraceSpanItem
	logs: readonly LogItem[]
	contentWidth: number
	maxLines: number
}) => {
	const entries = spanPreviewEntries(span, logs, maxLines)
	if (entries.length === 0) return null

	const maxKeyLen = Math.min(22, entries.reduce((max, e) => Math.max(max, e.key.length), 0))
	const valMaxWidth = Math.max(8, contentWidth - maxKeyLen - 3)
	const indent = " ".repeat(maxKeyLen + 2)

	const lines: Array<{ keyPart: string; valPart: string; isWarning?: boolean }> = []
	for (const entry of entries) {
		const keyStr = entry.key.length > maxKeyLen ? `${entry.key.slice(0, maxKeyLen - 1)}\u2026` : entry.key.padEnd(maxKeyLen)
		const val = entry.value
		if (val.length <= valMaxWidth) {
			lines.push({ keyPart: keyStr, valPart: val, isWarning: entry.isWarning })
		} else {
			let remaining = val
			let first = true
			while (remaining.length > 0) {
				const chunk = remaining.slice(0, valMaxWidth)
				remaining = remaining.slice(valMaxWidth)
				lines.push({ keyPart: first ? keyStr : indent, valPart: chunk, isWarning: entry.isWarning })
				first = false
			}
		}
	}

	return (
		<box flexDirection="column">
			{lines.slice(0, maxLines).map((line, i) => (
				<TextLine key={`preview-${i}`}>
					<span fg={line.isWarning ? colors.error : colors.previewKey}>{line.keyPart}</span>
					<span fg={colors.separator}>  </span>
					<span fg={line.isWarning ? colors.error : colors.muted}>{line.valPart}</span>
				</TextLine>
			))}
		</box>
	)
}

export const WaterfallTimeline = ({
	trace,
	filteredSpans,
	spanLogCounts,
	selectedSpanLogs,
	contentWidth,
	bodyLines,
	selectedSpanIndex,
	collapsedSpanIds,
	onSelectSpan,
}: {
	trace: TraceItem
	filteredSpans: readonly TraceSpanItem[]
	spanLogCounts: ReadonlyMap<string, number>
	selectedSpanLogs: readonly LogItem[]
	contentWidth: number
	bodyLines: number
	selectedSpanIndex: number | null
	collapsedSpanIds: ReadonlySet<string>
	onSelectSpan: (index: number) => void
}) => {
	const selectedSpan = selectedSpanIndex !== null ? filteredSpans[selectedSpanIndex] ?? null : null

	const spanIndexById = new Map<string, number>()
	for (let i = 0; i < trace.spans.length; i++) {
		spanIndexById.set(trace.spans[i].spanId, i)
	}

	// Virtual windowing: only render visible rows, shift window only when
	// the selection would go out of view (no jerkiness).
	const viewportSize = Math.max(1, bodyLines)
	const scrollOffsetRef = useRef(0)
	const lastTraceIdRef = useRef<string | null>(null)

	// Reset scroll offset when the trace changes
	if (trace.traceId !== lastTraceIdRef.current) {
		scrollOffsetRef.current = 0
		lastTraceIdRef.current = trace.traceId
	}

	// Only shift the window when the selection would be outside it
	if (selectedSpanIndex !== null) {
		if (selectedSpanIndex < scrollOffsetRef.current) {
			scrollOffsetRef.current = selectedSpanIndex
		} else if (selectedSpanIndex >= scrollOffsetRef.current + viewportSize) {
			scrollOffsetRef.current = selectedSpanIndex - viewportSize + 1
		}
	}
	scrollOffsetRef.current = Math.max(0, Math.min(scrollOffsetRef.current, Math.max(0, filteredSpans.length - viewportSize)))

	const windowStart = scrollOffsetRef.current
	const windowSpans = filteredSpans.slice(windowStart, windowStart + viewportSize)
	const blankCount = Math.max(0, viewportSize - windowSpans.length)

	// One shared suffix width, measured from the current viewport, so every
	// row's duration cell lines up on the same right-edge column.
	const suffixMetrics = getWaterfallSuffixMetrics(windowSpans)

	return (
		<box flexDirection="column">
			{windowSpans.map((span, index) => {
				const actualIndex = windowStart + index
				const fullIndex = spanIndexById.get(span.spanId) ?? -1
				return (
					<WaterfallRow
						key={`${trace.traceId}-${span.spanId}`}
						span={span}
						trace={trace}
						index={fullIndex}
						spans={trace.spans}
						contentWidth={contentWidth}
						selected={selectedSpanIndex === actualIndex}
						collapsed={collapsedSpanIds.has(span.spanId)}
						hasChildSpans={fullIndex >= 0 && findFirstChildIndex(trace.spans, fullIndex) !== null}
						suffixMetrics={suffixMetrics}
						onSelect={() => onSelectSpan(actualIndex)}
					/>
				)
			})}
			{Array.from({ length: blankCount }, (_, i) => (
				<BlankRow key={`blank-${i}`} />
			))}
		</box>
	)
}
