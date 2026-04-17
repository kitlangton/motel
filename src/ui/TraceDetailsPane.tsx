import { useMemo } from "react"
import type { TraceItem, TraceSummaryItem } from "../domain.ts"
import { formatDuration, formatShortDate, formatTimestamp } from "./format.ts"
import { AlignedHeaderLine, Divider, PlainLine, TextLine } from "./primitives.tsx"
import { getVisibleSpans, WaterfallTimeline } from "./Waterfall.tsx"
import type { LoadStatus, LogState } from "./state.ts"
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
	traceLogsState,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedSpanIndex,
	collapsedSpanIds,
	focused = false,
	onSelectSpan,
}: {
	trace: TraceItem | null
	traceSummary: TraceSummaryItem | null
	traceStatus: LoadStatus
	traceError: string | null
	traceLogsState: LogState
	contentWidth: number
	bodyLines: number
	paneWidth: number
	selectedSpanIndex: number | null
	collapsedSpanIds: ReadonlySet<string>
	focused?: boolean
	onSelectSpan: (index: number) => void
}) => {
	const filteredSpans = useMemo(
		() => trace ? getVisibleSpans(trace.spans, collapsedSpanIds) : [],
		[trace, collapsedSpanIds],
	)
	const selectedSpan = selectedSpanIndex !== null ? filteredSpans[selectedSpanIndex] ?? null : null
	const traceLogCount = traceLogsState.data.length
	const spanLogCounts = useMemo(() => {
		const counts = new Map<string, number>()
		for (const log of traceLogsState.data) {
			if (!log.spanId) continue
			counts.set(log.spanId, (counts.get(log.spanId) ?? 0) + 1)
		}
		return counts
	}, [traceLogsState.data])
	const selectedSpanLogs = useMemo(
		() => selectedSpan ? traceLogsState.data.filter((log) => log.spanId === selectedSpan.spanId) : [],
		[selectedSpan, traceLogsState.data],
	)

	const traceMeta = trace ?? traceSummary
	const hasTraceSelection = traceSummary !== null
	const isLoadingTrace = hasTraceSelection && trace === null && traceStatus !== "error"

	const focusIndicator = focused ? "\u25b8 " : ""
	const headerTitle = `${focusIndicator}TRACE DETAILS`
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

	const dateStr = traceMeta ? `${formatShortDate(traceMeta.startedAt)} ${formatTimestamp(traceMeta.startedAt)}` : ""
	const opLeft = traceMeta?.rootOperationName ?? ""
	const opGap = Math.max(2, contentWidth - opLeft.length - dateStr.length)
	const warningCount = traceMeta?.warnings.length ?? 0

	return (
		<box flexDirection="column" width={paneWidth} height={bodyLines + TRACE_DETAILS_HEADER_ROWS} overflow="hidden">
			<box paddingLeft={1} paddingRight={0}>
				<AlignedHeaderLine left={headerTitle} right={headerRight} width={contentWidth} rightFg={headerColor} />
			</box>
			{trace ? (
				<>
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
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
									<span fg={colors.error}>{warningCount} warning{warningCount === 1 ? "" : "s"}</span>
								</>
							) : null}
						</TextLine>
					</box>
					<Divider width={paneWidth} />
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
						<WaterfallTimeline
							trace={trace}
							filteredSpans={filteredSpans}
							spanLogCounts={spanLogCounts}
							selectedSpanLogs={selectedSpanLogs}
							contentWidth={contentWidth}
							bodyLines={bodyLines}
							selectedSpanIndex={selectedSpanIndex}
							collapsedSpanIds={collapsedSpanIds}
							onSelectSpan={onSelectSpan}
						/>
					</box>
				</>
			) : isLoadingTrace && traceMeta ? (
				<>
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
						<TextLine>
							<span>{opLeft}</span>
							<span>{" ".repeat(opGap)}</span>
							<span fg={colors.muted}>{dateStr}</span>
						</TextLine>
						<TextLine>
							<span fg={colors.count}>{traceMeta.spanCount} spans</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.count}>warming adjacent trace...</span>
						</TextLine>
					</box>
					<Divider width={paneWidth} />
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
						<PlainLine text="Loading trace details..." fg={colors.count} />
					</box>
				</>
			) : hasTraceSelection && traceStatus === "error" ? (
				<box flexDirection="column" paddingLeft={1} paddingRight={0}>
					<PlainLine text={traceError ?? "Could not load trace."} fg={colors.error} />
				</box>
			) : (
				<box flexDirection="column" paddingLeft={1} paddingRight={0}>
					<PlainLine text="No trace selected. Use j/k in the trace list." fg={colors.muted} />
				</box>
			)}
		</box>
	)
}
