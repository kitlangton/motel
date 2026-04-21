import { RGBA, TextAttributes } from "@opentui/core"
import { useAtom } from "@effect/atom-react"
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { formatTimestamp } from "./ui/format.ts"
import {
	Divider,
	FooterHints,
	HelpModal,
	PlainLine,
	SplitDivider,
	TextLine,
} from "./ui/primitives.tsx"
import { useAppLayout } from "./ui/app/useAppLayout.ts"
import { useTraceScreenData } from "./ui/app/useTraceScreenData.ts"
import { TraceWorkspace } from "./ui/app/TraceWorkspace.tsx"
import { startupBenchMark } from "./startupBench.js"
import {
	type AttrFacetState,
	attrPickerIndexAtom,
	attrPickerInputAtom,
	attrPickerModeAtom,
	attrFacetStateAtom,
	chatDetailChunkIdAtom,
	chatDetailScrollOffsetAtom,
	noticeAtom,
	persistSelectedTheme,
	selectedAttrIndexAtom,
	selectedChatChunkIdAtom,
	selectedThemeAtom,
	waterfallFilterModeAtom,
	waterfallFilterTextAtom,
} from "./ui/state.ts"
import type { ThemeName } from "./ui/theme.ts"
import { applyTheme, colors, SEPARATOR, themeLabel } from "./ui/theme.ts"
import { useKeyboardNav } from "./ui/useKeyboardNav.ts"
import { AttrFilterModal } from "./ui/AttrFilterModal.tsx"
import { useAttrFilterPicker } from "./ui/useAttrFilterPicker.ts"
import { getVisibleSpans } from "./ui/waterfallModel.ts"

const NOTICE_TIMEOUT_MS = 2500

startupBenchMark("app_module_loaded")

const buildHeaderModel = ({
	headerFooterWidth,
	selectedTraceService,
	activeAttrKey,
	activeAttrValue,
	autoRefresh,
	fetchedAt,
	status,
}: {
	readonly headerFooterWidth: number
	readonly selectedTraceService: string | null
	readonly activeAttrKey: string | null
	readonly activeAttrValue: string | null
	readonly autoRefresh: boolean
	readonly fetchedAt: Date | null
	readonly status: string
}) => {
	const serviceLabel = selectedTraceService ?? "none"
	const autoLabel = autoRefresh ? "● live" : "○ paused"
	const attrFilterLabel =
		activeAttrKey && activeAttrValue
			? `  [${activeAttrKey}=${activeAttrValue.length > 20 ? `${activeAttrValue.slice(0, 19)}…` : activeAttrValue}]`
			: ""
	const right = fetchedAt
		? `${autoLabel}  ${formatTimestamp(fetchedAt)}`
		: status === "loading"
			? "loading traces..."
			: ""
	const leftLength =
		"MOTEL".length +
		SEPARATOR.length +
		serviceLabel.length +
		attrFilterLabel.length
	const gap = Math.max(2, headerFooterWidth - leftLength - right.length)

	return {
		serviceLabel,
		attrFilterLabel,
		right,
		gap,
	} as const
}

const AppHeader = ({
	serviceLabel,
	attrFilterLabel,
	gap,
	right,
}: {
	readonly serviceLabel: string
	readonly attrFilterLabel: string
	readonly gap: number
	readonly right: string
}) => (
	<box paddingLeft={1} paddingRight={1} flexDirection="column">
		<TextLine>
			<span fg={colors.muted} attributes={TextAttributes.BOLD}>
				MOTEL
			</span>
			<span fg={colors.separator}>{SEPARATOR}</span>
			<span fg={colors.muted}>{serviceLabel}</span>
			{attrFilterLabel ? (
				<span fg={colors.accent} attributes={TextAttributes.BOLD}>
					{attrFilterLabel}
				</span>
			) : null}
			<span fg={colors.muted}>{" ".repeat(gap)}</span>
			<span fg={colors.muted} attributes={TextAttributes.BOLD}>
				{right}
			</span>
		</TextLine>
	</box>
)

const AppFooter = ({
	showSplit,
	footerHeight,
	contentWidth,
	leftPaneWidth,
	rightPaneWidth,
	footerNotice,
	spanNavActive,
	detailView,
	autoRefresh,
	headerFooterWidth,
}: {
	readonly showSplit: boolean
	readonly footerHeight: number
	readonly contentWidth: number
	readonly leftPaneWidth: number
	readonly rightPaneWidth: number
	readonly footerNotice: string | null
	readonly spanNavActive: boolean
	readonly detailView: "waterfall" | "span-detail" | "service-logs"
	readonly autoRefresh: boolean
	readonly headerFooterWidth: number
}) => {
	if (footerHeight <= 0) return null

	return (
		<>
			{showSplit ? (
				<SplitDivider
					leftWidth={leftPaneWidth}
					junction={"┴"}
					rightWidth={rightPaneWidth}
				/>
			) : (
				<Divider width={contentWidth} />
			)}
			<box
				paddingLeft={1}
				paddingRight={1}
				flexDirection="column"
				height={footerHeight}
			>
				{footerNotice ? (
					<PlainLine text={footerNotice} fg={colors.count} />
				) : (
					<FooterHints
						spanNavActive={spanNavActive}
						detailView={detailView}
						autoRefresh={autoRefresh}
						width={headerFooterWidth}
					/>
				)}
			</box>
		</>
	)
}

const AppOverlays = ({
	width,
	height,
	showHelp,
	autoRefresh,
	selectedTheme,
	setShowHelp,
	pickerMode,
	pickerInput,
	pickerIndex,
	activeAttrKey,
	attrFacets,
}: {
	readonly width: number
	readonly height: number
	readonly showHelp: boolean
	readonly autoRefresh: boolean
	readonly selectedTheme: ThemeName
	readonly setShowHelp: (value: boolean) => void
	readonly pickerMode: "off" | "keys" | "values"
	readonly pickerInput: string
	readonly pickerIndex: number
	readonly activeAttrKey: string | null
	readonly attrFacets: AttrFacetState
}) => (
	<>
		{showHelp ? (
			<HelpModal
				width={width}
				height={height}
				autoRefresh={autoRefresh}
				themeLabel={themeLabel(selectedTheme)}
				onClose={() => setShowHelp(false)}
			/>
		) : null}
		{pickerMode !== "off" ? (
			<AttrFilterModal
				width={width}
				height={height}
				mode={pickerMode}
				input={pickerInput}
				selectedIndex={pickerIndex}
				selectedKey={activeAttrKey}
				state={attrFacets}
				onClose={() => {
					/* handled via keyboard */
				}}
			/>
		) : null}
	</>
)

export const App = () => {
	startupBenchMark("app_render_started")
	const { width, height } = useTerminalDimensions()
	const [notice, setNotice] = useAtom(noticeAtom)
	const [selectedTheme] = useAtom(selectedThemeAtom)
	applyTheme(selectedTheme)
	const {
		traceState,
		traceDetailState,
		logState,
		serviceLogState,
		selectedServiceLogIndex,
		setSelectedServiceLogIndex,
		selectedTraceIndex,
		setSelectedTraceIndex,
		selectedTraceService,
		selectedSpanIndex,
		setSelectedSpanIndex,
		detailView,
		showHelp,
		setShowHelp,
		collapsedSpanIds,
		autoRefresh,
		filterMode,
		filterText,
		activeAttrKey,
		activeAttrValue,
		traceSort,
		selectedTraceSummary,
		selectedTrace,
		filteredTraces,
		aiCallDetailState,
		aiChatChunks,
	} = useTraceScreenData()
	const [pickerMode] = useAtom(attrPickerModeAtom)
	const [pickerInput] = useAtom(attrPickerInputAtom)
	const [pickerIndex] = useAtom(attrPickerIndexAtom)
	const [attrFacets] = useAtom(attrFacetStateAtom)
	const [waterfallFilterMode] = useAtom(waterfallFilterModeAtom)
	const [waterfallFilterText] = useAtom(waterfallFilterTextAtom)
	const [selectedAttrIndex] = useAtom(selectedAttrIndexAtom)
	const [selectedChatChunkId, setSelectedChatChunkId] = useAtom(
		selectedChatChunkIdAtom,
	)
	const [chatDetailChunkId, setChatDetailChunkId] = useAtom(
		chatDetailChunkIdAtom,
	)
	const [chatDetailScrollOffset, setChatDetailScrollOffset] = useAtom(
		chatDetailScrollOffsetAtom,
	)
	useAttrFilterPicker(activeAttrKey)

	const layout = useAppLayout({
		width,
		height,
		notice,
		detailView,
		selectedSpanIndex,
	})
	const {
		contentWidth,
		isWideLayout,
		viewLevel,
		footerNotice,
		footerHeight,
		leftPaneWidth,
		rightPaneWidth,
		leftContentWidth,
		headerFooterWidth,
		wideBodyLines,
		narrowBodyLines,
		traceViewportRows,
		tracePageSize,
		spanPageSize,
	} = layout

	const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const flashNotice = (message: string) => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}
		setNotice(message)
		noticeTimeoutRef.current = globalThis.setTimeout(() => {
			setNotice((current) => (current === message ? null : current))
		}, NOTICE_TIMEOUT_MS)
	}

	useEffect(
		() => () => {
			if (noticeTimeoutRef.current !== null) {
				clearTimeout(noticeTimeoutRef.current)
			}
		},
		[setNotice],
	)

	useEffect(() => {
		persistSelectedTheme(selectedTheme)
	}, [selectedTheme])

	useEffect(() => {
		startupBenchMark("app_effects_committed")
	}, [])

	const { spanNavActive } = useKeyboardNav({
		selectedTrace,
		filteredTraces,
		aiChatChunks,
		isWideLayout,
		wideBodyLines,
		narrowBodyLines,
		tracePageSize,
		spanPageSize,
		flashNotice,
	})

	const headerModel = buildHeaderModel({
		headerFooterWidth,
		selectedTraceService,
		activeAttrKey,
		activeAttrValue,
		autoRefresh,
		fetchedAt: traceState.fetchedAt,
		status: traceState.status,
	})

	const selectTraceById = useCallback(
		(traceId: string) => {
			const index = traceState.data.findIndex(
				(trace) => trace.traceId === traceId,
			)
			if (index >= 0) setSelectedTraceIndex(index)
		},
		[setSelectedTraceIndex, traceState.data],
	)

	const visibleSpans = useMemo(
		() =>
			selectedTrace
				? getVisibleSpans(selectedTrace.spans, collapsedSpanIds)
				: [],
		[selectedTrace, collapsedSpanIds],
	)

	const openChatChunkDetail = useCallback(
		(chunkId: string) => {
			setSelectedChatChunkId(chunkId)
			setChatDetailChunkId(chunkId)
			setChatDetailScrollOffset(0)
		},
		[setSelectedChatChunkId, setChatDetailChunkId, setChatDetailScrollOffset],
	)

	const closeChatChunkDetail = useCallback(() => {
		setChatDetailChunkId(null)
		setChatDetailScrollOffset(0)
	}, [setChatDetailChunkId, setChatDetailScrollOffset])

	const selectSpan = useCallback(
		(index: number) => {
			if (visibleSpans.length === 0) return
			setSelectedSpanIndex(
				Math.max(0, Math.min(index, visibleSpans.length - 1)),
			)
		},
		[setSelectedSpanIndex, visibleSpans],
	)

	const traceListProps = useMemo(
		() =>
			({
				traces: filteredTraces,
				selectedTraceId: selectedTraceSummary?.traceId ?? null,
				status: traceState.status,
				error: traceState.error,
				contentWidth: leftContentWidth,
				services: traceState.services,
				selectedService: selectedTraceService,
				focused: !spanNavActive,
				filterText: filterText || undefined,
				sortMode: traceSort,
				totalCount: filterText ? traceState.data.length : undefined,
				onSelectTrace: selectTraceById,
			}) as const,
		[
			filteredTraces,
			selectedTraceSummary?.traceId,
			traceState.status,
			traceState.error,
			leftContentWidth,
			traceState.services,
			selectedTraceService,
			spanNavActive,
			filterText,
			traceSort,
			traceState.data.length,
			selectTraceById,
		],
	)

	const selectedSpan =
		selectedSpanIndex !== null
			? (visibleSpans[selectedSpanIndex] ?? null)
			: null
	const selectedSpanLogs = useMemo(
		() =>
			selectedSpan
				? logState.data.filter((log) => log.spanId === selectedSpan.spanId)
				: [],
		[selectedSpan, logState.data],
	)

	// Top/bottom frame dividers only render junction glyphs (`┬` / `┴`)
	// when there's actually a vertical SeparatorColumn in the workspace
	// below/above them to meet. Service-logs view is wide but single-pane,
	// so its frame dividers must be plain — otherwise the junction floats
	// above an empty column and leaves a visible stale sliver when
	// toggling tab back and forth with the trace view.
	const showSplit = isWideLayout && detailView !== "service-logs"
	startupBenchMark("app_render_ready")

	return (
		<box
			width={width ?? 100}
			height={height ?? 24}
			flexGrow={1}
			flexDirection="column"
			backgroundColor={RGBA.fromHex(colors.screenBg)}
		>
			<AppHeader {...headerModel} />
			{showSplit ? (
				<SplitDivider
					leftWidth={leftPaneWidth}
					junction={"┬"}
					rightWidth={rightPaneWidth}
				/>
			) : (
				<Divider width={contentWidth} />
			)}
			<TraceWorkspace
				layout={layout}
				detailView={detailView}
				filterMode={filterMode}
				filterText={filterText}
				waterfallFilterMode={waterfallFilterMode}
				waterfallFilterText={waterfallFilterText}
				traceListProps={traceListProps}
				selectedTraceService={selectedTraceService}
				serviceLogState={serviceLogState}
				selectedServiceLogIndex={selectedServiceLogIndex}
				setSelectedServiceLogIndex={setSelectedServiceLogIndex}
				traceDetailState={traceDetailState}
				selectedTrace={selectedTrace}
				selectedTraceSummary={selectedTraceSummary}
				logState={logState}
				selectedSpanIndex={selectedSpanIndex}
				collapsedSpanIds={collapsedSpanIds}
				viewLevel={viewLevel}
				selectedSpan={selectedSpan}
				selectedSpanLogs={selectedSpanLogs}
				selectedAttrIndex={selectedAttrIndex}
				aiCallDetailState={aiCallDetailState}
				aiChatChunks={aiChatChunks}
				selectedChatChunkId={selectedChatChunkId}
				onSelectChatChunk={setSelectedChatChunkId}
				chatDetailChunkId={chatDetailChunkId}
				onOpenChatChunkDetail={openChatChunkDetail}
				onCloseChatChunkDetail={closeChatChunkDetail}
				chatDetailScrollOffset={chatDetailScrollOffset}
				onSetChatDetailScrollOffset={(updater) =>
					setChatDetailScrollOffset(updater)
				}
				selectSpan={selectSpan}
			/>
			<AppFooter
				showSplit={showSplit}
				footerHeight={footerHeight}
				contentWidth={contentWidth}
				leftPaneWidth={leftPaneWidth}
				rightPaneWidth={rightPaneWidth}
				footerNotice={footerNotice}
				spanNavActive={spanNavActive}
				detailView={detailView}
				autoRefresh={autoRefresh}
				headerFooterWidth={headerFooterWidth}
			/>
			<AppOverlays
				width={width ?? 100}
				height={height ?? 24}
				showHelp={showHelp}
				autoRefresh={autoRefresh}
				selectedTheme={selectedTheme}
				setShowHelp={setShowHelp}
				pickerMode={pickerMode}
				pickerInput={pickerInput}
				pickerIndex={pickerIndex}
				activeAttrKey={activeAttrKey}
				attrFacets={attrFacets}
			/>
		</box>
	)
}
