import { useAtom } from "@effect/atom-react"
import { useKeyboard } from "@opentui/react"
import { useEffect, useRef } from "react"
import type { TraceItem } from "../domain.ts"
import { effectSetupInstructions } from "../instructions.ts"
import { copyToClipboard, traceUiUrl } from "./format.ts"
import {
	autoRefreshAtom,
	collapsedSpanIdsAtom,
	detailViewAtom,
	filterModeAtom,
	filterTextAtom,
	refreshNonceAtom,
	selectedServiceLogIndexAtom,
	selectedSpanIndexAtom,
	selectedTraceIndexAtom,
	selectedTraceServiceAtom,
	serviceLogStateAtom,
	showHelpAtom,
	traceStateAtom,
} from "./state.ts"
import { G_PREFIX_TIMEOUT_MS } from "./theme.ts"
import { findFirstChildIndex, findParentIndex, getVisibleSpans } from "./Waterfall.tsx"

interface KeyboardNavParams {
	selectedTrace: TraceItem | null
	isWideLayout: boolean
	wideBodyLines: number
	narrowBodyLines: number
	tracePageSize: number
	spanPageSize: number
	flashNotice: (message: string) => void
}

export const useKeyboardNav = (params: KeyboardNavParams) => {
	const {
		selectedTrace,
		isWideLayout,
		wideBodyLines,
		narrowBodyLines,
		tracePageSize,
		spanPageSize,
		flashNotice,
	} = params

	const [traceState] = useAtom(traceStateAtom)
	const [serviceLogState] = useAtom(serviceLogStateAtom)
	const [selectedSpanIndex, setSelectedSpanIndex] = useAtom(selectedSpanIndexAtom)
	const [selectedServiceLogIndex, setSelectedServiceLogIndex] = useAtom(selectedServiceLogIndexAtom)
	const [, setSelectedTraceIndex] = useAtom(selectedTraceIndexAtom)
	const [selectedTraceService, setSelectedTraceService] = useAtom(selectedTraceServiceAtom)
	const [detailView, setDetailView] = useAtom(detailViewAtom)
	const [showHelp, setShowHelp] = useAtom(showHelpAtom)
	const [, setRefreshNonce] = useAtom(refreshNonceAtom)
	const [collapsedSpanIds, setCollapsedSpanIds] = useAtom(collapsedSpanIdsAtom)
	const [autoRefresh, setAutoRefresh] = useAtom(autoRefreshAtom)
	const [filterMode, setFilterMode] = useAtom(filterModeAtom)
	const [filterText, setFilterText] = useAtom(filterTextAtom)

	const pendingGRef = useRef(false)
	const pendingGTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const spanNavActive = detailView !== "service-logs" && selectedSpanIndex !== null
	const serviceLogNavActive = detailView === "service-logs"

	const stateRef = useRef({ traceState, serviceLogState, selectedSpanIndex, selectedServiceLogIndex, selectedTraceService, detailView, showHelp, collapsedSpanIds, spanNavActive, serviceLogNavActive, filterMode, filterText, autoRefresh, ...params })
	useEffect(() => {
		stateRef.current = { traceState, serviceLogState, selectedSpanIndex, selectedServiceLogIndex, selectedTraceService, detailView, showHelp, collapsedSpanIds, spanNavActive, serviceLogNavActive, filterMode, filterText, autoRefresh, ...params }
	})

	const clearPendingG = () => {
		pendingGRef.current = false
		if (pendingGTimeoutRef.current !== null) {
			clearTimeout(pendingGTimeoutRef.current)
			pendingGTimeoutRef.current = null
		}
	}

	const armPendingG = () => {
		clearPendingG()
		pendingGRef.current = true
		pendingGTimeoutRef.current = globalThis.setTimeout(() => {
			pendingGRef.current = false
			pendingGTimeoutRef.current = null
		}, G_PREFIX_TIMEOUT_MS)
	}

	const $ = () => stateRef.current

	const jumpToStart = () => {
		const s = $()
		if (s.spanNavActive && s.selectedTrace) {
			const visibleCount = getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds).length
			setSelectedSpanIndex(visibleCount === 0 ? null : 0)
		} else {
			setSelectedTraceIndex(0)
		}
	}

	const jumpToEnd = () => {
		const s = $()
		if (s.spanNavActive && s.selectedTrace) {
			const visibleCount = getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds).length
			setSelectedSpanIndex(visibleCount === 0 ? null : visibleCount - 1)
		} else {
			setSelectedTraceIndex(s.traceState.data.length === 0 ? 0 : s.traceState.data.length - 1)
		}
	}

	const moveTraceBy = (direction: -1 | 1) => {
		const s = $()
		setSelectedTraceIndex((current) => {
			if (s.traceState.data.length === 0) return 0
			return direction < 0
				? current <= 0 ? s.traceState.data.length - 1 : current - 1
				: current >= s.traceState.data.length - 1 ? 0 : current + 1
		})
	}

	const moveServiceLogBy = (direction: -1 | 1) => {
		const s = $()
		setSelectedServiceLogIndex((current) => {
			if (s.serviceLogState.data.length === 0) return 0
			return direction < 0
				? current <= 0 ? s.serviceLogState.data.length - 1 : current - 1
				: current >= s.serviceLogState.data.length - 1 ? 0 : current + 1
		})
	}

	const cycleService = (direction: -1 | 1) => {
		const s = $()
		if (s.traceState.services.length === 0) return
		const currentIndex = s.selectedTraceService ? s.traceState.services.indexOf(s.selectedTraceService) : -1
		const nextIndex = currentIndex >= 0 ? (currentIndex + direction + s.traceState.services.length) % s.traceState.services.length : 0
		setSelectedTraceService(s.traceState.services[nextIndex] ?? s.selectedTraceService)
	}

	const refresh = (message?: string) => {
		const s = $()
		setRefreshNonce((current) => current + 1)
		if (message) s.flashNotice(message)
	}

	const toggleServiceLogsView = () => {
		const s = $()
		if (!s.selectedTraceService && !s.selectedTrace) return
		setDetailView((current) => current === "service-logs" ? (s.selectedSpanIndex !== null ? "span-detail" : "waterfall") : "service-logs")
	}

	const pageBy = (direction: -1 | 1) => {
		const s = $()
		if (s.serviceLogNavActive) {
			const serviceLogPageSize = Math.max(1, Math.floor((s.isWideLayout ? s.wideBodyLines : s.narrowBodyLines) * 0.5))
			setSelectedServiceLogIndex((current) => {
				if (s.serviceLogState.data.length === 0) return 0
				return Math.max(0, Math.min(current + direction * serviceLogPageSize, s.serviceLogState.data.length - 1))
			})
		} else if (s.spanNavActive && s.selectedTrace) {
			const visibleCount = getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds).length
			setSelectedSpanIndex((current) => {
				if (visibleCount === 0) return null
				const start = current ?? 0
				return Math.max(0, Math.min(start + direction * s.spanPageSize, visibleCount - 1))
			})
		} else {
			setSelectedTraceIndex((current) => {
				if (s.traceState.data.length === 0) return 0
				return Math.max(0, Math.min(current + direction * s.tracePageSize, s.traceState.data.length - 1))
			})
		}
	}

	useKeyboard((key) => {
		const s = $()

		// Filter mode: capture text input
		if (s.filterMode) {
			if (key.name === "escape") {
				setFilterMode(false)
				setFilterText("")
				return
			}
			if (key.name === "return" || key.name === "enter") {
				setFilterMode(false)
				return
			}
			if (key.name === "backspace") {
				setFilterText(s.filterText.slice(0, -1))
				return
			}
			// Single printable character
			if (key.name.length === 1 && !key.ctrl && !key.meta) {
				setFilterText(s.filterText + key.name)
				return
			}
			return
		}
		const plainG = key.name === "g" && !key.ctrl && !key.meta && !key.option && !key.shift
		const shiftedG = key.name === "g" && key.shift
		const questionMark = key.name === "?" || (key.name === "/" && key.shift)

		if (questionMark) {
			clearPendingG()
			setShowHelp((current) => !current)
			return
		}

		if (plainG && !key.repeated) {
			if (pendingGRef.current) {
				clearPendingG()
				jumpToStart()
			} else {
				armPendingG()
			}
			return
		}

		if (shiftedG) {
			clearPendingG()
			jumpToEnd()
			return
		}

		clearPendingG()

		if (key.name === "q" || (key.ctrl && key.name === "c")) {
			process.exit(0)
		}
		if (key.name === "home") {
			if (s.serviceLogNavActive) {
				setSelectedServiceLogIndex(0)
			} else {
				jumpToStart()
			}
			return
		}
		if (key.name === "end") {
			if (s.serviceLogNavActive) {
				setSelectedServiceLogIndex(s.serviceLogState.data.length === 0 ? 0 : s.serviceLogState.data.length - 1)
			} else {
				jumpToEnd()
			}
			return
		}
		if (key.name === "pagedown" || (key.ctrl && key.name === "d")) {
			pageBy(1)
			return
		}
		if (key.name === "pageup" || (key.ctrl && key.name === "u")) {
			pageBy(-1)
			return
		}
		if (key.ctrl && key.name === "p") {
			moveTraceBy(-1)
			return
		}
		if (key.ctrl && key.name === "n") {
			moveTraceBy(1)
			return
		}
		if (key.name === "escape") {
			if (s.showHelp) {
				setShowHelp(false)
				return
			}
			if (s.detailView === "span-detail" || s.detailView === "service-logs") {
				setDetailView("waterfall")
				return
			}
			if (s.spanNavActive) {
				setSelectedSpanIndex(null)
				return
			}
			return
		}
		if (key.name === "return" || key.name === "enter") {
			if (s.detailView === "service-logs") {
				const selectedLog = s.serviceLogState.data[s.selectedServiceLogIndex]
				if (selectedLog?.traceId) {
					const traceIndex = s.traceState.data.findIndex((trace) => trace.traceId === selectedLog.traceId)
					if (traceIndex >= 0) {
						setSelectedTraceIndex(traceIndex)
						setDetailView("waterfall")
						s.flashNotice(`Jumped to trace ${selectedLog.traceId.slice(-8)}`)
					}
				}
				return
			}
			if (s.spanNavActive && s.detailView === "waterfall") {
				setDetailView("span-detail")
				return
			}
			if (!s.spanNavActive && s.selectedTrace && s.selectedTrace.spans.length > 0) {
				setSelectedSpanIndex(0)
				return
			}
			return
		}
		if (key.name === "r") {
			refresh("Refreshing traces...")
			return
		}
		if (key.name === "a") {
			setAutoRefresh(!s.autoRefresh)
			s.flashNotice(s.autoRefresh ? "Auto-refresh paused" : "Auto-refresh resumed")
			return
		}
		if (key.name === "/" && !key.shift) {
			setFilterMode(true)
			return
		}
		if (key.name === "tab") {
			toggleServiceLogsView()
			return
		}
		if (key.name === "[") {
			cycleService(-1)
			return
		}
		if (key.name === "]") {
			cycleService(1)
			return
		}
		if (key.name === "up" || key.name === "k") {
			if (s.serviceLogNavActive) {
				moveServiceLogBy(-1)
			} else if (s.spanNavActive && s.selectedTrace) {
				const visibleCount = getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds).length
				setSelectedSpanIndex((current) => {
					if (current === null || visibleCount === 0) return 0
					return current <= 0 ? visibleCount - 1 : current - 1
				})
			} else {
				moveTraceBy(-1)
			}
			return
		}
		if (key.name === "down" || key.name === "j") {
			if (s.serviceLogNavActive) {
				moveServiceLogBy(1)
			} else if (s.spanNavActive && s.selectedTrace) {
				const visibleCount = getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds).length
				setSelectedSpanIndex((current) => {
					if (current === null || visibleCount === 0) return 0
					return current >= visibleCount - 1 ? 0 : current + 1
				})
			} else {
				moveTraceBy(1)
			}
			return
		}
		if (key.name === "left" || key.name === "h") {
			if (s.spanNavActive && s.selectedTrace) {
				const visible = getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds)
				const span = visible[s.selectedSpanIndex!]
				if (!span) return
				const fullIndex = s.selectedTrace.spans.indexOf(span)
				if (fullIndex >= 0 && findFirstChildIndex(s.selectedTrace.spans, fullIndex) !== null && !s.collapsedSpanIds.has(span.spanId)) {
					const next = new Set(s.collapsedSpanIds)
					next.add(span.spanId)
					setCollapsedSpanIds(next)
				} else {
					const parentIdx = findParentIndex(visible, s.selectedSpanIndex!)
					if (parentIdx !== null) setSelectedSpanIndex(parentIdx)
				}
			}
			return
		}
		if (key.name === "right" || key.name === "l") {
			if (s.spanNavActive && s.selectedTrace) {
				const visible = getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds)
				const span = visible[s.selectedSpanIndex!]
				if (!span) return
				const fullIndex = s.selectedTrace.spans.indexOf(span)
				if (fullIndex >= 0 && findFirstChildIndex(s.selectedTrace.spans, fullIndex) !== null && s.collapsedSpanIds.has(span.spanId)) {
					const next = new Set(s.collapsedSpanIds)
					next.delete(span.spanId)
					setCollapsedSpanIds(next)
				} else {
					const childIdx = findFirstChildIndex(visible, s.selectedSpanIndex!)
					if (childIdx !== null) setSelectedSpanIndex(childIdx)
				}
			} else if (!s.spanNavActive && !s.serviceLogNavActive) {
				toggleServiceLogsView()
			}
			return
		}
		if (key.name === "o") {
			if (s.serviceLogNavActive) {
				const selectedLog = s.serviceLogState.data[s.selectedServiceLogIndex]
				if (selectedLog?.traceId) {
					void Bun.spawn({ cmd: ["open", traceUiUrl(selectedLog.traceId)], stdout: "ignore", stderr: "ignore" })
					s.flashNotice(`Opened trace ${selectedLog.traceId.slice(-8)}`)
				}
				return
			}
			if (!s.selectedTrace) return
			void Bun.spawn({ cmd: ["open", traceUiUrl(s.selectedTrace.traceId)], stdout: "ignore", stderr: "ignore" })
			s.flashNotice(`Opened trace ${s.selectedTrace.traceId.slice(-8)}`)
			return
		}
		if (key.name === "c" || key.name === "C") {
			void copyToClipboard(effectSetupInstructions())
				.then(() => {
					s.flashNotice("Copied Effect setup instructions")
				})
				.catch((error) => {
					s.flashNotice(error instanceof Error ? error.message : String(error))
				})
		}
	})

	return { spanNavActive }
}
