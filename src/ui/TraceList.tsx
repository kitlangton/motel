import { TextAttributes } from "@opentui/core"
import { useLayoutEffect, useRef, useState } from "react"
import type { TraceSummaryItem } from "../domain.ts"
import {
	fitCell,
	formatDuration,
	lifecycleLabel,
	relativeTime,
	traceIndicator,
	traceIndicatorColor,
	traceRowId,
} from "./format.ts"
import { BlankRow, PlainLine, TextLine } from "./primitives.tsx"
import type { LoadStatus } from "./state.ts"
import { colors } from "./theme.ts"

const getTraceRowLayout = (contentWidth: number) => {
	const stateWidth = 1
	const durationWidth = 8
	const countWidth = 6
	const ageWidth = 4
	// Row layout: state + gap + title + duration + gap + count + gap + age.
	// Let the title expand to fill whatever width is left so the metrics
	// cluster lands against the right edge of the pane.
	const fixed = stateWidth + durationWidth + countWidth + ageWidth + 3
	const titleWidth = Math.max(8, contentWidth - fixed)
	return { stateWidth, durationWidth, countWidth, ageWidth, titleWidth }
}

const fitTraceTitle = (text: string, width: number) => {
	if (width <= 0) return ""
	return text.length <= width ? text.padEnd(width, " ") : text.slice(0, width)
}

const TraceRow = ({
	trace,
	selected,
	contentWidth,
	onSelect,
}: {
	trace: TraceSummaryItem
	selected: boolean
	contentWidth: number
	onSelect: () => void
}) => {
	const { stateWidth, durationWidth, countWidth, ageWidth, titleWidth } =
		getTraceRowLayout(contentWidth)
	const title = trace.isRunning
		? `${trace.rootOperationName} [${lifecycleLabel(trace)}]`
		: trace.rootOperationName
	const titleColor = selected
		? colors.selectedText
		: trace.isRunning
			? colors.warning
			: colors.text

	// Always surface a duration, including `0ms` for sub-millisecond traces —
	// a visible duration is easier to scan than a blank column.
	const durationText = formatDuration(Math.max(0, trace.durationMs))

	return (
		<box id={traceRowId(trace.traceId)} height={1} onMouseDown={onSelect}>
			<TextLine
				fg={selected ? colors.selectedText : colors.text}
				bg={selected ? colors.selectedBg : undefined}
			>
				<span fg={traceIndicatorColor(trace)}>
					{fitCell(traceIndicator(trace), stateWidth)}
				</span>
				<span> </span>
				<span fg={titleColor}>{fitTraceTitle(title, titleWidth)}</span>
				<span fg={colors.muted}>
					{fitCell(durationText, durationWidth, "right")}
				</span>
				<span> </span>
				<span fg={colors.muted}>
					{fitCell(`${trace.spanCount}sp`, countWidth, "right")}
				</span>
				<span> </span>
				<span fg={colors.muted}>
					{fitCell(relativeTime(trace.startedAt), ageWidth, "right")}
				</span>
			</TextLine>
		</box>
	)
}

export interface TraceListProps {
	readonly traces: readonly TraceSummaryItem[]
	readonly selectedTraceId: string | null
	readonly status: LoadStatus
	readonly error: string | null
	readonly contentWidth: number
	readonly services: readonly string[]
	readonly selectedService: string | null
	readonly focused?: boolean
	readonly filterText?: string
	readonly sortMode?: string
	readonly totalCount?: number
	readonly onSelectTrace: (traceId: string) => void
}

interface TraceListBodyProps extends TraceListProps {
	readonly viewportRows: number
}

/**
 * Header strip that sits above the body (renders the `TRACES 100 · filter: x`
 * line). Kept as a separate component so the body can live inside a
 * virtual-windowed box without the header scrolling with it.
 */
export const TraceListHeader = ({
	traces,
	services,
	selectedService,
	filterText,
	sortMode,
	totalCount,
	contentWidth,
}: TraceListProps) => {
	const countLabel =
		totalCount !== undefined && totalCount !== traces.length
			? `${traces.length}/${totalCount}`
			: traces.length > 0
				? String(traces.length)
				: ""
	const metaLabel = [
		filterText ? `filter: ${filterText}` : null,
		sortMode && sortMode !== "recent" ? `sort: ${sortMode}` : null,
	]
		.filter((part): part is string => part !== null)
		.join(" · ")
	const serviceLabel =
		services.length > 1 && selectedService ? `${services.length} services` : ""
	const leftLabel = `TRACES${countLabel ? ` ${countLabel}` : ""}${metaLabel ? ` · ${metaLabel}` : ""}`
	const gap = Math.max(2, contentWidth - leftLabel.length - serviceLabel.length)
	return (
		<TextLine>
			<span fg={colors.accent} attributes={TextAttributes.BOLD}>
				TRACES
			</span>
			{countLabel ? <span fg={colors.muted}>{` ${countLabel}`}</span> : null}
			{metaLabel ? <span fg={colors.muted}>{` · ${metaLabel}`}</span> : null}
			<span fg={colors.muted}>{" ".repeat(gap)}</span>
			<span fg={colors.muted}>{serviceLabel}</span>
		</TextLine>
	)
}

/**
 * Virtual-windowed body for the trace list. Replaces the previous
 * opentui <scrollbox> which had a race with opentui's render-time Yoga
 * layout: useLayoutEffect fires BEFORE the scrollbar's scrollSize has
 * been updated to reflect new content height, so setting scrollTop after
 * a refresh got clamped against the stale max. We own the scroll offset
 * directly as React state and render only the visible rows, eliminating
 * the race entirely.
 */
export const TraceListBody = ({
	traces,
	selectedTraceId,
	status,
	error,
	contentWidth,
	services,
	selectedService,
	viewportRows,
	onSelectTrace,
}: TraceListBodyProps) => {
	const [scrollOffset, setScrollOffset] = useState(0)
	// Track (selectedTraceId, its index in `traces`) from the previous render
	// so we can detect the refresh-shift case (same traceId, new index because
	// rows were prepended/removed around it) and slide scrollOffset by the
	// same delta — preserving the selected row's visual position instead of
	// letting it jump every time auto-refresh pulls in new traces.
	const lastSelectedIdRef = useRef<string | null>(null)
	const lastSelectedIndexRef = useRef<number | null>(null)
	const lastServiceRef = useRef<string | null>(null)

	const viewport = Math.max(1, viewportRows)
	const maxOffset = Math.max(0, traces.length - viewport)

	useLayoutEffect(() => {
		// Service change or initial mount: pin to top.
		if (lastServiceRef.current !== selectedService) {
			lastServiceRef.current = selectedService
			lastSelectedIdRef.current = null
			lastSelectedIndexRef.current = null
			setScrollOffset(0)
			return
		}

		if (!selectedTraceId) {
			lastSelectedIdRef.current = null
			lastSelectedIndexRef.current = null
			return
		}

		const index = traces.findIndex((t) => t.traceId === selectedTraceId)
		if (index < 0) {
			lastSelectedIdRef.current = null
			lastSelectedIndexRef.current = null
			return
		}

		const prevId = lastSelectedIdRef.current
		const prevIndex = lastSelectedIndexRef.current
		const isRefreshShift =
			prevId === selectedTraceId && prevIndex !== null && prevIndex !== index

		setScrollOffset((current) => {
			let next = current
			if (isRefreshShift) {
				// Same row, new position because rows shifted around it — slide
				// the window by the same delta to keep the row in the same
				// visible slot.
				next = current + (index - prevIndex)
			} else if (index < current) {
				// Selection moved above the viewport (user pressed k/up or
				// jumped via gg/home). Snap the top to the selection.
				next = index
			} else if (index >= current + viewport) {
				// Selection moved below the viewport — snap the bottom to it.
				next = index - viewport + 1
			}
			return Math.max(0, Math.min(next, maxOffset))
		})

		lastSelectedIdRef.current = selectedTraceId
		lastSelectedIndexRef.current = index
	}, [traces, selectedTraceId, selectedService, viewport, maxOffset])

	// Mouse wheel moves the scroll window WITHOUT touching selection — lets
	// the user browse ahead of / behind their selected trace freely.
	const handleWheel = (event: {
		scroll?: { direction: string; delta: number }
		stopPropagation?: () => void
	}) => {
		const info = event.scroll
		if (!info || traces.length === 0) return
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

	if (status === "loading" && traces.length === 0) {
		return <PlainLine text="Loading traces..." fg={colors.muted} />
	}
	if (status === "error") {
		return (
			<PlainLine text={error ?? "Could not load traces."} fg={colors.error} />
		)
	}
	if (status === "ready" && services.length === 0) {
		return (
			<PlainLine
				text="No services reporting yet. Start your app and emit a span."
				fg={colors.muted}
			/>
		)
	}
	if (status === "ready" && selectedService && traces.length === 0) {
		return (
			<PlainLine
				text="No traces in the current lookback window."
				fg={colors.muted}
			/>
		)
	}

	const windowStart = Math.max(0, Math.min(scrollOffset, maxOffset))
	const windowTraces = traces.slice(windowStart, windowStart + viewport)
	const blanks = Math.max(0, viewport - windowTraces.length)

	return (
		<box flexDirection="column" onMouseScroll={handleWheel}>
			{windowTraces.map((trace) => (
				<TraceRow
					key={trace.traceId}
					trace={trace}
					selected={trace.traceId === selectedTraceId}
					contentWidth={contentWidth}
					onSelect={() => onSelectTrace(trace.traceId)}
				/>
			))}
			{Array.from({ length: blanks }, (_, i) => (
				<BlankRow key={`trace-blank-${i}`} />
			))}
		</box>
	)
}

// Backwards-compatible single-entry wrapper (header + body) for callers
// that haven't been updated to the split layout yet.
export const TraceList = ({
	showHeader,
	viewportRows,
	...props
}: { showHeader: boolean; viewportRows?: number } & TraceListProps) => {
	if (showHeader) return <TraceListHeader {...props} />
	return <TraceListBody {...props} viewportRows={viewportRows ?? 20} />
}
