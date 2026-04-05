import { config } from "../config.ts"
import type { TraceItem } from "../domain.ts"
import { fitCell, formatDuration, relativeTime, traceIndicator, traceIndicatorColor, traceRowId } from "./format.ts"
import { AlignedHeaderLine, PlainLine, TextLine } from "./primitives.tsx"
import type { LoadStatus } from "./state.ts"
import { colors } from "./theme.ts"

const getTraceRowLayout = (contentWidth: number) => {
	const stateWidth = 1
	const durationWidth = 8
	const countWidth = 7
	const ageWidth = 6
	const titleWidth = Math.max(8, contentWidth - stateWidth - durationWidth - countWidth - ageWidth - 3)
	return { stateWidth, durationWidth, countWidth, ageWidth, titleWidth }
}

const TraceRow = ({
	trace,
	selected,
	contentWidth,
	onSelect,
}: {
	trace: TraceItem
	selected: boolean
	contentWidth: number
	onSelect: () => void
}) => {
	const { stateWidth, durationWidth, countWidth, ageWidth, titleWidth } = getTraceRowLayout(contentWidth)
	const title = `${trace.rootOperationName} #${trace.traceId.slice(-6)}`

	return (
		<box id={traceRowId(trace.traceId)} height={1} onMouseDown={onSelect}>
			<TextLine fg={selected ? colors.selectedText : colors.text} bg={selected ? colors.selectedBg : undefined}>
				<span fg={traceIndicatorColor(trace)}>{fitCell(traceIndicator(trace), stateWidth)}</span>
				<span> </span>
				<span>{fitCell(title, titleWidth)}</span>
				<span fg={selected ? colors.accent : colors.count}>{fitCell(formatDuration(trace.durationMs), durationWidth, "right")}</span>
				<span fg={colors.muted}>{fitCell(`${trace.spanCount}sp`, countWidth, "right")}</span>
				<span fg={colors.muted}>{fitCell(relativeTime(trace.startedAt), ageWidth, "right")}</span>
			</TextLine>
		</box>
	)
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
	totalCount,
	onSelectTrace,
}: {
	showHeader: boolean
	traces: readonly TraceItem[]
	selectedTraceId: string | null
	status: LoadStatus
	error: string | null
	contentWidth: number
	services: readonly string[]
	selectedService: string | null
	focused?: boolean
	filterText?: string
	totalCount?: number
	onSelectTrace: (traceId: string) => void
}) => {
	if (showHeader) {
		const filterLabel = filterText ? ` \u00b7 filter: ${filterText}` : ""
		const countLabel = totalCount !== undefined && totalCount !== traces.length ? ` (${traces.length}/${totalCount})` : ` (${traces.length})`
		return (
			<AlignedHeaderLine
				left={`${focused ? "\u25b8 " : "  "}LOCAL TRACES${countLabel}${filterLabel}`}
				right={`${selectedService ?? "waiting for traces"} \u00b7 ${services.length} svc`}
				width={contentWidth}
			/>
		)
	}

	return (
		<box flexDirection="column">
			{status === "loading" && traces.length === 0 ? <PlainLine text="- Loading traces..." fg={colors.muted} /> : null}
			{status === "error" ? <PlainLine text={`- ${error ?? "Could not load traces."}`} fg={colors.error} /> : null}
			{status === "ready" && services.length === 0 ? <PlainLine text="- No services yet. Start leto or emit local spans, then refresh." fg={colors.muted} /> : null}
			{status === "ready" && selectedService && traces.length === 0 ? <PlainLine text="- No traces for the selected service in the current lookback window." fg={colors.muted} /> : null}
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
