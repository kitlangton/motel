import type { TraceItem } from "../domain.ts"
import { formatDuration, formatShortDate, formatTimestamp } from "./format.ts"
import { AlignedHeaderLine, BlankRow, Divider, PlainLine, TextLine } from "./primitives.tsx"
import { SpanDetailView } from "./SpanDetail.tsx"
import { SpanPreview, spanPreviewEntries, WaterfallTimeline } from "./Waterfall.tsx"
import type { DetailView, LogState } from "./state.ts"
import { colors, SEPARATOR } from "./theme.ts"
import { resolveOtelUrl } from "../config.ts"

const traceUiUrl = (traceId: string) => resolveOtelUrl(`/trace/${traceId}`)

export const TraceDetailsPane = ({
	trace,
	traceLogsState,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedSpanIndex,
	detailView,
	onSelectSpan,
}: {
	trace: TraceItem | null
	traceLogsState: LogState
	contentWidth: number
	bodyLines: number
	paneWidth: number
	selectedSpanIndex: number | null
	detailView: DetailView
	onSelectSpan: (index: number) => void
}) => {
	const selectedSpan = trace && selectedSpanIndex !== null ? trace.spans[selectedSpanIndex] ?? null : null
	const traceLogCount = traceLogsState.data.length
	const selectedSpanLogs = selectedSpan ? traceLogsState.data.filter((log) => log.spanId === selectedSpan.spanId) : []
	const spanLogCounts = new Map<string, number>()
	for (const log of traceLogsState.data) {
		if (!log.spanId) continue
		spanLogCounts.set(log.spanId, (spanLogCounts.get(log.spanId) ?? 0) + 1)
	}
	const detailHeaderTitle = detailView === "span-detail" && selectedSpan
		? "SPAN DETAIL"
			: "TRACE DETAILS"
	const detailHeaderRight = detailView === "span-detail" && selectedSpan
		? `${selectedSpan.status} \u00b7 ${formatDuration(selectedSpan.durationMs)}${selectedSpanLogs.length > 0 ? ` \u00b7 ${selectedSpanLogs.length} logs` : ""}`
		: trace
			? `${trace.errorCount > 0 ? `${trace.errorCount} errors` : "healthy"} \u00b7 ${formatDuration(trace.durationMs)}${traceLogCount > 0 ? ` \u00b7 ${traceLogCount} logs` : ""}`
			: "waiting for trace"
	const detailHeaderColor = detailView === "span-detail" && selectedSpan
		? selectedSpan.status === "error"
			? colors.error
			: colors.passing
		: trace && trace.errorCount > 0
			? colors.error
			: colors.passing

	return (
		<box flexDirection="column" height={bodyLines + 5}>
			<box paddingLeft={1} paddingRight={1}>
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
								<TextLine>
									<span>{trace.rootOperationName}</span>
								</TextLine>
								{(() => {
									const left = `${trace.serviceName}${SEPARATOR}${trace.spanCount} spans`
									const dateStr = `${formatShortDate(trace.startedAt)} ${formatTimestamp(trace.startedAt)}`
									const gap = Math.max(2, contentWidth - left.length - dateStr.length)
									return (
										<TextLine>
											<span fg={colors.defaultService}>{trace.serviceName}</span>
											<span fg={colors.separator}>{SEPARATOR}</span>
											<span fg={colors.count}>{trace.spanCount} spans</span>
											<span>{" ".repeat(gap)}</span>
											<span fg={colors.muted}>{dateStr}</span>
										</TextLine>
									)
								})()}
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
									spanLogCounts={spanLogCounts}
									selectedSpanLogs={selectedSpanLogs}
									contentWidth={contentWidth}
									bodyLines={bodyLines}
									selectedSpanIndex={selectedSpanIndex}
									onSelectSpan={onSelectSpan}
								/>
							</box>
							{selectedSpan ? (
								<>
								<Divider width={paneWidth} />
								<box flexDirection="column" paddingLeft={1} paddingRight={1}>
									<SpanPreview span={selectedSpan} logs={selectedSpanLogs} contentWidth={contentWidth} maxLines={Math.min(spanPreviewEntries(selectedSpan, selectedSpanLogs, 99).length, Math.max(2, Math.floor(bodyLines * 0.4)))} />
								</box>
							</>
						) : null}
						</>
					)}
				</>
			) : (
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<PlainLine text="Select a trace with up/down." fg={colors.muted} />
					{Array.from({ length: bodyLines + 2 }, (_, index) => (
						<BlankRow key={index} />
					))}
				</box>
			)}
		</box>
	)
}
