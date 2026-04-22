import { useAtom } from "@effect/atom-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { config } from "../../config.js"
import type { LogItem, TraceItem, TraceSummaryItem } from "../../domain.ts"
import {
	activeAttrKeyAtom,
	activeAttrValueAtom,
	aiCallDetailStateAtom,
	autoRefreshAtom,
	chatDetailChunkIdAtom,
	chatDetailScrollOffsetAtom,
	collapsedSpanIdsAtom,
	detailViewAtom,
	ensureAiCallDetail,
	ensureTraceAttributeKeys,
	filterModeAtom,
	filterTextAtom,
	getCachedAiCallDetail,
	initialAiCallDetailState,
	initialLogState,
	initialServiceLogState,
	initialTraceDetailState,
	invalidateAiCallDetailCache,
	loadFilteredTraceSummaries,
	loadRecentTraceSummaries,
	loadServiceLogs,
	loadTraceDetail,
	loadTraceLogs,
	loadTraceServices,
	logStateAtom,
	persistSelectedService,
	refreshNonceAtom,
	selectedAttrIndexAtom,
	selectedChatChunkIdAtom,
	selectedServiceLogIndexAtom,
	selectedSpanIndexAtom,
	selectedTraceIndexAtom,
	selectedTraceServiceAtom,
	serviceLogStateAtom,
	showHelpAtom,
	traceDetailStateAtom,
	type TraceSortMode,
	traceSortAtom,
	traceStateAtom,
} from "../state.ts"
import { isAiSpan } from "../../domain.ts"
import { buildChunks, type Chunk } from "../aiChatModel.ts"
import { parseFilterText } from "../filterParser.ts"
import { getVisibleSpans } from "../waterfallModel.ts"
import { Cause, Effect, Schedule } from "effect"

const clampSelectionIndex = (index: number, length: number) => {
	if (length === 0) return 0
	return Math.max(0, Math.min(index, length - 1))
}

const resolveEffectiveService = (
	services: readonly string[],
	selectedTraceService: string | null,
) =>
	services.includes(selectedTraceService ?? "")
		? selectedTraceService
		: (services[0] ?? config.otel.serviceName)

const loadTraceSummariesForService = (
	serviceName: string | null,
	filters: {
		readonly activeAttrKey: string | null
		readonly activeAttrValue: string | null
		readonly debouncedAiText: string | null
	},
) => {
	if (!serviceName) return Promise.resolve([] as readonly TraceSummaryItem[])
	const hasAttrFilter = Boolean(
		filters.activeAttrKey && filters.activeAttrValue,
	)
	const hasAiFilter = Boolean(filters.debouncedAiText)
	if (!hasAttrFilter && !hasAiFilter)
		return loadRecentTraceSummaries(serviceName)
	return loadFilteredTraceSummaries(serviceName, {
		attributeFilters: hasAttrFilter
			? { [filters.activeAttrKey as string]: filters.activeAttrValue as string }
			: undefined,
		aiText: hasAiFilter ? filters.debouncedAiText : null,
	})
}

const applyClientTraceFilters = (
	traces: readonly TraceSummaryItem[],
	filterText: string,
	parsedFilter: ReturnType<typeof parseFilterText>,
) =>
	filterText
		? traces.filter((trace) => {
				if (parsedFilter.errorOnly && trace.errorCount === 0) return false
				if (
					parsedFilter.operationNeedle &&
					!trace.rootOperationName
						.toLowerCase()
						.includes(parsedFilter.operationNeedle)
				)
					return false
				return true
			})
		: traces

const sortTraceSummaries = (
	traces: readonly TraceSummaryItem[],
	traceSort: TraceSortMode,
) => {
	if (traceSort === "recent") return traces
	return [...traces].sort((a, b) => {
		if (traceSort === "slowest") return b.durationMs - a.durationMs
		if (traceSort === "errors")
			return (
				b.errorCount - a.errorCount ||
				b.startedAt.getTime() - a.startedAt.getTime()
			)
		return 0
	})
}

const getSelectedVisibleSpan = (
	spans: readonly TraceItem["spans"][number][],
	selectedSpanIndex: number | null,
) => (selectedSpanIndex === null ? null : (spans[selectedSpanIndex] ?? null))

export const useTraceScreenData = () => {
	const [traceState, setTraceState] = useAtom(traceStateAtom)
	const [traceDetailState, setTraceDetailState] = useAtom(traceDetailStateAtom)
	const [logState, setLogState] = useAtom(logStateAtom)
	const [serviceLogState, setServiceLogState] = useAtom(serviceLogStateAtom)
	const [selectedServiceLogIndex, setSelectedServiceLogIndex] = useAtom(
		selectedServiceLogIndexAtom,
	)
	const [selectedTraceIndex, setSelectedTraceIndex] = useAtom(
		selectedTraceIndexAtom,
	)
	const [selectedTraceService, setSelectedTraceService] = useAtom(
		selectedTraceServiceAtom,
	)
	const [refreshNonce, setRefreshNonce] = useAtom(refreshNonceAtom)
	const [selectedSpanIndex, setSelectedSpanIndex] = useAtom(
		selectedSpanIndexAtom,
	)
	const [, setSelectedAttrIndex] = useAtom(selectedAttrIndexAtom)
	const [, setChatDetailChunkId] = useAtom(chatDetailChunkIdAtom)
	const [, setChatDetailScrollOffset] = useAtom(chatDetailScrollOffsetAtom)
	const [selectedChatChunkId, setSelectedChatChunkId] = useAtom(
		selectedChatChunkIdAtom,
	)
	const [aiCallDetailState, setAiCallDetailState] = useAtom(
		aiCallDetailStateAtom,
	)
	const [detailView, setDetailView] = useAtom(detailViewAtom)
	const [showHelp, setShowHelp] = useAtom(showHelpAtom)
	const [collapsedSpanIds, setCollapsedSpanIds] = useAtom(collapsedSpanIdsAtom)
	const [autoRefresh] = useAtom(autoRefreshAtom)
	const [filterMode] = useAtom(filterModeAtom)
	const [filterText] = useAtom(filterTextAtom)
	const [activeAttrKey] = useAtom(activeAttrKeyAtom)
	const [activeAttrValue] = useAtom(activeAttrValueAtom)
	const [traceSort] = useAtom(traceSortAtom)

	// `:ai <query>` is parsed out of the filter text and debounced so
	// typing doesn't hammer FTS. The other modifiers (:error, operation
	// needle) stay client-side since we already have those on trace
	// summaries. 250ms feels responsive without firing on every keystroke.
	const parsedFilter = useMemo(() => parseFilterText(filterText), [filterText])
	const [debouncedAiText, setDebouncedAiText] = useState<string | null>(
		parsedFilter.aiText,
	)
	useEffect(() => {
		const handle = setTimeout(
			() => setDebouncedAiText(parsedFilter.aiText),
			250,
		)
		return () => clearTimeout(handle)
	}, [parsedFilter.aiText])

	const selectedTraceRef = useRef<string | null>(null)
	const cacheEpochRef = useRef(0)
	const traceDetailCacheRef = useRef(
		new Map<string, { data: TraceItem | null; fetchedAt: Date }>(),
	)
	const traceLogCacheRef = useRef(
		new Map<string, { data: readonly LogItem[]; fetchedAt: Date }>(),
	)
	const serviceLogCacheRef = useRef(
		new Map<string, { data: readonly LogItem[]; fetchedAt: Date }>(),
	)
	const traceDetailInflightRef = useRef(
		new Map<string, Promise<{ readonly error: string | null }>>(),
	)
	const traceLogInflightRef = useRef(
		new Map<string, Promise<{ readonly error: string | null }>>(),
	)

	useEffect(() => {
		if (selectedTraceService) persistSelectedService(selectedTraceService)
	}, [selectedTraceService])

	useEffect(() => {
		if (!autoRefresh) return
		const id = setInterval(() => setRefreshNonce((n) => n + 1), 5000)
		return () => clearInterval(id)
	}, [autoRefresh, setRefreshNonce])

	useEffect(() => {
		cacheEpochRef.current += 1
		traceDetailCacheRef.current.clear()
		traceLogCacheRef.current.clear()
		serviceLogCacheRef.current.clear()
		traceDetailInflightRef.current.clear()
		traceLogInflightRef.current.clear()
		invalidateAiCallDetailCache()
	}, [refreshNonce])

	// Pre-warm the attribute picker facet keys for the currently-selected
	// service so pressing `f` feels instant. Fire-and-forget; errors are
	// surfaced when the user actually opens the picker.
	useEffect(() => {
		if (!selectedTraceService) return
		void ensureTraceAttributeKeys(selectedTraceService).catch(() => {})
	}, [selectedTraceService])

	useEffect(() => {
		const poll = Effect.gen(function* () {
			setTraceState((current) => ({
				...current,
				status: current.fetchedAt === null ? "loading" : "ready",
				error: null,
			}))

			const services = new Set<string>([
				...(selectedTraceService ? [selectedTraceService] : []),
				...(yield* Effect.promise(loadTraceServices)),
			])
			for (const service of services) {
				const traces = yield* Effect.tryPromise(() =>
					loadTraceSummariesForService(service, {
						activeAttrKey,
						activeAttrValue,
						debouncedAiText,
					}),
				).pipe(Effect.orElseSucceed(() => []))

				if (traces.length === 0) continue

				setSelectedTraceService(service)

				const prevTraceId = selectedTraceRef.current
				setTraceState({
					status: "ready",
					services: Array.from(services),
					data: traces,
					error: null,
					fetchedAt: new Date(),
				})
				if (prevTraceId) {
					const newIndex = traces.findIndex((t) => t.traceId === prevTraceId)
					if (newIndex >= 0) setSelectedTraceIndex(newIndex)
				}
				return true
			}

			return false
		}).pipe(
			Effect.catchCause((cause) => {
				setTraceState((current) => ({
					...current,
					status: "error",
					error: Cause.prettyErrors(cause)[0].message,
				}))
				return Effect.succeed(false)
			}),
			Effect.repeat({
				while: (hasData) => !hasData,
				schedule: Schedule.spaced("3 seconds"),
			}),
		)

		return Effect.runCallback(poll)
	}, [
		refreshNonce,
		selectedTraceService,
		activeAttrKey,
		activeAttrValue,
		debouncedAiText,
		setSelectedTraceIndex,
		setSelectedTraceService,
		setTraceState,
	])

	useEffect(() => {
		setSelectedTraceIndex((current) => {
			return clampSelectionIndex(current, traceState.data.length)
		})
	}, [traceState.data.length, setSelectedTraceIndex])

	const selectedTraceSummary = traceState.data[selectedTraceIndex] ?? null
	const selectedTraceId = selectedTraceSummary?.traceId ?? null
	const selectedTrace =
		traceDetailState.traceId === selectedTraceId ? traceDetailState.data : null
	const selectedVisibleSpans = useMemo(
		() =>
			selectedTrace
				? getVisibleSpans(selectedTrace.spans, collapsedSpanIds)
				: [],
		[selectedTrace, collapsedSpanIds],
	)
	const selectedVisibleSpan = getSelectedVisibleSpan(
		selectedVisibleSpans,
		selectedSpanIndex,
	)
	selectedTraceRef.current = selectedTraceId

	const warmTraceDetail = useCallback(
		(traceId: string, hydrateSelection: boolean) => {
			const cached = traceDetailCacheRef.current.get(traceId)
			if (cached) {
				if (hydrateSelection && selectedTraceRef.current === traceId) {
					setTraceDetailState({
						status: "ready",
						traceId,
						data: cached.data,
						error: null,
						fetchedAt: cached.fetchedAt,
					})
				}
				return Promise.resolve({ error: null })
			}

			const existing = traceDetailInflightRef.current.get(traceId)
			if (existing) {
				if (hydrateSelection) {
					void existing.then(({ error }) => {
						if (selectedTraceRef.current !== traceId) return
						const ready = traceDetailCacheRef.current.get(traceId)
						if (ready) {
							setTraceDetailState({
								status: "ready",
								traceId,
								data: ready.data,
								error: null,
								fetchedAt: ready.fetchedAt,
							})
							return
						}
						if (error) {
							setTraceDetailState({
								status: "error",
								traceId,
								data: null,
								error,
								fetchedAt: null,
							})
						}
					})
				}
				return existing
			}

			const epoch = cacheEpochRef.current
			const request = loadTraceDetail(traceId)
				.then((trace) => {
					if (cacheEpochRef.current !== epoch) return { error: null }
					const fetchedAt = new Date()
					traceDetailCacheRef.current.set(traceId, { data: trace, fetchedAt })
					if (hydrateSelection && selectedTraceRef.current === traceId) {
						setTraceDetailState({
							status: "ready",
							traceId,
							data: trace,
							error: null,
							fetchedAt,
						})
					}
					return { error: null }
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					if (
						cacheEpochRef.current === epoch &&
						hydrateSelection &&
						selectedTraceRef.current === traceId
					) {
						setTraceDetailState({
							status: "error",
							traceId,
							data: null,
							error: message,
							fetchedAt: null,
						})
					}
					return { error: message }
				})
				.finally(() => {
					traceDetailInflightRef.current.delete(traceId)
				})

			traceDetailInflightRef.current.set(traceId, request)
			return request
		},
		[setTraceDetailState],
	)

	const warmTraceLogs = useCallback(
		(traceId: string, hydrateSelection: boolean) => {
			const cached = traceLogCacheRef.current.get(traceId)
			if (cached) {
				if (hydrateSelection && selectedTraceRef.current === traceId) {
					setLogState({
						status: "ready",
						traceId,
						data: cached.data,
						error: null,
						fetchedAt: cached.fetchedAt,
					})
				}
				return Promise.resolve({ error: null })
			}

			const existing = traceLogInflightRef.current.get(traceId)
			if (existing) {
				if (hydrateSelection) {
					void existing.then(({ error }) => {
						if (selectedTraceRef.current !== traceId) return
						const ready = traceLogCacheRef.current.get(traceId)
						if (ready) {
							setLogState({
								status: "ready",
								traceId,
								data: ready.data,
								error: null,
								fetchedAt: ready.fetchedAt,
							})
							return
						}
						if (error) {
							setLogState({
								status: "error",
								traceId,
								data: [],
								error,
								fetchedAt: null,
							})
						}
					})
				}
				return existing
			}

			const epoch = cacheEpochRef.current
			const request = loadTraceLogs(traceId)
				.then((logs) => {
					if (cacheEpochRef.current !== epoch) return { error: null }
					const fetchedAt = new Date()
					traceLogCacheRef.current.set(traceId, { data: logs, fetchedAt })
					if (hydrateSelection && selectedTraceRef.current === traceId) {
						setLogState({
							status: "ready",
							traceId,
							data: logs,
							error: null,
							fetchedAt,
						})
					}
					return { error: null }
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					if (
						cacheEpochRef.current === epoch &&
						hydrateSelection &&
						selectedTraceRef.current === traceId
					) {
						setLogState({
							status: "error",
							traceId,
							data: [],
							error: message,
							fetchedAt: null,
						})
					}
					return { error: message }
				})
				.finally(() => {
					traceLogInflightRef.current.delete(traceId)
				})

			traceLogInflightRef.current.set(traceId, request)
			return request
		},
		[setLogState],
	)

	useEffect(() => {
		if (!selectedTraceId) {
			setTraceDetailState(initialTraceDetailState)
			return
		}

		const cached = traceDetailCacheRef.current.get(selectedTraceId)
		if (cached) {
			setTraceDetailState({
				status: "ready",
				traceId: selectedTraceId,
				data: cached.data,
				error: null,
				fetchedAt: cached.fetchedAt,
			})
			return
		}

		setTraceDetailState((current) => ({
			status:
				current.traceId === selectedTraceId && current.fetchedAt !== null
					? "ready"
					: "loading",
			traceId: selectedTraceId,
			data: current.traceId === selectedTraceId ? current.data : null,
			error: null,
			fetchedAt: current.traceId === selectedTraceId ? current.fetchedAt : null,
		}))

		void warmTraceDetail(selectedTraceId, true)
	}, [refreshNonce, selectedTraceId, setTraceDetailState, warmTraceDetail])

	useEffect(() => {
		setCollapsedSpanIds(new Set())
		setSelectedSpanIndex(null)
	}, [selectedTraceId, setCollapsedSpanIds, setSelectedSpanIndex])

	// Reset the attribute cursor whenever the span selection moves. Without
	// this, drilling from span A (with 34 tags) to span B (with 3 tags)
	// would leave the cursor pointing past the end of B's tag list until
	// the user hit `j`/`k` again.
	useEffect(() => {
		setSelectedAttrIndex(0)
		setChatDetailChunkId(null)
		setChatDetailScrollOffset(0)
		// New span → drop chunk selection and any open detail modal.
		// The effect below will re-select the first chunk once the
		// detail loads.
		setSelectedChatChunkId(null)
	}, [
		selectedSpanIndex,
		selectedTraceId,
		setSelectedAttrIndex,
		setChatDetailChunkId,
		setChatDetailScrollOffset,
		setSelectedChatChunkId,
	])

	// Load the parsed AI call detail for the currently-selected span when
	// it's an AI span and the user is drilled into L2. Cached module-level
	// so re-entering the chat view for a span we already loaded is free.
	const selectedSpanId = selectedVisibleSpan?.spanId ?? null
	const shouldLoadAiDetail =
		detailView === "span-detail" &&
		selectedVisibleSpan !== null &&
		isAiSpan(selectedVisibleSpan.tags)

	useEffect(() => {
		if (!shouldLoadAiDetail || !selectedSpanId) {
			setAiCallDetailState(initialAiCallDetailState)
			return
		}
		const cached = getCachedAiCallDetail(selectedSpanId)
		if (cached !== undefined) {
			setAiCallDetailState({
				status: "ready",
				spanId: selectedSpanId,
				data: cached,
				error: null,
			})
			return
		}
		setAiCallDetailState({
			status: "loading",
			spanId: selectedSpanId,
			data: null,
			error: null,
		})
		let cancelled = false
		ensureAiCallDetail(selectedSpanId)
			.then((data) => {
				if (cancelled) return
				setAiCallDetailState({
					status: "ready",
					spanId: selectedSpanId,
					data,
					error: null,
				})
			})
			.catch((err) => {
				if (cancelled) return
				setAiCallDetailState({
					status: "error",
					spanId: selectedSpanId,
					data: null,
					error: err instanceof Error ? err.message : String(err),
				})
			})
		return () => {
			cancelled = true
		}
	}, [shouldLoadAiDetail, selectedSpanId, setAiCallDetailState])

	// Chunk model — rebuilt whenever the detail payload changes.
	// Width-independent, so this lives here instead of in the view.
	const aiChatChunks = useMemo<readonly Chunk[]>(() => {
		if (!shouldLoadAiDetail || !aiCallDetailState.data) return []
		return buildChunks(aiCallDetailState.data)
	}, [shouldLoadAiDetail, aiCallDetailState.data])

	// Once chunks are available, pin selection to the first chunk unless
	// the user has already chosen one. Also handles the "chunk list
	// changed and the previous selection disappeared" case.
	useEffect(() => {
		if (aiChatChunks.length === 0) return
		const stillValid =
			selectedChatChunkId !== null &&
			aiChatChunks.some((c) => c.id === selectedChatChunkId)
		if (!stillValid) setSelectedChatChunkId(aiChatChunks[0]!.id)
	}, [aiChatChunks, selectedChatChunkId, setSelectedChatChunkId])

	useEffect(() => {
		if (selectedSpanIndex === null) return
		if (!selectedTrace || selectedTrace.spans.length === 0) {
			setSelectedSpanIndex(null)
			setDetailView("waterfall")
			return
		}
		const visibleCount = selectedVisibleSpans.length
		if (selectedSpanIndex >= visibleCount) {
			setSelectedSpanIndex(visibleCount - 1)
		}
	}, [
		selectedTrace,
		selectedSpanIndex,
		selectedVisibleSpans.length,
		setDetailView,
		setSelectedSpanIndex,
	])

	useEffect(() => {
		const traceId = selectedTraceId
		if (!traceId) {
			setLogState(initialLogState)
			return
		}

		const cached = traceLogCacheRef.current.get(traceId)
		if (cached) {
			setLogState({
				status: "ready",
				traceId,
				data: cached.data,
				error: null,
				fetchedAt: cached.fetchedAt,
			})
			return
		}

		setLogState((current) => ({
			status:
				current.traceId === traceId && current.fetchedAt !== null
					? "ready"
					: "loading",
			traceId,
			data: current.traceId === traceId ? current.data : [],
			error: null,
			fetchedAt: current.traceId === traceId ? current.fetchedAt : null,
		}))

		void warmTraceLogs(traceId, true)
	}, [refreshNonce, selectedTraceId, setLogState, warmTraceLogs])

	useEffect(() => {
		if (detailView !== "service-logs") return
		const serviceName = selectedTraceService
		if (!serviceName) {
			setServiceLogState(initialServiceLogState)
			return
		}

		const cached = serviceLogCacheRef.current.get(serviceName)
		if (cached) {
			setServiceLogState({
				status: "ready",
				serviceName,
				data: cached.data,
				error: null,
				fetchedAt: cached.fetchedAt,
			})
			return
		}

		let cancelled = false
		setServiceLogState((current) => ({
			status:
				current.serviceName === serviceName && current.fetchedAt !== null
					? "ready"
					: "loading",
			serviceName,
			data: current.serviceName === serviceName ? current.data : [],
			error: null,
			fetchedAt: current.serviceName === serviceName ? current.fetchedAt : null,
		}))

		void (async () => {
			try {
				const logs = await loadServiceLogs(serviceName)
				const fetchedAt = new Date()
				serviceLogCacheRef.current.set(serviceName, { data: logs, fetchedAt })
				if (cancelled) return
				setServiceLogState({
					status: "ready",
					serviceName,
					data: logs,
					error: null,
					fetchedAt,
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
		})()

		return () => {
			cancelled = true
		}
	}, [detailView, refreshNonce, selectedTraceService, setServiceLogState])

	useEffect(() => {
		setSelectedServiceLogIndex((current) => {
			return clampSelectionIndex(current, serviceLogState.data.length)
		})
	}, [serviceLogState.data.length, setSelectedServiceLogIndex])

	// Client-side filters: `:error` + operation-name needle both run
	// against already-loaded summaries (no server round-trip). The `:ai`
	// query, by contrast, is applied server-side in the load effect
	// above so we don't need to re-filter it here.
	const filteredTraces = useMemo(() => {
		const preFiltered = applyClientTraceFilters(
			traceState.data,
			filterText,
			parsedFilter,
		)
		return sortTraceSummaries(preFiltered, traceSort)
	}, [filterText, parsedFilter, traceSort, traceState.data])

	useEffect(() => {
		if (!selectedTraceId || filteredTraces.length === 0) return
		const currentIndex = filteredTraces.findIndex(
			(trace) => trace.traceId === selectedTraceId,
		)
		if (currentIndex < 0) return

		for (const offset of [-1, 1] as const) {
			const neighborId = filteredTraces[currentIndex + offset]?.traceId
			if (!neighborId) continue
			void warmTraceDetail(neighborId, false)
			void warmTraceLogs(neighborId, false)
		}
	}, [filteredTraces, selectedTraceId, warmTraceDetail, warmTraceLogs])

	return {
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
		setDetailView,
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
		selectedTraceId,
		filteredTraces,
		aiCallDetailState,
		aiChatChunks,
	} as const
}
