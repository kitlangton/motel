import { TextAttributes } from "@opentui/core"
import { memo } from "react"
import { config } from "../config.ts"
import type { TraceSummaryItem } from "../domain.ts"
import { fitCell, formatDuration, lifecycleLabel, relativeTime, splitDuration, traceIndicator, traceIndicatorColor, traceRowId } from "./format.ts"
import { PlainLine, TextLine } from "./primitives.tsx"
import type { LoadStatus } from "./state.ts"
import { colors } from "./theme.ts"

const getTraceRowLayout = (contentWidth: number) => {
	const stateWidth = 1
	const durationWidth = 8
	const countWidth = 6
	const ageWidth = 4
	// Row layout: state + gap + title + duration + gap + count + gap + age.
	// Let the title expand to fill whatever width is left so the metrics
	// cluster lands against the right edge of the pane instead of floating
	// in a fixed 20-char column with a big dead gap to its right.
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
	const { stateWidth, durationWidth, countWidth, ageWidth, titleWidth } = getTraceRowLayout(contentWidth)
	const title = trace.isRunning
		? `${trace.rootOperationName} [${lifecycleLabel(trace)}]`
		: trace.rootOperationName
	const titleColor = selected ? colors.selectedText : trace.isRunning ? colors.warning : colors.text

	// Always surface a duration, including `0ms` for sub-millisecond traces —
	// a visible duration is easier to scan than a blank column. The unit is
	// rendered in a dimmer color so `123ms` visually reads as `123 ms`.
	const { number: durNumber, unit: durUnit } = splitDuration(Math.max(0, trace.durationMs))
	const durationText = `${durNumber}${durUnit}`
	const durationPad = " ".repeat(Math.max(0, durationWidth - durationText.length))
	const durationFg = selected ? colors.accent : colors.count
	const unitFg = selected ? colors.count : colors.muted

	return (
		<box id={traceRowId(trace.traceId)} height={1} onMouseDown={onSelect}>
			<TextLine fg={selected ? colors.selectedText : colors.text} bg={selected ? colors.selectedBg : undefined}>
				<span fg={traceIndicatorColor(trace)}>{fitCell(traceIndicator(trace), stateWidth)}</span>
				<span> </span>
				<span fg={titleColor}>{fitTraceTitle(title, titleWidth)}</span>
				<span>{durationPad}</span>
				<span fg={durationFg}>{durNumber}</span>
				<span fg={unitFg}>{durUnit}</span>
				<span> </span>
				<span fg={colors.muted}>{fitCell(`${trace.spanCount}sp`, countWidth, "right")}</span>
				<span> </span>
				<span fg={colors.muted}>{fitCell(relativeTime(trace.startedAt), ageWidth, "right")}</span>
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

export const TraceList = ({
	showHeader,
	traces,
	selectedTraceId,
	status,
	error,
	contentWidth,
	services,
	selectedService,
	focused = true,
	filterText,
	sortMode,
	totalCount,
	onSelectTrace,
}: { showHeader: boolean } & TraceListProps) => {
	if (showHeader) {
		const countLabel = totalCount !== undefined && totalCount !== traces.length ? `${traces.length}/${totalCount}` : traces.length > 0 ? String(traces.length) : ""
		const metaLabel = [
			filterText ? `filter: ${filterText}` : null,
			sortMode && sortMode !== "recent" ? `sort: ${sortMode}` : null,
		].filter((part): part is string => part !== null).join(" · ")
		const serviceLabel = services.length > 1 && selectedService
			? `${services.length} services`
			: ""
		const leftLabel = `TRACES${countLabel ? ` ${countLabel}` : ""}${metaLabel ? ` · ${metaLabel}` : ""}`
		const gap = Math.max(2, contentWidth - leftLabel.length - serviceLabel.length)
		return (
			<TextLine>
				<span fg={colors.accent} attributes={TextAttributes.BOLD}>TRACES</span>
				{countLabel ? <span fg={colors.muted}>{` ${countLabel}`}</span> : null}
				{metaLabel ? <span fg={colors.muted}>{` · ${metaLabel}`}</span> : null}
				<span fg={colors.muted}>{" ".repeat(gap)}</span>
				<span fg={colors.muted}>{serviceLabel}</span>
			</TextLine>
		)
	}

	return (
		<box flexDirection="column">
			{status === "loading" && traces.length === 0 ? <PlainLine text="Loading traces..." fg={colors.muted} /> : null}
			{status === "error" ? <PlainLine text={error ?? "Could not load traces."} fg={colors.error} /> : null}
			{status === "ready" && services.length === 0 ? <PlainLine text="No services reporting yet. Start your app and emit a span." fg={colors.muted} /> : null}
			{status === "ready" && selectedService && traces.length === 0 ? <PlainLine text="No traces in the current lookback window." fg={colors.muted} /> : null}
			{traces.map((trace) => (
				<TraceRow
					key={trace.traceId}
					trace={trace}
					selected={trace.traceId === selectedTraceId}
					contentWidth={contentWidth}
					onSelect={() => onSelectTrace(trace.traceId)}
				/>
			))}
		</box>
	)
}
