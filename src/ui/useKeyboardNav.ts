import { useKeyboard } from "@opentui/react"
import { useRef } from "react"
import { resolveOtelUrl } from "../config.ts"
import { effectSetupInstructions } from "../instructions.ts"
import { copyToClipboard } from "./format.ts"
import type { DetailView, LogState, ServiceLogState, TraceState } from "./state.ts"
import { G_PREFIX_TIMEOUT_MS } from "./theme.ts"
import type { TraceItem } from "../domain.ts"

const traceUiUrl = (traceId: string) => resolveOtelUrl(`/trace/${traceId}`)

interface KeyboardNavParams {
	traceState: TraceState
	serviceLogState: ServiceLogState
	selectedTrace: TraceItem | null
	selectedTraceIndex: number
	selectedSpanIndex: number | null
	selectedServiceLogIndex: number
	selectedTraceService: string | null
	detailView: DetailView
	showHelp: boolean
	isWideLayout: boolean
	wideBodyLines: number
	narrowBodyLines: number
	tracePageSize: number
	spanPageSize: number
	setSelectedTraceIndex: (fn: number | ((current: number) => number)) => void
	setSelectedSpanIndex: (fn: number | null | ((current: number | null) => number | null)) => void
	setSelectedServiceLogIndex: (fn: number | ((current: number) => number)) => void
	setSelectedTraceService: (value: string | null) => void
	setDetailView: (fn: DetailView | ((current: DetailView) => DetailView)) => void
	setShowHelp: (fn: boolean | ((current: boolean) => boolean)) => void
	setRefreshNonce: (fn: (current: number) => number) => void
	flashNotice: (message: string) => void
}

export const useKeyboardNav = (params: KeyboardNavParams) => {
	const {
		traceState,
		serviceLogState,
		selectedTrace,
		selectedTraceIndex,
		selectedSpanIndex,
		selectedServiceLogIndex,
		selectedTraceService,
		detailView,
		showHelp,
		isWideLayout,
		wideBodyLines,
		narrowBodyLines,
		tracePageSize,
		spanPageSize,
		setSelectedTraceIndex,
		setSelectedSpanIndex,
		setSelectedServiceLogIndex,
		setSelectedTraceService,
		setDetailView,
		setShowHelp,
		setRefreshNonce,
		flashNotice,
	} = params

	const pendingGRef = useRef(false)
	const pendingGTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const spanNavActive = detailView !== "service-logs" && selectedSpanIndex !== null
	const serviceLogNavActive = detailView === "service-logs"

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

	const jumpToStart = () => {
		if (spanNavActive && selectedTrace) {
			setSelectedSpanIndex(selectedTrace.spans.length === 0 ? null : 0)
		} else {
			setSelectedTraceIndex(0)
		}
	}

	const jumpToEnd = () => {
		if (spanNavActive && selectedTrace) {
			setSelectedSpanIndex(selectedTrace.spans.length === 0 ? null : selectedTrace.spans.length - 1)
		} else {
			setSelectedTraceIndex(traceState.data.length === 0 ? 0 : traceState.data.length - 1)
		}
	}

	const moveTraceBy = (direction: -1 | 1) => {
		setSelectedTraceIndex((current) => {
			if (traceState.data.length === 0) return 0
			return direction < 0
				? current <= 0 ? traceState.data.length - 1 : current - 1
				: current >= traceState.data.length - 1 ? 0 : current + 1
		})
	}

	const moveServiceLogBy = (direction: -1 | 1) => {
		setSelectedServiceLogIndex((current) => {
			if (serviceLogState.data.length === 0) return 0
			return direction < 0
				? current <= 0 ? serviceLogState.data.length - 1 : current - 1
				: current >= serviceLogState.data.length - 1 ? 0 : current + 1
		})
	}

	const cycleService = (direction: -1 | 1) => {
		if (traceState.services.length === 0) return
		const currentIndex = selectedTraceService ? traceState.services.indexOf(selectedTraceService) : -1
		const nextIndex = currentIndex >= 0 ? (currentIndex + direction + traceState.services.length) % traceState.services.length : 0
		setSelectedTraceService(traceState.services[nextIndex] ?? selectedTraceService)
	}

	const refresh = (message?: string) => {
		setRefreshNonce((current) => current + 1)
		if (message) flashNotice(message)
	}

	const toggleServiceLogsView = () => {
		if (!selectedTraceService && !selectedTrace) return
		setDetailView((current) => current === "service-logs" ? (selectedSpanIndex !== null ? "span-detail" : "waterfall") : "service-logs")
	}

	const pageBy = (direction: -1 | 1) => {
		if (serviceLogNavActive) {
			const serviceLogPageSize = Math.max(1, Math.floor((isWideLayout ? wideBodyLines : narrowBodyLines) * 0.5))
			setSelectedServiceLogIndex((current) => {
				if (serviceLogState.data.length === 0) return 0
				return Math.max(0, Math.min(current + direction * serviceLogPageSize, serviceLogState.data.length - 1))
			})
		} else if (spanNavActive && selectedTrace) {
			setSelectedSpanIndex((current) => {
				if (selectedTrace.spans.length === 0) return null
				const start = current ?? 0
				return Math.max(0, Math.min(start + direction * spanPageSize, selectedTrace.spans.length - 1))
			})
		} else {
			setSelectedTraceIndex((current) => {
				if (traceState.data.length === 0) return 0
				return Math.max(0, Math.min(current + direction * tracePageSize, traceState.data.length - 1))
			})
		}
	}

	useKeyboard((key) => {
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
			if (serviceLogNavActive) {
				setSelectedServiceLogIndex(0)
			} else {
				jumpToStart()
			}
			return
		}
		if (key.name === "end") {
			if (serviceLogNavActive) {
				setSelectedServiceLogIndex(serviceLogState.data.length === 0 ? 0 : serviceLogState.data.length - 1)
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
			if (showHelp) {
				setShowHelp(false)
				return
			}
			if (detailView === "span-detail" || detailView === "service-logs") {
				setDetailView("waterfall")
				return
			}
			if (spanNavActive) {
				setSelectedSpanIndex(null)
				return
			}
			return
		}
		if (key.name === "return" || key.name === "enter") {
			if (detailView === "service-logs") {
				const selectedLog = serviceLogState.data[selectedServiceLogIndex]
				if (selectedLog?.traceId) {
					const traceIndex = traceState.data.findIndex((trace) => trace.traceId === selectedLog.traceId)
					if (traceIndex >= 0) {
						setSelectedTraceIndex(traceIndex)
						setDetailView("waterfall")
						flashNotice(`Jumped to trace ${selectedLog.traceId.slice(-8)}`)
					}
				}
				return
			}
			if (spanNavActive && detailView === "waterfall") {
				setDetailView("span-detail")
				return
			}
			if (!spanNavActive && selectedTrace && selectedTrace.spans.length > 0) {
				setSelectedSpanIndex(0)
				return
			}
			return
		}
		if (key.name === "r") {
			refresh("Refreshing traces...")
			return
		}
		if (key.name === "l" || key.name === "tab") {
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
			if (serviceLogNavActive) {
				moveServiceLogBy(-1)
			} else if (spanNavActive && selectedTrace) {
				setSelectedSpanIndex((current) => {
					if (current === null || selectedTrace.spans.length === 0) return 0
					return current <= 0 ? selectedTrace.spans.length - 1 : current - 1
				})
			} else {
				moveTraceBy(-1)
			}
			return
		}
		if (key.name === "down" || key.name === "j") {
			if (serviceLogNavActive) {
				moveServiceLogBy(1)
			} else if (spanNavActive && selectedTrace) {
				setSelectedSpanIndex((current) => {
					if (current === null || selectedTrace.spans.length === 0) return 0
					return current >= selectedTrace.spans.length - 1 ? 0 : current + 1
				})
			} else {
				moveTraceBy(1)
			}
			return
		}
		if (key.name === "o") {
			if (serviceLogNavActive) {
				const selectedLog = serviceLogState.data[selectedServiceLogIndex]
				if (selectedLog?.traceId) {
					void Bun.spawn({ cmd: ["open", traceUiUrl(selectedLog.traceId)], stdout: "ignore", stderr: "ignore" })
					flashNotice(`Opened trace ${selectedLog.traceId.slice(-8)}`)
				}
				return
			}
			if (!selectedTrace) return
			void Bun.spawn({ cmd: ["open", traceUiUrl(selectedTrace.traceId)], stdout: "ignore", stderr: "ignore" })
			flashNotice(`Opened trace ${selectedTrace.traceId.slice(-8)}`)
			return
		}
		if (key.name === "c" || key.name === "C") {
			void copyToClipboard(effectSetupInstructions())
				.then(() => {
					flashNotice("Copied Effect setup instructions")
				})
				.catch((error) => {
					flashNotice(error instanceof Error ? error.message : String(error))
				})
		}
	})

	return { spanNavActive }
}
