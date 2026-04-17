import { RGBA, TextAttributes } from "@opentui/core"
import { useAtom } from "@effect/atom-react"
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { formatTimestamp } from "./ui/format.ts"
import { Divider, FooterHints, HelpModal, PlainLine, SplitDivider, TextLine } from "./ui/primitives.tsx"
import { useAppLayout } from "./ui/app/useAppLayout.ts"
import { useTraceScreenData } from "./ui/app/useTraceScreenData.ts"
import { TraceWorkspace } from "./ui/app/TraceWorkspace.tsx"
import {
	attrPickerIndexAtom,
	attrPickerInputAtom,
	attrPickerModeAtom,
	attrFacetStateAtom,
	noticeAtom,
	persistSelectedTheme,
	selectedThemeAtom,
	waterfallFilterModeAtom,
	waterfallFilterTextAtom,
} from "./ui/state.ts"
import { applyTheme, colors, SEPARATOR, themeLabel } from "./ui/theme.ts"
import { getVisibleSpans } from "./ui/Waterfall.tsx"
import { useKeyboardNav } from "./ui/useKeyboardNav.ts"
import { AttrFilterModal } from "./ui/AttrFilterModal.tsx"
import { useAttrFilterPicker } from "./ui/useAttrFilterPicker.ts"

export const App = () => {
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
	} = useTraceScreenData()
	const [pickerMode] = useAtom(attrPickerModeAtom)
	const [pickerInput] = useAtom(attrPickerInputAtom)
	const [pickerIndex] = useAtom(attrPickerIndexAtom)
	const [attrFacets] = useAtom(attrFacetStateAtom)
	const [waterfallFilterMode] = useAtom(waterfallFilterModeAtom)
	const [waterfallFilterText] = useAtom(waterfallFilterTextAtom)
	useAttrFilterPicker(activeAttrKey)

	const layout = useAppLayout({ width, height, notice, detailView, selectedSpanIndex })
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
		}, 2500)
	}

	useEffect(() => () => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}
	}, [setNotice])

	useEffect(() => {
		persistSelectedTheme(selectedTheme)
	}, [selectedTheme])

	const { spanNavActive } = useKeyboardNav({
		selectedTrace,
		filteredTraces,
		isWideLayout,
		wideBodyLines,
		narrowBodyLines,
		tracePageSize,
		spanPageSize,
		flashNotice,
	})

	const headerServiceLabel = selectedTraceService ?? "none"
	const autoLabel = autoRefresh ? "● live" : "○ paused"
	const attrFilterLabel = activeAttrKey && activeAttrValue
		? `  [${activeAttrKey}=${activeAttrValue.length > 20 ? `${activeAttrValue.slice(0, 19)}…` : activeAttrValue}]`
		: ""
	const headerRight = traceState.fetchedAt
		? `${autoLabel}  ${formatTimestamp(traceState.fetchedAt)}`
		: traceState.status === "loading"
			? "loading traces..."
			: ""
	const headerLeftLen = "MOTEL".length + SEPARATOR.length + headerServiceLabel.length + attrFilterLabel.length
	const headerGap = Math.max(2, headerFooterWidth - headerLeftLen - headerRight.length)
	const visibleFooterNotice = footerNotice

	const selectTraceById = useCallback((traceId: string) => {
		const index = traceState.data.findIndex((trace) => trace.traceId === traceId)
		if (index >= 0) setSelectedTraceIndex(index)
	}, [setSelectedTraceIndex, traceState.data])

	const selectSpan = useCallback((index: number) => {
		if (!selectedTrace) return
		const visibleCount = getVisibleSpans(selectedTrace.spans, collapsedSpanIds).length
		setSelectedSpanIndex(Math.max(0, Math.min(index, visibleCount - 1)))
	}, [collapsedSpanIds, selectedTrace, setSelectedSpanIndex])

	const traceListProps = useMemo(() => ({
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
	} as const), [filteredTraces, selectedTraceSummary?.traceId, traceState.status, traceState.error, leftContentWidth, traceState.services, selectedTraceService, spanNavActive, filterText, traceSort, traceState.data.length, selectTraceById])

	const filteredSpans = selectedTrace ? getVisibleSpans(selectedTrace.spans, collapsedSpanIds) : []
	const selectedSpan = selectedSpanIndex !== null ? filteredSpans[selectedSpanIndex] ?? null : null
	const selectedSpanLogs = useMemo(
		() => selectedSpan ? logState.data.filter((log) => log.spanId === selectedSpan.spanId) : [],
		[selectedSpan, logState.data],
	)

	// Top/bottom frame dividers only render junction glyphs (`┬` / `┴`)
	// when there's actually a vertical SeparatorColumn in the workspace
	// below/above them to meet. Service-logs view is wide but single-pane,
	// so its frame dividers must be plain — otherwise the junction floats
	// above an empty column and leaves a visible stale sliver when
	// toggling tab back and forth with the trace view.
	const showSplit = isWideLayout && detailView !== "service-logs"

	return (
		<box width={width ?? 100} height={height ?? 24} flexGrow={1} flexDirection="column" backgroundColor={RGBA.fromHex(colors.screenBg)}>
			<box paddingLeft={1} paddingRight={1} flexDirection="column">
				<TextLine>
					<span fg={colors.muted} attributes={TextAttributes.BOLD}>MOTEL</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={colors.muted}>{headerServiceLabel}</span>
					{attrFilterLabel ? <span fg={colors.accent} attributes={TextAttributes.BOLD}>{attrFilterLabel}</span> : null}
					<span fg={colors.muted}>{" ".repeat(headerGap)}</span>
					<span fg={colors.muted} attributes={TextAttributes.BOLD}>{headerRight}</span>
				</TextLine>
			</box>
			{showSplit
				? <SplitDivider leftWidth={leftPaneWidth} junction={"┬"} rightWidth={rightPaneWidth} />
				: <Divider width={contentWidth} />}
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
				selectSpan={selectSpan}
			/>
			{footerHeight > 0 ? (
				<>
					{showSplit
						? <SplitDivider leftWidth={leftPaneWidth} junction={"┴"} rightWidth={rightPaneWidth} />
						: <Divider width={contentWidth} />}
					<box paddingLeft={1} paddingRight={1} flexDirection="column" height={footerHeight}>
						{visibleFooterNotice ? (
							<PlainLine text={visibleFooterNotice} fg={colors.count} />
						) : (
							<FooterHints spanNavActive={spanNavActive} detailView={detailView} autoRefresh={autoRefresh} width={headerFooterWidth} />
						)}
					</box>
				</>
			) : null}
			{showHelp ? <HelpModal width={width ?? 100} height={height ?? 24} autoRefresh={autoRefresh} themeLabel={themeLabel(selectedTheme)} onClose={() => setShowHelp(false)} /> : null}
			{pickerMode !== "off" ? (
				<AttrFilterModal
					width={width ?? 100}
					height={height ?? 24}
					mode={pickerMode}
					input={pickerInput}
					selectedIndex={pickerIndex}
					selectedKey={activeAttrKey}
					state={attrFacets}
					onClose={() => { /* handled via keyboard */ }}
				/>
			) : null}
		</box>
	)
}
