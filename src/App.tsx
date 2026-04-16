import type { ScrollBoxRenderable } from "@opentui/core"
import { useAtom } from "@effect/atom-react"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useLayoutEffect, useRef } from "react"
import { config } from "./config.js"
import { fitCell, formatShortDate, formatTimestamp, traceRowId } from "./ui/format.ts"
import { AlignedHeaderLine, BlankRow, Divider, FilterBar, FooterHints, PlainLine, SeparatorColumn, TextLine } from "./ui/primitives.tsx"
import { ServiceLogsView } from "./ui/ServiceLogs.tsx"
import {
	autoRefreshAtom,
	collapsedSpanIdsAtom,
	detailViewAtom,
	filterModeAtom,
	filterTextAtom,
	initialTraceDetailState,
	traceSortAtom,
	initialLogState,
	initialServiceLogState,
	loadRecentTraceSummaries,
	loadTraceDetail,
	loadServiceLogs,
	loadTraceLogs,
	loadTraceServices,
	logStateAtom,
	noticeAtom,
	persistSelectedService,
	refreshNonceAtom,
	selectedServiceLogIndexAtom,
	selectedSpanIndexAtom,
	selectedTraceIndexAtom,
	selectedTraceServiceAtom,
	serviceLogStateAtom,
	showHelpAtom,
	traceDetailStateAtom,
	traceStateAtom,
} from "./ui/state.ts"
import { colors, SEPARATOR } from "./ui/theme.ts"
import { TraceDetailsPane } from "./ui/TraceDetailsPane.tsx"
import { getVisibleSpans } from "./ui/Waterfall.tsx"
import { TraceList } from "./ui/TraceList.tsx"
import { useKeyboardNav } from "./ui/useKeyboardNav.ts"

export const App = () => {
	const { width, height } = useTerminalDimensions()
	const [traceState, setTraceState] = useAtom(traceStateAtom)
	const [traceDetailState, setTraceDetailState] = useAtom(traceDetailStateAtom)
	const [logState, setLogState] = useAtom(logStateAtom)
	const [serviceLogState, setServiceLogState] = useAtom(serviceLogStateAtom)
	const [selectedServiceLogIndex, setSelectedServiceLogIndex] = useAtom(selectedServiceLogIndexAtom)
	const [selectedTraceIndex, setSelectedTraceIndex] = useAtom(selectedTraceIndexAtom)
	const [selectedTraceService, setSelectedTraceService] = useAtom(selectedTraceServiceAtom)
	const [refreshNonce, setRefreshNonce] = useAtom(refreshNonceAtom)
	const [notice, setNotice] = useAtom(noticeAtom)
	const [selectedSpanIndex, setSelectedSpanIndex] = useAtom(selectedSpanIndexAtom)
	const [detailView, setDetailView] = useAtom(detailViewAtom)
	const [showHelp, setShowHelp] = useAtom(showHelpAtom)
	const [collapsedSpanIds, setCollapsedSpanIds] = useAtom(collapsedSpanIdsAtom)
	const [autoRefresh] = useAtom(autoRefreshAtom)
	const [filterMode] = useAtom(filterModeAtom)
	const [filterText] = useAtom(filterTextAtom)
	const [traceSort] = useAtom(traceSortAtom)

	// Layout calculations
	const contentWidth = Math.max(60, width ?? 100)
	const isWideLayout = (width ?? 100) >= 140
	const splitGap = 1
	const sectionPadding = 1
	const traceListHeaderHeight = 1
	const footerNotice = notice ? fitCell(notice, Math.max(24, Math.max(60, width ?? 100) - 2)) : null
	const footerHeight = footerNotice ? 1 : 2
	const footerFrameHeight = footerHeight > 0 ? 1 + footerHeight : 0
	const frameHeight = 1 + 1 + footerFrameHeight
	const availableContentHeight = Math.max(10, (height ?? 24) - frameHeight)
	const leftPaneWidth = isWideLayout ? Math.max(44, Math.floor((contentWidth - splitGap) * 0.38)) : contentWidth
	const rightPaneWidth = isWideLayout ? Math.max(28, contentWidth - leftPaneWidth - splitGap) : contentWidth
	
	const leftContentWidth = isWideLayout ? Math.max(24, leftPaneWidth - 3) : Math.max(24, contentWidth - sectionPadding * 2)
	const rightContentWidth = isWideLayout ? Math.max(24, rightPaneWidth - sectionPadding * 2) : Math.max(24, contentWidth - sectionPadding * 2)
	const headerFooterWidth = Math.max(24, contentWidth - 2)
	const wideBodyHeight = availableContentHeight
	const wideBodyLines = Math.max(8, wideBodyHeight - 5)
	const narrowSplitHeight = Math.max(10, availableContentHeight - 1)
	const narrowListHeight = Math.max(4, Math.min(10, Math.floor(narrowSplitHeight * 0.4), narrowSplitHeight - 9))
	const narrowDetailHeight = narrowSplitHeight - narrowListHeight
	const narrowBodyLines = Math.max(2, narrowDetailHeight - 5)
	const wideTraceListBodyHeight = Math.max(1, wideBodyHeight - traceListHeaderHeight)
	const narrowTraceListBodyHeight = Math.max(1, narrowListHeight - traceListHeaderHeight)
	const traceViewportRows = isWideLayout ? wideTraceListBodyHeight : narrowTraceListBodyHeight
	const tracePageSize = Math.max(1, traceViewportRows - 1)
	const spanViewportRows = Math.max(1, (isWideLayout ? wideBodyLines : narrowBodyLines) - 1)
	const spanPageSize = Math.max(1, spanViewportRows - 1)

	// Refs
	const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const traceListScrollRef = useRef<ScrollBoxRenderable | null>(null)
	const selectedTraceRef = useRef<string | null>(null)

	const flashNotice = (message: string) => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}
		setNotice(message)
		noticeTimeoutRef.current = globalThis.setTimeout(() => {
			setNotice((current) => (current === message ? null : current))
		}, 2500)
	}

	// Cleanup timeouts
	useEffect(() => () => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}
	}, [])

	useEffect(() => {
		if (selectedTraceService) persistSelectedService(selectedTraceService)
	}, [selectedTraceService])

	// Auto-refresh every 5 seconds
	useEffect(() => {
		if (!autoRefresh) return
		const id = setInterval(() => setRefreshNonce((n) => n + 1), 5000)
		return () => clearInterval(id)
	}, [autoRefresh])

	// Load traces
	useEffect(() => {
		let cancelled = false

		const load = async () => {
			setTraceState((current) => ({
				...current,
				status: current.fetchedAt === null ? "loading" : "ready",
				error: null,
			}))

			try {
				const services = await loadTraceServices()
				if (cancelled) return

				const effectiveService = services.includes(selectedTraceService ?? "")
					? selectedTraceService
					: selectedTraceService ?? services[0] ?? config.otel.serviceName

				if (effectiveService !== selectedTraceService) {
					setSelectedTraceService(effectiveService)
				}

				const traces = effectiveService ? await loadRecentTraceSummaries(effectiveService) : []
				if (cancelled) return

				// Preserve selection by trace ID across refreshes
				const prevTraceId = selectedTraceRef.current
				setTraceState({
					status: "ready",
					services,
					data: traces,
					error: null,
					fetchedAt: new Date(),
				})
				if (prevTraceId) {
					const newIndex = traces.findIndex((t) => t.traceId === prevTraceId)
					if (newIndex >= 0) setSelectedTraceIndex(newIndex)
				}
			} catch (error) {
				if (cancelled) return
				setTraceState((current) => ({
					...current,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				}))
			}
		}

		void load()

		return () => {
			cancelled = true
		}
	}, [refreshNonce, selectedTraceService])

	// Clamp trace index
	useEffect(() => {
		setSelectedTraceIndex((current) => {
			if (traceState.data.length === 0) return 0
			return Math.max(0, Math.min(current, traceState.data.length - 1))
		})
	}, [traceState.data.length])

	const selectedTraceSummary = traceState.data[selectedTraceIndex] ?? null
	const selectedTraceId = selectedTraceSummary?.traceId ?? null
	const selectedTrace = traceDetailState.traceId === selectedTraceId ? traceDetailState.data : null
	selectedTraceRef.current = selectedTraceId

	useEffect(() => {
		if (!selectedTraceId) {
			setTraceDetailState(initialTraceDetailState)
			return
		}

		let cancelled = false

		const load = async () => {
			setTraceDetailState((current) => ({
				status: current.traceId === selectedTraceId && current.fetchedAt !== null ? "ready" : "loading",
				traceId: selectedTraceId,
				data: current.traceId === selectedTraceId ? current.data : null,
				error: null,
				fetchedAt: current.traceId === selectedTraceId ? current.fetchedAt : null,
			}))

			try {
				const trace = await loadTraceDetail(selectedTraceId)
				if (cancelled) return

				setTraceDetailState({
					status: "ready",
					traceId: selectedTraceId,
					data: trace,
					error: null,
					fetchedAt: new Date(),
				})
			} catch (error) {
				if (cancelled) return
				setTraceDetailState({
					status: "error",
					traceId: selectedTraceId,
					data: null,
					error: error instanceof Error ? error.message : String(error),
					fetchedAt: null,
				})
			}
		}

		void load()

		return () => {
			cancelled = true
		}
	}, [refreshNonce, selectedTraceId, setTraceDetailState])

	// Reset collapsed spans and span selection when trace changes
	useEffect(() => {
		setCollapsedSpanIds(new Set())
		setSelectedSpanIndex(null)
	}, [selectedTraceId])

	// Clamp span index against visible (filtered) span count
	useEffect(() => {
		if (selectedSpanIndex === null) return
		if (!selectedTrace || selectedTrace.spans.length === 0) {
			setSelectedSpanIndex(null)
			setDetailView("waterfall")
			return
		}
		const visibleCount = getVisibleSpans(selectedTrace.spans, collapsedSpanIds).length
		if (selectedSpanIndex >= visibleCount) {
			setSelectedSpanIndex(visibleCount - 1)
		}
	}, [selectedTrace, selectedSpanIndex, collapsedSpanIds, setSelectedSpanIndex, setDetailView])

	// Scroll selected trace into view (use summary ID, not detail which loads async)
	useLayoutEffect(() => {
		const traceId = selectedTraceSummary?.traceId
		if (!traceId) return
		traceListScrollRef.current?.scrollChildIntoView(traceRowId(traceId))
	}, [selectedTraceIndex, selectedTraceSummary?.traceId, filterText])

	// Load trace logs
	useEffect(() => {
		const traceId = selectedTraceId
		if (!traceId) {
			setLogState(initialLogState)
			return
		}

		let cancelled = false

		const load = async () => {
			setLogState((current) => ({
				status: current.traceId === traceId && current.fetchedAt !== null ? "ready" : "loading",
				traceId,
				data: current.traceId === traceId ? current.data : [],
				error: null,
				fetchedAt: current.traceId === traceId ? current.fetchedAt : null,
			}))

			try {
				const logs = await loadTraceLogs(traceId)
				if (cancelled) return

				setLogState({
					status: "ready",
					traceId,
					data: logs,
					error: null,
					fetchedAt: new Date(),
				})
			} catch (error) {
				if (cancelled) return
				setLogState({
					status: "error",
					traceId,
					data: [],
					error: error instanceof Error ? error.message : String(error),
					fetchedAt: null,
				})
			}
		}

		void load()

		return () => {
			cancelled = true
		}
	}, [refreshNonce, selectedTraceId, setLogState])

	// Load service logs
	useEffect(() => {
		if (detailView !== "service-logs") return

		const serviceName = selectedTraceService
		if (!serviceName) {
			setServiceLogState(initialServiceLogState)
			return
		}

		let cancelled = false

		const load = async () => {
			setServiceLogState((current) => ({
				status: current.serviceName === serviceName && current.fetchedAt !== null ? "ready" : "loading",
				serviceName,
				data: current.serviceName === serviceName ? current.data : [],
				error: null,
				fetchedAt: current.serviceName === serviceName ? current.fetchedAt : null,
			}))

			try {
				const logs = await loadServiceLogs(serviceName)
				if (cancelled) return

				setServiceLogState({
					status: "ready",
					serviceName,
					data: logs,
					error: null,
					fetchedAt: new Date(),
				})
			} catch (error) {
				if (cancelled) return
				setServiceLogState({
					status: "error",
					serviceName,
					data: [],
					error: error instanceof Error ? error.message : String(error),
					fetchedAt: null,
				})
			}
		}

		void load()

		return () => {
			cancelled = true
		}
	}, [detailView, refreshNonce, selectedTraceService, setServiceLogState])

	// Clamp service log index
	useEffect(() => {
		setSelectedServiceLogIndex((current) => {
			if (serviceLogState.data.length === 0) return 0
			return Math.max(0, Math.min(current, serviceLogState.data.length - 1))
		})
	}, [serviceLogState.data.length, setSelectedServiceLogIndex])

	// Apply trace filter
	const preFilterTraces = filterText
		? traceState.data.filter((trace) => {
			const needle = filterText.toLowerCase()
			const errorOnly = needle.includes(":error")
			const textNeedle = needle.replace(":error", "").trim()
			if (errorOnly && trace.errorCount === 0) return false
			if (textNeedle && !trace.rootOperationName.toLowerCase().includes(textNeedle)) return false
			return true
		})
		: traceState.data

	// Apply sort (default is recent, which is the server's order)
	const filteredTraces = traceSort === "recent"
		? preFilterTraces
		: [...preFilterTraces].sort((a, b) => {
			if (traceSort === "slowest") return b.durationMs - a.durationMs
			if (traceSort === "fastest") return a.durationMs - b.durationMs
			if (traceSort === "errors") return b.errorCount - a.errorCount || b.startedAt.getTime() - a.startedAt.getTime()
			return 0
		})

	// Keyboard navigation
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

	// Header
	const autoLabel = autoRefresh ? "\u25cf live" : "\u25cb paused"
	const headerLeft = `MOTEL  service: ${selectedTraceService ?? "none"}`
	const headerRight = traceState.fetchedAt
		? `${autoLabel}  ${formatTimestamp(traceState.fetchedAt)}`
		: traceState.status === "loading"
			? "loading traces..."
			: ""
	const headerLine = `${fitCell(headerLeft, Math.max(0, headerFooterWidth - headerRight.length))}${headerRight}`
	const visibleFooterNotice = footerNotice ? fitCell(footerNotice.trimEnd(), headerFooterWidth) : null

	const selectTraceById = (traceId: string) => {
		const index = traceState.data.findIndex((trace) => trace.traceId === traceId)
		if (index >= 0) setSelectedTraceIndex(index)
	}

	const selectSpan = (index: number) => {
		if (!selectedTrace) return
		const visibleCount = getVisibleSpans(selectedTrace.spans, collapsedSpanIds).length
		setSelectedSpanIndex(Math.max(0, Math.min(index, visibleCount - 1)))
	}

	const traceListProps = {
		traces: filteredTraces,
		selectedTraceId,
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
	} as const

	return (
		<box flexGrow={1} flexDirection="column">
			<box paddingLeft={1} paddingRight={1} flexDirection="column">
				<PlainLine text={headerLine} fg={colors.muted} bold />
			</box>
			<Divider width={contentWidth} />
			{detailView === "service-logs" ? (
				<box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
					<AlignedHeaderLine
						left="SERVICE LOGS"
						right={`${serviceLogState.data.length} logs${serviceLogState.fetchedAt ? `${SEPARATOR}${formatShortDate(serviceLogState.fetchedAt)} ${formatTimestamp(serviceLogState.fetchedAt)}` : ""}`}
						width={headerFooterWidth}
						rightFg={colors.count}
					/>
					<TextLine>
						<span fg={colors.defaultService}>{selectedTraceService ?? "unknown"}</span>
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
			) : isWideLayout ? (
				<box flexGrow={1} flexDirection="row">
					<box width={leftPaneWidth} height={wideBodyHeight} flexDirection="column" paddingLeft={sectionPadding} paddingRight={sectionPadding}>
						<TraceList showHeader {...traceListProps} />
						{filterMode ? <FilterBar text={filterText} width={leftContentWidth} /> : null}
						<scrollbox ref={traceListScrollRef} height={filterMode ? wideTraceListBodyHeight - 1 : wideTraceListBodyHeight} flexGrow={0}>
							<TraceList showHeader={false} {...traceListProps} />
						</scrollbox>
					</box>
					<SeparatorColumn height={wideBodyHeight} />
					<box width={rightPaneWidth} height={wideBodyHeight} flexDirection="column">
						<TraceDetailsPane trace={selectedTrace} traceLogsState={logState} contentWidth={rightContentWidth} bodyLines={wideBodyLines} paneWidth={rightPaneWidth} selectedSpanIndex={selectedSpanIndex} collapsedSpanIds={collapsedSpanIds} detailView={detailView} focused={spanNavActive} onSelectSpan={selectSpan} />
					</box>
				</box>
			) : (
				<>
					<TraceDetailsPane trace={selectedTrace} traceLogsState={logState} contentWidth={rightContentWidth} bodyLines={narrowBodyLines} paneWidth={contentWidth} selectedSpanIndex={selectedSpanIndex} collapsedSpanIds={collapsedSpanIds} detailView={detailView} focused={spanNavActive} onSelectSpan={selectSpan} />
					<Divider width={contentWidth} />
					<box height={narrowListHeight} flexDirection="column" paddingLeft={sectionPadding} paddingRight={sectionPadding}>
						<TraceList showHeader {...traceListProps} />
						{filterMode ? <FilterBar text={filterText} width={leftContentWidth} /> : null}
						<scrollbox ref={traceListScrollRef} height={filterMode ? narrowTraceListBodyHeight - 1 : narrowTraceListBodyHeight} flexGrow={0}>
							<TraceList showHeader={false} {...traceListProps} />
						</scrollbox>
					</box>
				</>
			)}
			{footerHeight > 0 ? (
				<>
					<Divider width={contentWidth} />
					<box paddingLeft={1} paddingRight={1} flexDirection="column" height={footerHeight}>
						{visibleFooterNotice ? (
							<PlainLine text={visibleFooterNotice} fg={colors.count} />
						) : (
							<FooterHints spanNavActive={spanNavActive} detailView={detailView} autoRefresh={autoRefresh} width={headerFooterWidth} />
						)}
					</box>
				</>
			) : null}
		</box>
	)
}
