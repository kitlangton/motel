import { memo, useLayoutEffect, useState } from "react"
import {
	isAiSpan,
	type LogItem,
	type TraceItem,
	type TraceSpanItem,
} from "../domain.ts"
import {
	formatDuration,
	lifecycleLabel,
	splitDuration,
	truncateText,
} from "./format.ts"
import { BlankRow, TextLine } from "./primitives.tsx"
import { colors, waterfallColors } from "./theme.ts"
export { getVisibleSpans } from "./waterfallModel.ts"
import {
	buildTreePrefix,
	findFirstChildIndex,
	getWaterfallLayout,
	getWaterfallSuffixMetrics,
	type WaterfallSuffixMetrics,
	spanPreviewEntries,
} from "./waterfallModel.ts"

const PARTIAL_BLOCKS = [
	"",
	"\u258f",
	"\u258e",
	"\u258d",
	"\u258c",
	"\u258b",
	"\u258a",
	"\u2589",
	"\u2588",
] as const
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
		if (trailing > 0)
			segs.push({ text: " ".repeat(trailing), fg: rowBg, bg: rowBg })
		return { segments: segs }
	}

	const traceStart = trace.startedAt.getTime()
	const spanStart = span.startTime.getTime()
	const relativeStart = Math.max(0, spanStart - traceStart)
	const startFrac = relativeStart / trace.durationMs
	const endFrac = Math.min(
		1,
		Math.max(
			startFrac,
			(relativeStart + Math.max(0, span.durationMs)) / trace.durationMs,
		),
	)
	const totalUnits = barWidth * 8
	const startUnits = Math.max(
		0,
		Math.min(totalUnits - 1, Math.floor(startFrac * totalUnits)),
	)
	const endUnits = Math.max(
		startUnits + 1,
		Math.min(totalUnits, Math.ceil(endFrac * totalUnits)),
	)
	const startCell = Math.floor(startUnits / 8)
	const endCell = Math.floor((endUnits - 1) / 8)
	const startOffset = startUnits % 8
	const endOffset = endUnits % 8
	const segments: WaterfallBarSegment[] = []

	const pushLeading = (cells: number) => {
		if (cells > 0)
			segments.push({ text: " ".repeat(cells), fg: laneColor, bg: laneColor })
	}
	const pushTrailing = (cells: number) => {
		if (cells > 0)
			segments.push({ text: " ".repeat(cells), fg: rowBg, bg: rowBg })
	}

	pushLeading(startCell)

	if (startCell === endCell) {
		const singleCellUnits = Math.max(1, endUnits - startUnits)
		if (singleCellUnits <= 4) {
			const centeredMarker =
				ULTRA_SHORT_MARKERS[Math.max(0, singleCellUnits - 1)] ?? "\u258f"
			// The marker is a left-aligned sliver — the rest of the cell is
			// post-bar space, so it uses the row bg (transparent) rather than
			// carrying the dark lane track past where the span ended.
			segments.push({ text: centeredMarker, fg: barColor, bg: rowBg })
			pushTrailing(Math.max(0, barWidth - startCell - 1))
			return { segments }
		}

		if (startOffset === 0) {
			// Bar fills from the left of the cell; post-bar pixels fall to row bg.
			segments.push({
				text: PARTIAL_BLOCKS[singleCellUnits],
				fg: barColor,
				bg: rowBg,
			})
		} else {
			// Bar starts partway into the cell; left pixels are lane, right is bar.
			segments.push({
				text: PARTIAL_BLOCKS[startOffset],
				fg: laneColor,
				bg: barColor,
			})
		}
		pushTrailing(Math.max(0, barWidth - startCell - 1))
		return { segments }
	}

	if (startOffset > 0) {
		// Leading partial: left portion is lane (runway), right is bar.
		segments.push({
			text: PARTIAL_BLOCKS[startOffset],
			fg: laneColor,
			bg: barColor,
		})
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

const WaterfallRow = memo(
	({
		span,
		trace,
		index,
		spans,
		contentWidth,
		selected,
		collapsed,
		hasChildSpans,
		suffixMetrics,
		dimmed,
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
		dimmed: boolean
		onSelect: () => void
	}) => {
		const prefix = buildTreePrefix(spans, index)
		const isAi = isAiSpan(span.tags)
		// Indicator column: `!` on error, chevron on collapsible parents,
		// `✦` on AI leaves (LLM payloads detected — enter drills into a
		// specialized chat view), `·` on other leaves. AI parents keep the
		// chevron glyph so tree structure stays readable; the accent color
		// (applied below) carries the "AI content lives here" signal.
		const indicator =
			span.status === "error"
				? "!"
				: hasChildSpans
					? collapsed
						? "\u25b8"
						: "\u25be"
					: isAi
						? "\u2726"
						: "\u00b7"
		const opName = span.isRunning
			? `${span.operationName} [${lifecycleLabel(span)}]`
			: span.operationName

		const { labelMaxWidth, barWidth } = getWaterfallLayout(
			contentWidth,
			suffixMetrics.suffixWidth,
		)

		// Op name budget = labelMaxWidth minus (prefix + indicator + 1 space).
		// Never force a minimum: at very deep nesting or narrow widths the
		// prefix + indicator may already fill the label column, in which
		// case we render the op as an empty string (or a lone ellipsis) so
		// the line stays within contentWidth. Previous code forced op to 4
		// chars which could push total row width past the pane and make
		// OpenTUI smear "..." across the right edge.
		const opMaxWidth = Math.max(0, labelMaxWidth - prefix.length - 2)
		const opTruncated =
			opMaxWidth === 0
				? ""
				: opName.length > opMaxWidth
					? `${opName.slice(0, Math.max(0, opMaxWidth - 1))}\u2026`
					: opName
		const labelLen = prefix.length + 2 + opTruncated.length
		const labelPad = " ".repeat(Math.max(0, labelMaxWidth - labelLen))

		const isError = span.status === "error"
		const barColor = selected
			? isError
				? waterfallColors.barSelectedError
				: waterfallColors.barSelected
			: isError
				? waterfallColors.barError
				: waterfallColors.bar
		const laneColor = selected ? waterfallColors.barLane : waterfallColors.barBg
		const rowBg = selected ? colors.selectedBg : colors.screenBg
		const { segments } = renderWaterfallBar(
			span,
			trace,
			barWidth,
			barColor,
			laneColor,
			rowBg,
		)
		const bg = selected ? colors.selectedBg : undefined
		// Dimmed rows (non-matching under an active waterfall filter) collapse
		// their palette to the muted separator color so matches stand out.
		// Selection always wins — the selected row keeps its full brightness
		// so you can still see where the cursor is while scanning.
		const treeColor = selected
			? colors.separator
			: dimmed
				? colors.separator
				: colors.treeLine
		const indicatorColor = selected
			? colors.selectedText
			: dimmed
				? colors.separator
				: isError
					? colors.error
					: // AI accent outranks parent/leaf color so both AI parents and AI
						// leaves scan as "there's an LLM payload here" from across the
						// waterfall. Error still wins because a failed AI span is first
						// and foremost a failure.
						isAi
						? colors.accent
						: hasChildSpans
							? colors.muted
							: colors.passing
		const opColor = selected
			? colors.selectedText
			: dimmed
				? colors.separator
				: span.isRunning
					? colors.warning
					: colors.text

		const durationFg = selected
			? colors.selectedText
			: dimmed
				? colors.separator
				: durationColor(span.durationMs)
		const unitFg = dimmed && !selected ? colors.separator : colors.muted

		// Split the duration so the unit (s/ms) renders dimmer than the number.
		const { number: durNumber, unit: durUnit } = splitDuration(
			Math.max(0, span.durationMs),
		)
		const durationCell = `${durNumber}${durUnit}`
		const durationPad = " ".repeat(
			Math.max(0, suffixMetrics.maxDurationWidth - durationCell.length),
		)

		return (
			<box height={1} onMouseDown={onSelect}>
				<TextLine bg={bg}>
					{prefix ? <span fg={treeColor}>{prefix}</span> : null}
					<span fg={indicatorColor}>{indicator}</span>
					<span fg={opColor}>{` ${opTruncated}`}</span>
					<span>{labelPad}</span>
					<span> </span>
					{segments.map((segment, index) => (
						<span
							key={`${span.spanId}-bar-${index}`}
							fg={segment.fg}
							bg={segment.bg}
						>
							{segment.text}
						</span>
					))}
					<span> </span>
					<span>{durationPad}</span>
					<span fg={durationFg}>{durNumber}</span>
					<span fg={unitFg}>{durUnit}</span>
				</TextLine>
			</box>
		)
	},
)
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

	const maxKeyLen = Math.min(
		22,
		entries.reduce((max, e) => Math.max(max, e.key.length), 0),
	)
	const valMaxWidth = Math.max(8, contentWidth - maxKeyLen - 3)
	const indent = " ".repeat(maxKeyLen + 2)

	const lines: Array<{
		keyPart: string
		valPart: string
		isWarning?: boolean
	}> = []
	for (const entry of entries) {
		const keyStr =
			entry.key.length > maxKeyLen
				? `${entry.key.slice(0, maxKeyLen - 1)}\u2026`
				: entry.key.padEnd(maxKeyLen)
		const val = entry.value
		if (val.length <= valMaxWidth) {
			lines.push({ keyPart: keyStr, valPart: val, isWarning: entry.isWarning })
		} else {
			let remaining = val
			let first = true
			while (remaining.length > 0) {
				const chunk = remaining.slice(0, valMaxWidth)
				remaining = remaining.slice(valMaxWidth)
				lines.push({
					keyPart: first ? keyStr : indent,
					valPart: chunk,
					isWarning: entry.isWarning,
				})
				first = false
			}
		}
	}

	return (
		<box flexDirection="column">
			{lines.slice(0, maxLines).map((line, i) => (
				<TextLine key={`preview-${i}`}>
					<span fg={line.isWarning ? colors.error : colors.previewKey}>
						{line.keyPart}
					</span>
					<span fg={colors.separator}> </span>
					<span fg={line.isWarning ? colors.error : colors.muted}>
						{line.valPart}
					</span>
				</TextLine>
			))}
		</box>
	)
}

export const WaterfallTimeline = ({
	trace,
	filteredSpans,
	contentWidth,
	bodyLines,
	selectedSpanIndex,
	collapsedSpanIds,
	matchingSpanIds,
	onSelectSpan,
}: {
	trace: TraceItem
	filteredSpans: readonly TraceSpanItem[]
	contentWidth: number
	bodyLines: number
	selectedSpanIndex: number | null
	collapsedSpanIds: ReadonlySet<string>
	/**
	 * When set, spans whose spanId is NOT in this set are dimmed. Null
	 * means no filter active — skip the per-row lookup entirely.
	 */
	matchingSpanIds?: ReadonlySet<string> | null
	onSelectSpan: (index: number) => void
}) => {
	const selectedSpan =
		selectedSpanIndex !== null
			? (filteredSpans[selectedSpanIndex] ?? null)
			: null

	const spanIndexById = new Map<string, number>()
	for (let i = 0; i < trace.spans.length; i++) {
		spanIndexById.set(trace.spans[i].spanId, i)
	}

	// Virtual windowing: only render visible rows. We track scroll offset
	// as state so the mouse wheel can scroll the window INDEPENDENTLY of
	// the selected span (mirrors TraceList behavior). Selection still
	// follows: if the user moves selection off-screen via j/k, we nudge
	// the window to keep it visible — but wheel-scrolling never changes
	// selection, only clicking a row does.
	const viewportSize = Math.max(1, bodyLines)
	const maxOffset = Math.max(0, filteredSpans.length - viewportSize)
	const [scrollOffset, setScrollOffset] = useState(0)

	// Reset scroll offset when the trace changes. Keep this out of render so
	// a trace switch doesn't force a render-phase state update on hot paths.
	useLayoutEffect(() => {
		setScrollOffset(0)
	}, [trace.traceId])

	// Auto-follow selection: only if the selected span would be hidden
	// by the current window, shift just enough to bring it back. Runs in
	// layout effect so the visible window is accurate on the same paint
	// that the selection changed.
	useLayoutEffect(() => {
		if (selectedSpanIndex === null) return
		setScrollOffset((current) => {
			if (selectedSpanIndex < current) return selectedSpanIndex
			if (selectedSpanIndex >= current + viewportSize)
				return selectedSpanIndex - viewportSize + 1
			return current
		})
	}, [selectedSpanIndex, viewportSize])

	const windowStart = Math.max(0, Math.min(scrollOffset, maxOffset))
	const windowSpans = filteredSpans.slice(
		windowStart,
		windowStart + viewportSize,
	)
	const blankCount = Math.max(0, viewportSize - windowSpans.length)

	// One shared suffix width, measured from the current viewport, so every
	// row's duration cell lines up on the same right-edge column.
	const suffixMetrics = getWaterfallSuffixMetrics(windowSpans)

	// Mouse wheel scrolls the window without touching selection — matches
	// the trace list, so the user can browse ahead of their cursor freely
	// and click a row to commit. Delta is scaled 1:1 with opentui's wheel
	// reporting (1 notch ≈ 3 rows on most terminals).
	const handleWheel = (event: {
		scroll?: { direction: string; delta: number }
		stopPropagation?: () => void
	}) => {
		const info = event.scroll
		if (!info || filteredSpans.length === 0) return
		const magnitude = Math.max(1, Math.round(info.delta))
		const signed =
			info.direction === "up"
				? -magnitude
				: info.direction === "down"
					? magnitude
					: 0
		if (signed === 0) return
		setScrollOffset((current) =>
			Math.max(0, Math.min(current + signed, maxOffset)),
		)
		event.stopPropagation?.()
	}

	return (
		<box flexDirection="column" onMouseScroll={handleWheel}>
			{windowSpans.map((span, index) => {
				const actualIndex = windowStart + index
				const fullIndex = spanIndexById.get(span.spanId) ?? -1
				const dimmed =
					matchingSpanIds != null && !matchingSpanIds.has(span.spanId)
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
						hasChildSpans={
							fullIndex >= 0 &&
							findFirstChildIndex(trace.spans, fullIndex) !== null
						}
						suffixMetrics={suffixMetrics}
						dimmed={dimmed}
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
