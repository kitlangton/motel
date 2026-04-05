import type { LogItem, TraceItem, TraceSpanItem } from "../domain.ts"
import { formatDuration, truncateText } from "./format.ts"
import { BlankRow, TextLine } from "./primitives.tsx"
import { colors, waterfallColors } from "./theme.ts"

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

const renderWaterfallBar = (span: TraceSpanItem, trace: TraceItem, barWidth: number): { before: string; bar: string; after: string; barStart: number; barEnd: number } => {
	if (barWidth < 3 || trace.durationMs === 0) {
		return { before: "", bar: "\u2588", after: "", barStart: 0, barEnd: 1 }
	}

	const traceStart = trace.startedAt.getTime()
	const spanStart = span.startTime.getTime()
	const relativeStart = Math.max(0, spanStart - traceStart)
	const startFrac = relativeStart / trace.durationMs
	const widthFrac = Math.max(0.01, span.durationMs / trace.durationMs)

	const barStart = Math.min(Math.round(startFrac * barWidth), barWidth - 1)
	const barLen = Math.max(1, Math.round(widthFrac * barWidth))
	const barEnd = Math.min(barWidth, barStart + barLen)
	const barChars = Math.max(1, barEnd - barStart)
	const afterLen = Math.max(0, barWidth - barStart - barChars)

	return {
		before: "\u00b7".repeat(barStart),
		bar: "\u2588".repeat(barChars),
		after: "\u00b7".repeat(afterLen),
		barStart,
		barEnd,
	}
}

export const getWaterfallLayout = (contentWidth: number, traceDurationMs: number) => {
	const labelMaxWidth = Math.min(Math.floor(contentWidth * 0.4), 32)
	const durationWidth = Math.max(8, formatDuration(traceDurationMs).length + 1)
	const logWidth = 5
	const barWidth = Math.max(6, contentWidth - labelMaxWidth - durationWidth - logWidth - 3)
	return { labelMaxWidth, durationWidth, logWidth, barWidth }
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

const WaterfallRow = ({
	span,
	logCount,
	trace,
	index,
	spans,
	contentWidth,
	selected,
	onSelect,
}: {
	span: TraceSpanItem
	logCount: number
	trace: TraceItem
	index: number
	spans: readonly TraceSpanItem[]
	contentWidth: number
	selected: boolean
	onSelect: () => void
}) => {
	const prefix = buildTreePrefix(spans, index)
	const indicator = span.status === "error" ? "!" : "\u00b7"
	const opName = span.operationName
	const duration = formatDuration(span.durationMs)
	const logText = logCount > 0 ? `${logCount}lg` : ""

	const { labelMaxWidth, logWidth, barWidth } = getWaterfallLayout(contentWidth, trace.durationMs)

	const opMaxWidth = Math.max(4, labelMaxWidth - prefix.length - 2)
	const opTruncated = opName.length > opMaxWidth ? `${opName.slice(0, opMaxWidth - 1)}\u2026` : opName
	const labelLen = prefix.length + 2 + opTruncated.length
	const labelPad = " ".repeat(Math.max(0, labelMaxWidth - labelLen))

	const { before, bar, after } = renderWaterfallBar(span, trace, barWidth)
	const isError = span.status === "error"
	const barColor = selected ? (isError ? waterfallColors.barSelectedError : waterfallColors.barSelected) : isError ? waterfallColors.barError : waterfallColors.bar
	const bg = selected ? colors.selectedBg : undefined
	const treeColor = selected ? colors.separator : "#524d45"
	const indicatorColor = isError ? colors.error : selected ? colors.passing : colors.muted
	const opColor = selected ? colors.selectedText : colors.text

	return (
		<box height={1} onMouseDown={onSelect}>
			<TextLine bg={bg}>
				{prefix ? <span fg={treeColor}>{prefix}</span> : null}
				<span fg={indicatorColor}>{indicator}</span>
				<span fg={opColor}>{` ${opTruncated}`}</span>
				<span>{labelPad}</span>
				<span> </span>
				<span fg={waterfallColors.barBg}>{before}</span>
				<span fg={barColor}>{bar}</span>
				<span fg={waterfallColors.barBg}>{after}</span>
				<span> </span>
				<span fg={selected ? colors.accent : colors.count}>{duration}</span>
				<span>{" ".repeat(Math.max(0, logWidth - logText.length))}</span>
				<span fg={logCount > 0 ? colors.defaultService : colors.muted}>{logText}</span>
			</TextLine>
		</box>
	)
}

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
					<span fg={line.isWarning ? colors.error : "#6a6358"}>{line.keyPart}</span>
					<span fg={colors.separator}>  </span>
					<span fg={line.isWarning ? colors.error : colors.muted}>{line.valPart}</span>
				</TextLine>
			))}
		</box>
	)
}

export const WaterfallTimeline = ({
	trace,
	spanLogCounts,
	selectedSpanLogs,
	contentWidth,
	bodyLines,
	selectedSpanIndex,
	onSelectSpan,
}: {
	trace: TraceItem
	spanLogCounts: ReadonlyMap<string, number>
	selectedSpanLogs: readonly LogItem[]
	contentWidth: number
	bodyLines: number
	selectedSpanIndex: number | null
	onSelectSpan: (index: number) => void
}) => {
	const selectedSpan = selectedSpanIndex !== null ? trace.spans[selectedSpanIndex] ?? null : null
	const previewTagCount = selectedSpan ? spanPreviewEntries(selectedSpan, selectedSpanLogs, 99).length : 0
	const previewLines = selectedSpan ? Math.min(Math.max(previewTagCount, 1), Math.max(2, Math.floor(bodyLines * 0.4))) : 0
	const waterfallLines = bodyLines - 1 - previewLines

	const { labelMaxWidth, durationWidth, barWidth } = getWaterfallLayout(contentWidth, trace.durationMs)
	const midDuration = formatDuration(trace.durationMs / 2)
	const endDuration = formatDuration(trace.durationMs)

	const rulerLabel = " ".repeat(labelMaxWidth + 1)
	const midPoint = Math.floor(barWidth / 2)
	const rulerBar = `${"0".padEnd(midPoint)}${midDuration.padEnd(barWidth - midPoint)}${endDuration.padStart(durationWidth)}`

	const spanWindowSize = Math.max(1, waterfallLines)
	const windowStart = selectedSpanIndex === null
		? 0
		: Math.max(0, Math.min(selectedSpanIndex - Math.floor(spanWindowSize / 2), trace.spans.length - spanWindowSize))
	const visibleSpans = trace.spans.slice(windowStart, windowStart + spanWindowSize)
	const blankCount = Math.max(0, spanWindowSize - visibleSpans.length)

	const remainingBlanks = Math.max(0, blankCount - (selectedSpan ? 0 : previewLines))

	return (
		<box flexDirection="column">
			<TextLine fg={colors.muted}>
				<span>{rulerLabel}</span>
				<span>{rulerBar}</span>
			</TextLine>
			{visibleSpans.map((span, index) => {
				const actualIndex = windowStart + index

				return (
				<WaterfallRow
					key={`${trace.traceId}-${span.spanId}`}
					span={span}
					logCount={spanLogCounts.get(span.spanId) ?? 0}
					trace={trace}
					index={actualIndex}
					spans={trace.spans}
					contentWidth={contentWidth}
					selected={selectedSpanIndex === actualIndex}
					onSelect={() => onSelectSpan(actualIndex)}
				/>
				)
			})}
			{Array.from({ length: remainingBlanks }, (_, i) => (
				<BlankRow key={`blank-${i}`} />
			))}
		</box>
	)
}
