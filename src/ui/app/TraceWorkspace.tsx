import {
	isAiSpan,
	type LogItem,
	type TraceItem,
	type TraceSummaryItem,
} from "../../domain.ts"
import type { Chunk } from "../aiChatModel.ts"
import { AiChatView } from "../AiChatView.tsx"
import { formatShortDate, formatTimestamp } from "../format.ts"
import {
	AlignedHeaderLine,
	BlankRow,
	Divider,
	SeparatorColumn,
	TextLine,
} from "../primitives.tsx"
import { ServiceLogsView } from "../ServiceLogs.tsx"
import { SpanContentView } from "../SpanContentView.tsx"
import { SpanDetailPane } from "../SpanDetailPane.tsx"
import type {
	AiCallDetailState,
	DetailView,
	LogState,
	ServiceLogState,
	TraceDetailState,
} from "../state.ts"
import { colors, SEPARATOR } from "../theme.ts"
import { TraceDetailsPane } from "../TraceDetailsPane.tsx"
import type { TraceListProps } from "../TraceList.tsx"
import { TraceListPane } from "./TraceListPane.tsx"
import type { AppLayout } from "./useAppLayout.ts"

const separatorJunctionChars = new Map<number, string>([[3, "├"]])
const separatorCrossChars = new Map<number, string>([[3, "┼"]])

interface SharedTraceDetailsProps {
	readonly trace: TraceItem | null
	readonly traceSummary: TraceSummaryItem | null
	readonly traceStatus: TraceDetailState["status"]
	readonly traceError: string | null
	readonly traceLogCount: number
	readonly selectedSpanIndex: number | null
	readonly collapsedSpanIds: ReadonlySet<string>
	readonly waterfallFilterMode: boolean
	readonly waterfallFilterText: string
	readonly onSelectSpan: (index: number) => void
}

interface TraceDetailsSceneProps extends SharedTraceDetailsProps {
	readonly contentWidth: number
	readonly bodyLines: number
	readonly paneWidth: number
}

const TraceDetailsScene = ({
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
	waterfallFilterMode,
	waterfallFilterText,
	onSelectSpan,
}: TraceDetailsSceneProps) => (
	<TraceDetailsPane
		trace={trace}
		traceSummary={traceSummary}
		traceStatus={traceStatus}
		traceError={traceError}
		traceLogCount={traceLogCount}
		contentWidth={contentWidth}
		bodyLines={bodyLines}
		paneWidth={paneWidth}
		selectedSpanIndex={selectedSpanIndex}
		collapsedSpanIds={collapsedSpanIds}
		waterfallFilterMode={waterfallFilterMode}
		waterfallFilterText={waterfallFilterText}
		onSelectSpan={onSelectSpan}
	/>
)

interface SpanDrillInSceneProps {
	readonly aiDrillIn: boolean
	readonly selectedSpan: TraceItem["spans"][number] | null
	readonly aiCallDetailState: AiCallDetailState
	readonly aiChatChunks: readonly Chunk[]
	readonly selectedChatChunkId: string | null
	readonly onSelectChatChunk: (chunkId: string) => void
	readonly chatDetailChunkId: string | null
	readonly onOpenChatChunkDetail: (chunkId: string) => void
	readonly onCloseChatChunkDetail: () => void
	readonly chatDetailScrollOffset: number
	readonly onSetChatDetailScrollOffset: (
		updater: (current: number) => number,
	) => void
	readonly contentWidth: number
	readonly bodyLines: number
	readonly paneWidth: number
	readonly selectedAttrIndex: number
}

const SpanDrillInScene = ({
	aiDrillIn,
	selectedSpan,
	aiCallDetailState,
	aiChatChunks,
	selectedChatChunkId,
	onSelectChatChunk,
	chatDetailChunkId,
	onOpenChatChunkDetail,
	onCloseChatChunkDetail,
	chatDetailScrollOffset,
	onSetChatDetailScrollOffset,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedAttrIndex,
}: SpanDrillInSceneProps) =>
	aiDrillIn ? (
		<AiChatView
			span={selectedSpan}
			detailState={aiCallDetailState}
			chunks={aiChatChunks}
			selectedChunkId={selectedChatChunkId}
			onSelectChunk={onSelectChatChunk}
			detailChunkId={chatDetailChunkId}
			onOpenDetail={onOpenChatChunkDetail}
			onCloseDetail={onCloseChatChunkDetail}
			detailScrollOffset={chatDetailScrollOffset}
			onSetDetailScrollOffset={onSetChatDetailScrollOffset}
			contentWidth={contentWidth}
			bodyLines={bodyLines}
			paneWidth={paneWidth}
		/>
	) : (
		<SpanContentView
			span={selectedSpan}
			contentWidth={contentWidth}
			bodyLines={bodyLines}
			paneWidth={paneWidth}
			selectedAttrIndex={selectedAttrIndex}
		/>
	)

interface ServiceLogsSceneProps {
	readonly selectedTraceService: string | null
	readonly serviceLogState: ServiceLogState
	readonly selectedServiceLogIndex: number
	readonly setSelectedServiceLogIndex: (
		value: number | ((current: number) => number),
	) => void
	readonly headerFooterWidth: number
	readonly availableContentHeight: number
}

const ServiceLogsScene = ({
	selectedTraceService,
	serviceLogState,
	selectedServiceLogIndex,
	setSelectedServiceLogIndex,
	headerFooterWidth,
	availableContentHeight,
}: ServiceLogsSceneProps) => (
	<box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
		<AlignedHeaderLine
			left="SERVICE LOGS"
			right={`${serviceLogState.data.length} logs${serviceLogState.fetchedAt ? `${SEPARATOR}${formatShortDate(serviceLogState.fetchedAt)} ${formatTimestamp(serviceLogState.fetchedAt)}` : ""}`}
			width={headerFooterWidth}
			rightFg={colors.count}
		/>
		<TextLine>
			<span fg={colors.defaultService}>
				{selectedTraceService ?? "unknown"}
			</span>
			<span fg={colors.separator}>{SEPARATOR}</span>
			<span fg={colors.count}>recent logs</span>
		</TextLine>
		<BlankRow />
		<ServiceLogsView
			serviceName={selectedTraceService}
			logsState={serviceLogState}
			selectedIndex={selectedServiceLogIndex}
			onSelectLog={setSelectedServiceLogIndex}
			contentWidth={headerFooterWidth}
			bodyLines={Math.max(8, availableContentHeight - 3)}
		/>
	</box>
)

interface NarrowDrillInHeaderProps {
	readonly contentWidth: number
	readonly viewLevel: 0 | 1 | 2
	readonly selectedTraceSummary: TraceSummaryItem | null
	readonly selectedSpan: TraceItem["spans"][number] | null
}

const NarrowDrillInHeader = ({
	contentWidth,
	viewLevel,
	selectedTraceSummary,
	selectedSpan,
}: NarrowDrillInHeaderProps) => (
	<>
		<box paddingLeft={1} paddingRight={1} height={1} flexDirection="column">
			<TextLine>
				<span fg={colors.muted}>TRACES</span>
				{selectedTraceSummary ? (
					<>
						<span fg={colors.separator}>
							{"  "}
							{SEPARATOR}
							{"  "}
						</span>
						<span fg={viewLevel === 1 ? colors.accent : colors.muted}>
							{selectedTraceSummary.rootOperationName}
						</span>
					</>
				) : null}
				{viewLevel === 2 && selectedSpan ? (
					<>
						<span fg={colors.separator}>
							{"  "}
							{SEPARATOR}
							{"  "}
						</span>
						<span fg={colors.accent}>{selectedSpan.operationName}</span>
					</>
				) : null}
			</TextLine>
		</box>
		<Divider width={contentWidth} />
	</>
)

interface TraceWorkspaceProps {
	readonly layout: AppLayout
	readonly detailView: DetailView
	readonly filterMode: boolean
	readonly filterText: string
	readonly waterfallFilterMode: boolean
	readonly waterfallFilterText: string
	readonly traceListProps: TraceListProps
	readonly selectedTraceService: string | null
	readonly serviceLogState: ServiceLogState
	readonly selectedServiceLogIndex: number
	readonly setSelectedServiceLogIndex: (
		value: number | ((current: number) => number),
	) => void
	readonly traceDetailState: TraceDetailState
	readonly selectedTrace: TraceItem | null
	readonly selectedTraceSummary: TraceSummaryItem | null
	readonly logState: LogState
	readonly selectedSpanIndex: number | null
	readonly collapsedSpanIds: ReadonlySet<string>
	readonly viewLevel: 0 | 1 | 2
	readonly selectedSpan: TraceItem["spans"][number] | null
	readonly selectedSpanLogs: readonly LogItem[]
	readonly selectedAttrIndex: number
	readonly aiCallDetailState: AiCallDetailState
	readonly aiChatChunks: readonly Chunk[]
	readonly selectedChatChunkId: string | null
	readonly onSelectChatChunk: (chunkId: string) => void
	readonly chatDetailChunkId: string | null
	readonly onOpenChatChunkDetail: (chunkId: string) => void
	readonly onCloseChatChunkDetail: () => void
	readonly chatDetailScrollOffset: number
	readonly onSetChatDetailScrollOffset: (
		updater: (current: number) => number,
	) => void
	readonly selectSpan: (index: number) => void
}

export const TraceWorkspace = ({
	layout,
	detailView,
	filterMode,
	filterText,
	waterfallFilterMode,
	waterfallFilterText,
	traceListProps,
	selectedTraceService,
	serviceLogState,
	selectedServiceLogIndex,
	setSelectedServiceLogIndex,
	traceDetailState,
	selectedTrace,
	selectedTraceSummary,
	logState,
	selectedSpanIndex,
	collapsedSpanIds,
	viewLevel,
	selectedSpan,
	selectedSpanLogs,
	selectedAttrIndex,
	aiCallDetailState,
	aiChatChunks,
	selectedChatChunkId,
	onSelectChatChunk,
	chatDetailChunkId,
	onOpenChatChunkDetail,
	onCloseChatChunkDetail,
	chatDetailScrollOffset,
	onSetChatDetailScrollOffset,
	selectSpan,
}: TraceWorkspaceProps) => {
	const aiDrillIn = selectedSpan !== null && isAiSpan(selectedSpan.tags)
	const {
		contentWidth,
		headerFooterWidth,
		isWideLayout,
		leftPaneWidth,
		rightPaneWidth,
		leftContentWidth,
		rightContentWidth,
		sectionPadding,
		wideBodyHeight,
		wideBodyLines,
		narrowListHeight,
		narrowBodyLines,
		narrowFullBodyLines,
		wideTraceListBodyHeight,
		narrowTraceListBodyHeight,
		availableContentHeight,
	} = layout
	const traceDetailsProps: SharedTraceDetailsProps = {
		trace: selectedTrace,
		traceSummary: selectedTraceSummary,
		traceStatus: traceDetailState.status,
		traceError: traceDetailState.error,
		traceLogCount: logState.data.length,
		selectedSpanIndex,
		collapsedSpanIds,
		waterfallFilterMode,
		waterfallFilterText,
		onSelectSpan: selectSpan,
	}
	const drillInContentWidth = Math.max(24, contentWidth - 2)

	if (detailView === "service-logs") {
		return (
			<ServiceLogsScene
				selectedTraceService={selectedTraceService}
				serviceLogState={serviceLogState}
				selectedServiceLogIndex={selectedServiceLogIndex}
				setSelectedServiceLogIndex={setSelectedServiceLogIndex}
				headerFooterWidth={headerFooterWidth}
				availableContentHeight={availableContentHeight}
			/>
		)
	}

	if (isWideLayout) {
		if (viewLevel === 0) {
			return (
				<box flexGrow={1} flexDirection="row">
					<box
						width={leftPaneWidth}
						height={wideBodyHeight}
						flexDirection="column"
					>
						<TraceListPane
							traceListProps={traceListProps}
							filterMode={filterMode}
							filterText={filterText}
							filterWidth={leftContentWidth}
							containerHeight={wideBodyHeight}
							bodyHeight={wideTraceListBodyHeight}
							padding={sectionPadding}
						/>
					</box>
					<SeparatorColumn
						height={wideBodyHeight}
						junctionChars={separatorJunctionChars}
					/>
					<box
						width={rightPaneWidth}
						height={wideBodyHeight}
						flexDirection="column"
					>
						<TraceDetailsScene
							{...traceDetailsProps}
							contentWidth={rightContentWidth}
							bodyLines={wideBodyLines}
							paneWidth={rightPaneWidth}
						/>
					</box>
				</box>
			)
		}

		if (viewLevel === 1) {
			return (
				<box flexGrow={1} flexDirection="row">
					<box
						width={leftPaneWidth}
						height={wideBodyHeight}
						flexDirection="column"
					>
						<TraceDetailsScene
							{...traceDetailsProps}
							contentWidth={leftContentWidth}
							bodyLines={wideBodyLines}
							paneWidth={leftPaneWidth}
						/>
					</box>
					<SeparatorColumn
						height={wideBodyHeight}
						junctionChars={separatorCrossChars}
					/>
					<box
						width={rightPaneWidth}
						height={wideBodyHeight}
						flexDirection="column"
					>
						<SpanDetailPane
							span={selectedSpan}
							trace={selectedTrace}
							logs={selectedSpanLogs}
							contentWidth={rightContentWidth}
							bodyLines={wideBodyLines}
							paneWidth={rightPaneWidth}
							focused={false}
						/>
					</box>
				</box>
			)
		}

		return (
			<box flexGrow={1} flexDirection="column">
				<SpanDrillInScene
					aiDrillIn={aiDrillIn}
					selectedSpan={selectedSpan}
					aiCallDetailState={aiCallDetailState}
					aiChatChunks={aiChatChunks}
					selectedChatChunkId={selectedChatChunkId}
					onSelectChatChunk={onSelectChatChunk}
					chatDetailChunkId={chatDetailChunkId}
					onOpenChatChunkDetail={onOpenChatChunkDetail}
					onCloseChatChunkDetail={onCloseChatChunkDetail}
					chatDetailScrollOffset={chatDetailScrollOffset}
					onSetChatDetailScrollOffset={onSetChatDetailScrollOffset}
					contentWidth={drillInContentWidth}
					bodyLines={wideBodyLines}
					paneWidth={contentWidth}
					selectedAttrIndex={selectedAttrIndex}
				/>
			</box>
		)
	}

	if (viewLevel === 0) {
		return (
			<>
				<TraceListPane
					traceListProps={traceListProps}
					filterMode={filterMode}
					filterText={filterText}
					filterWidth={leftContentWidth}
					containerHeight={narrowListHeight}
					bodyHeight={narrowTraceListBodyHeight}
					padding={sectionPadding}
				/>
				<Divider width={contentWidth} />
				<TraceDetailsScene
					{...traceDetailsProps}
					contentWidth={rightContentWidth}
					bodyLines={narrowBodyLines}
					paneWidth={contentWidth}
				/>
			</>
		)
	}

	return (
		<>
			<NarrowDrillInHeader
				contentWidth={contentWidth}
				viewLevel={viewLevel}
				selectedTraceSummary={selectedTraceSummary}
				selectedSpan={selectedSpan}
			/>
			{viewLevel === 1 ? (
				<TraceDetailsScene
					{...traceDetailsProps}
					contentWidth={rightContentWidth}
					bodyLines={narrowFullBodyLines}
					paneWidth={contentWidth}
				/>
			) : (
				<SpanDrillInScene
					aiDrillIn={aiDrillIn}
					selectedSpan={selectedSpan}
					aiCallDetailState={aiCallDetailState}
					aiChatChunks={aiChatChunks}
					selectedChatChunkId={selectedChatChunkId}
					onSelectChatChunk={onSelectChatChunk}
					chatDetailChunkId={chatDetailChunkId}
					onOpenChatChunkDetail={onOpenChatChunkDetail}
					onCloseChatChunkDetail={onCloseChatChunkDetail}
					chatDetailScrollOffset={chatDetailScrollOffset}
					onSetChatDetailScrollOffset={onSetChatDetailScrollOffset}
					contentWidth={drillInContentWidth}
					bodyLines={narrowFullBodyLines}
					paneWidth={contentWidth}
					selectedAttrIndex={selectedAttrIndex}
				/>
			)}
		</>
	)
}
