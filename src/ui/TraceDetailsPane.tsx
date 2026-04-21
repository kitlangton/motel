import { useMemo } from "react"
import type { TraceItem, TraceSummaryItem } from "../domain.ts"
import { formatDuration, formatShortDate, formatTimestamp } from "./format.ts"
import {
	AlignedHeaderLine,
	Divider,
	FilterBar,
	PlainLine,
	TextLine,
} from "./primitives.tsx"
import { WaterfallTimeline } from "./Waterfall.tsx"
import { computeMatchingSpanIds } from "./waterfallFilter.ts"
import { getVisibleSpans } from "./waterfallModel.ts"
import type { LoadStatus } from "./state.ts"
import { colors, SEPARATOR } from "./theme.ts"

/**
 * Level-1 view: trace header + waterfall timeline body.
 *
 * Does not try to render a span detail/preview — the App orchestrates
 * Level-2 layout separately (either as a second horizontal pane in wide
 * mode, or as a full-screen takeover in narrow mode).
 *
 * Total height: `bodyLines + HEADER_ROWS`.
 */
export const TRACE_DETAILS_HEADER_ROWS = 4

export const TraceDetailsPane = ({
	trace,
	traceSummary,
	traceStatus,
	traceError,
	traceLogCount,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedSpanIndex,
	collapsedSpanIds,
	onSelectSpan,
	waterfallFilterMode,
	waterfallFilterText,
}: {
	trace: TraceItem | null
	traceSummary: TraceSummaryItem | null
	traceStatus: LoadStatus
	traceError: string | null
	traceLogCount: number
	contentWidth: number
	bodyLines: number
	paneWidth: number
	selectedSpanIndex: number | null
	collapsedSpanIds: ReadonlySet<string>
	onSelectSpan: (index: number) => void
	waterfallFilterMode: boolean
	waterfallFilterText: string
}) => {
	const filteredSpans = useMemo(
		() => (trace ? getVisibleSpans(trace.spans, collapsedSpanIds) : []),
		[trace, collapsedSpanIds],
	)
	const matchingSpanIds = useMemo(
		() =>
			trace ? computeMatchingSpanIds(trace.spans, waterfallFilterText) : null,
		[trace, waterfallFilterText],
	)
	const matchCount = matchingSpanIds?.size ?? 0
	// Reserve 1 row for the filter bar when it's being shown so the
	// waterfall doesn't spill into the footer.
	const showFilterBar = waterfallFilterMode || waterfallFilterText.length > 0
	const waterfallBodyLines = showFilterBar
		? Math.max(1, bodyLines - 1)
		: bodyLines

	const traceMeta = trace ?? traceSummary
	const hasTraceSelection = traceSummary !== null
	const isLoadingTrace =
		hasTraceSelection && trace === null && traceStatus !== "error"

	const headerTitle = "TRACE DETAILS"
	const headerRight = traceMeta
		? `${traceMeta.errorCount > 0 ? `${traceMeta.errorCount} errors` : traceMeta.isRunning ? "running" : isLoadingTrace ? "loading" : "healthy"} \u00b7 ${formatDuration(traceMeta.durationMs)}${traceLogCount > 0 ? ` \u00b7 ${traceLogCount} logs` : ""}`
		: traceStatus === "error"
			? "trace unavailable"
			: "waiting for trace"
	const headerColor = isLoadingTrace
		? colors.count
		: traceMeta?.isRunning
			? colors.warning
			: traceMeta && traceMeta.errorCount > 0
				? colors.error
				: colors.passing

	const dateStr = traceMeta
		? `${formatShortDate(traceMeta.startedAt)} ${formatTimestamp(traceMeta.startedAt)}`
		: ""
	const opLeft = traceMeta?.rootOperationName ?? ""
	const opGap = Math.max(2, contentWidth - opLeft.length - dateStr.length)
	const warningCount = traceMeta?.warnings.length ?? 0

	return (
		<box
			flexDirection="column"
			width={paneWidth}
			height={bodyLines + TRACE_DETAILS_HEADER_ROWS}
			overflow="hidden"
		>
			<box paddingLeft={1} paddingRight={1}>
				<AlignedHeaderLine
					left={headerTitle}
					right={headerRight}
					width={contentWidth}
					rightFg={headerColor}
				/>
			</box>
			{trace ? (
				<>
					<box flexDirection="column" paddingLeft={1} paddingRight={1}>
						<TextLine>
							<span>{opLeft}</span>
							<span>{" ".repeat(opGap)}</span>
							<span fg={colors.muted}>{dateStr}</span>
						</TextLine>
						<TextLine>
							<span fg={colors.count}>{trace.spanCount} spans</span>
							{warningCount > 0 ? (
								<>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.error}>
										{warningCount} warning{warningCount === 1 ? "" : "s"}
									</span>
								</>
							) : null}
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{trace.traceId}</span>
						</TextLine>
					</box>
					<Divider width={paneWidth} />
					{showFilterBar ? (
						<box paddingLeft={1} paddingRight={1}>
							{waterfallFilterMode ? (
								<FilterBar text={waterfallFilterText} width={contentWidth} />
							) : (
								<TextLine>
									<span fg={colors.muted}>{"/"}</span>
									<span fg={colors.text}>{waterfallFilterText}</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.count}>
										{matchCount} match{matchCount === 1 ? "" : "es"}
									</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.muted}>esc clear</span>
								</TextLine>
							)}
						</box>
					) : null}
					<box flexDirection="column" paddingLeft={1} paddingRight={1}>
						<WaterfallTimeline
							trace={trace}
							filteredSpans={filteredSpans}
							contentWidth={contentWidth}
							bodyLines={waterfallBodyLines}
							selectedSpanIndex={selectedSpanIndex}
							collapsedSpanIds={collapsedSpanIds}
							matchingSpanIds={matchingSpanIds}
							onSelectSpan={onSelectSpan}
						/>
					</box>
				</>
			) : isLoadingTrace && traceMeta ? (
				<>
					<box flexDirection="column" paddingLeft={1} paddingRight={1}>
						<TextLine>
							<span>{opLeft}</span>
							<span>{" ".repeat(opGap)}</span>
							<span fg={colors.muted}>{dateStr}</span>
						</TextLine>
						<TextLine>
							<span fg={colors.count}>{traceMeta.spanCount} spans</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.count}>warming adjacent trace...</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{traceMeta.traceId}</span>
						</TextLine>
					</box>
					<Divider width={paneWidth} />
					<box flexDirection="column" paddingLeft={1} paddingRight={1}>
						<PlainLine text="Loading trace details..." fg={colors.count} />
					</box>
				</>
			) : hasTraceSelection && traceStatus === "error" ? (
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<PlainLine
						text={traceError ?? "Could not load trace."}
						fg={colors.error}
					/>
				</box>
			) : (
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<PlainLine
						text="No trace selected. Use j/k in the trace list."
						fg={colors.muted}
					/>
				</box>
			)}
		</box>
	)
}
