import { useMemo } from "react"
import type { TraceItem } from "../domain.ts"
import { formatDuration, formatShortDate, formatTimestamp, lifecycleLabel, traceUiUrl } from "./format.ts"
import { AlignedHeaderLine, BlankRow, Divider, PlainLine, TextLine } from "./primitives.tsx"
import { SpanDetailView } from "./SpanDetail.tsx"
import { getVisibleSpans, SpanPreview, spanPreviewEntries, WaterfallTimeline } from "./Waterfall.tsx"
import type { DetailView, LogState } from "./state.ts"
import { colors, SEPARATOR } from "./theme.ts"
export const TraceDetailsPane = ({
	trace,
	traceLogsState,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedSpanIndex,
	collapsedSpanIds,
	detailView,
	focused = false,
	onSelectSpan,
}: {
	trace: TraceItem | null
	traceLogsState: LogState
	contentWidth: number
	bodyLines: number
	paneWidth: number
	selectedSpanIndex: number | null
	collapsedSpanIds: ReadonlySet<string>
	detailView: DetailView
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
	const focusIndicator = focused ? "\u25b8 " : ""
	const detailHeaderTitle = detailView === "span-detail" && selectedSpan
		? `${focusIndicator}SPAN DETAIL`
			: `${focusIndicator}TRACE DETAILS`
	const detailHeaderRight = detailView === "span-detail" && selectedSpan
		? `${lifecycleLabel(selectedSpan)} \u00b7 ${selectedSpan.status} \u00b7 ${formatDuration(selectedSpan.durationMs)}${selectedSpanLogs.length > 0 ? ` \u00b7 ${selectedSpanLogs.length} logs` : ""}`
		: trace
			? `${lifecycleLabel(trace)} \u00b7 ${trace.errorCount > 0 ? `${trace.errorCount} errors` : "healthy"} \u00b7 ${formatDuration(trace.durationMs)}${traceLogCount > 0 ? ` \u00b7 ${traceLogCount} logs` : ""}`
			: "waiting for trace"
	const detailHeaderColor = detailView === "span-detail" && selectedSpan
		? selectedSpan.isRunning
			? colors.warning
			: selectedSpan.status === "error"
			? colors.error
			: colors.passing
		: trace?.isRunning
			? colors.warning
			: trace && trace.errorCount > 0
			? colors.error
			: colors.passing

	// Fixed preview reservation keeps the waterfall viewport stable during span
	// navigation — without this, each span's varying attribute count changes the
	// viewport size, causing the virtual window to jump around.
	const maxPreviewAllocation = Math.min(8, Math.max(2, Math.floor(bodyLines * 0.2)))
	const previewReserved = selectedSpanIndex !== null ? maxPreviewAllocation + 1 : 0 // +1 for divider
	const previewMaxLines = selectedSpan ? Math.min(spanPreviewEntries(selectedSpan, selectedSpanLogs, 99).length, maxPreviewAllocation) : 0
	// Header section: 1 (header) + 3 (info lines) + 1 (divider) = 5 rows
	const headerRows = 5
	const waterfallBodyLines = Math.max(4, bodyLines - previewReserved)

	return (
		<box flexDirection="column" height={bodyLines + headerRows}>
			<box paddingLeft={1}>
				<AlignedHeaderLine left={detailHeaderTitle} right={detailHeaderRight} width={contentWidth} rightFg={detailHeaderColor} />
			</box>
			{trace ? (
				<>
					{detailView === "span-detail" && selectedSpan ? (
						<box flexDirection="column" paddingLeft={1} paddingRight={1}>
							<SpanDetailView span={selectedSpan} logs={selectedSpanLogs} contentWidth={contentWidth} bodyLines={bodyLines + 2} />
						</box>
					) : (
						<>
							<box flexDirection="column" paddingLeft={1} paddingRight={1}>
								{(() => {
									const dateStr = `${formatShortDate(trace.startedAt)} ${formatTimestamp(trace.startedAt)}`
									const opLeft = trace.rootOperationName
									const opGap = Math.max(2, contentWidth - opLeft.length - dateStr.length)
									return (
										<TextLine>
											<span>{opLeft}</span>
											<span>{" ".repeat(opGap)}</span>
											<span fg={colors.muted}>{dateStr}</span>
										</TextLine>
									)
								})()}
								<TextLine>
									<span fg={colors.defaultService}>{trace.serviceName}</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.count}>{trace.spanCount} spans</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={trace.isRunning ? colors.warning : colors.muted}>{lifecycleLabel(trace)}</span>
								</TextLine>
								{trace.warnings.length > 0 ? (
									<PlainLine text={trace.warnings.join(" | ")} fg={colors.error} />
								) : (
									<PlainLine text={`${trace.traceId.slice(0, 16)}  ${traceUiUrl(trace.traceId)}`} fg={colors.muted} />
								)}
							</box>
							<Divider width={paneWidth} />
							<box flexDirection="column" paddingLeft={1} paddingRight={1}>
								<WaterfallTimeline
									trace={trace}
									filteredSpans={filteredSpans}
									spanLogCounts={spanLogCounts}
									selectedSpanLogs={selectedSpanLogs}
									contentWidth={contentWidth}
									bodyLines={waterfallBodyLines}
									selectedSpanIndex={selectedSpanIndex}
									collapsedSpanIds={collapsedSpanIds}
									onSelectSpan={onSelectSpan}
								/>
							</box>
							{selectedSpan ? (
								<>
								<Divider width={paneWidth} />
								<box flexDirection="column" paddingLeft={1} paddingRight={1}>
									<SpanPreview span={selectedSpan} logs={selectedSpanLogs} contentWidth={contentWidth} maxLines={previewMaxLines} />
								</box>
							</>
						) : null}
						</>
					)}
				</>
			) : (
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<PlainLine text="No trace selected. Use j/k in the trace list." fg={colors.muted} />
				</box>
			)}
		</box>
	)
}
