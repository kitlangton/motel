import { useAtom } from "@effect/atom-react"
import { useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useLayoutEffect, useRef } from "react"
import { isAiSpan, type TraceItem, type TraceSummaryItem } from "../domain.ts"
import { otelServerInstructions } from "../instructions.ts"
import { renderChunkDetailLines, type Chunk } from "./aiChatModel.ts"
import { copyToClipboard, traceUiUrl, webUiUrl } from "./format.ts"
import {
	activeAttrKeyAtom,
	activeAttrValueAtom,
	attrFacetStateAtom,
	attrPickerIndexAtom,
	attrPickerInputAtom,
	attrPickerModeAtom,
	autoRefreshAtom,
	chatDetailChunkIdAtom,
	chatDetailScrollOffsetAtom,
	collapsedSpanIdsAtom,
	detailViewAtom,
	filterModeAtom,
	filterTextAtom,
	getCachedFacetKeys,
	getCachedFacetValues,
	initialAttrFacetState,
	refreshNonceAtom,
	selectedAttrIndexAtom,
	selectedChatChunkIdAtom,
	selectedThemeAtom,
	selectedServiceLogIndexAtom,
	selectedSpanIndexAtom,
	selectedTraceIndexAtom,
	selectedTraceServiceAtom,
	serviceLogStateAtom,
	showHelpAtom,
	traceSortAtom,
	type TraceSortMode,
	traceStateAtom,
	waterfallFilterModeAtom,
	waterfallFilterTextAtom,
} from "./state.ts"
import { filterFacets } from "./AttrFilterModal.tsx"
import { G_PREFIX_TIMEOUT_MS } from "./theme.ts"
import { cycleThemeName, themeLabel } from "./theme.ts"
import { computeMatchingSpanIds, findAdjacentMatch } from "./waterfallFilter.ts"
import { getVisibleSpans } from "./waterfallModel.ts"
import { resolveCollapseStep } from "./waterfallNav.ts"

/**
 * Pull a printable string out of a key event. Handles two cases:
 *
 * 1. A plain printable key (1 char) — returns the char.
 * 2. A multi-char sequence that arrived as one event (common when the
 *    terminal has bracketed paste disabled but the user pasted quickly and
 *    opentui's parser returned the whole buffer as one key). Returns the
 *    sanitised sequence with control bytes stripped.
 *
 * Returns `null` for non-printable events (function keys, modifiers, etc.)
 * so callers can skip them.
 */
interface KeyboardKey {
	readonly name: string
	readonly sequence?: string
	readonly ctrl: boolean
	readonly meta: boolean
	readonly option?: boolean
	readonly shift?: boolean
	readonly repeated?: boolean
}

const extractPrintable = (key: KeyboardKey): string | null => {
	if (key.ctrl || key.meta) return null
	// Space arrives as `key.name === "space"` with a 1-char sequence. We
	// handle it explicitly because the generic "length > 1" branch below
	// only catches multi-char paste sequences, not a lone " ".
	if (key.name === "space") return " "
	if (key.name.length === 1) return key.name
	const seq = key.sequence ?? ""
	// Only accept sequences that are pure printable text. Any escape or
	// control byte means this was a function / navigation key.
	if (seq.length > 1 && !/[\x00-\x1f\x7f]/.test(seq)) return seq
	return null
}

interface KeyboardNavParams {
	selectedTrace: TraceItem | null
	filteredTraces: readonly TraceSummaryItem[]
	aiChatChunks: readonly Chunk[]
	isWideLayout: boolean
	wideBodyLines: number
	narrowBodyLines: number
	tracePageSize: number
	spanPageSize: number
	flashNotice: (message: string) => void
}

const findTraceIndexById = (
	traces: readonly TraceSummaryItem[],
	traceId: string | null,
) =>
	traceId === null ? -1 : traces.findIndex((trace) => trace.traceId === traceId)

const clamp = (n: number, min: number, max: number) =>
	Math.max(min, Math.min(max, n))

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
	const renderer = useRenderer()

	const [traceState] = useAtom(traceStateAtom)
	const [serviceLogState] = useAtom(serviceLogStateAtom)
	const [selectedSpanIndex, setSelectedSpanIndex] = useAtom(
		selectedSpanIndexAtom,
	)
	const [selectedServiceLogIndex, setSelectedServiceLogIndex] = useAtom(
		selectedServiceLogIndexAtom,
	)
	const [selectedTheme, setSelectedTheme] = useAtom(selectedThemeAtom)
	const [selectedTraceIndex, setSelectedTraceIndex] = useAtom(
		selectedTraceIndexAtom,
	)
	const [selectedTraceService, setSelectedTraceService] = useAtom(
		selectedTraceServiceAtom,
	)
	const [detailView, setDetailView] = useAtom(detailViewAtom)
	const [showHelp, setShowHelp] = useAtom(showHelpAtom)
	const [, setRefreshNonce] = useAtom(refreshNonceAtom)
	const [collapsedSpanIds, setCollapsedSpanIds] = useAtom(collapsedSpanIdsAtom)
	const [autoRefresh, setAutoRefresh] = useAtom(autoRefreshAtom)
	const [filterMode, setFilterMode] = useAtom(filterModeAtom)
	const [filterText, setFilterText] = useAtom(filterTextAtom)
	const [traceSort, setTraceSort] = useAtom(traceSortAtom)
	const [pickerMode, setPickerMode] = useAtom(attrPickerModeAtom)
	const [pickerInput, setPickerInput] = useAtom(attrPickerInputAtom)
	const [pickerIndex, setPickerIndex] = useAtom(attrPickerIndexAtom)
	const [attrFacets, setAttrFacets] = useAtom(attrFacetStateAtom)
	const [activeAttrKey, setActiveAttrKey] = useAtom(activeAttrKeyAtom)
	const [activeAttrValue, setActiveAttrValue] = useAtom(activeAttrValueAtom)
	const [waterfallFilterMode, setWaterfallFilterMode] = useAtom(
		waterfallFilterModeAtom,
	)
	const [waterfallFilterText, setWaterfallFilterText] = useAtom(
		waterfallFilterTextAtom,
	)
	const [selectedAttrIndex, setSelectedAttrIndex] = useAtom(
		selectedAttrIndexAtom,
	)
	const [chatDetailChunkId, setChatDetailChunkId] = useAtom(
		chatDetailChunkIdAtom,
	)
	const [chatDetailScrollOffset, setChatDetailScrollOffset] = useAtom(
		chatDetailScrollOffsetAtom,
	)
	const [selectedChatChunkId, setSelectedChatChunkId] = useAtom(
		selectedChatChunkIdAtom,
	)

	const pendingGRef = useRef(false)
	const pendingGTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const quittingRef = useRef(false)

	const spanNavActive =
		detailView !== "service-logs" && selectedSpanIndex !== null
	const serviceLogNavActive = detailView === "service-logs"
	// L2 (full-screen content view): j/k/y/gg/G operate on the tag list
	// instead of the waterfall or trace list. Enter drilled us here from
	// L1; esc drills back.
	const attrNavActive =
		detailView === "span-detail" && selectedSpanIndex !== null
	// L2 specialisation: when drilled into an AI-flagged span we render
	// the chat transcript view instead of the attribute dump. j/k scroll
	// the transcript by a line, ctrl-d/u page by half the viewport, y
	// falls back to copying trace/span ids (the individual message
	// copying can come later; line-level is rarely what you want).
	const selectedSpanForAi =
		selectedTrace && selectedSpanIndex !== null
			? (getVisibleSpans(selectedTrace.spans, collapsedSpanIds)[
					selectedSpanIndex
				] ?? null)
			: null
	const chatNavActive =
		attrNavActive &&
		selectedSpanForAi !== null &&
		isAiSpan(selectedSpanForAi.tags)

	// Bracketed paste: when the terminal has bracketed paste enabled, opentui
	// surfaces the full pasted text as a single "paste" event on keyInput.
	// Route it into whichever input is currently open. We also enable the
	// mode ourselves (`\x1b[?2004h`) in case the host terminal didn't — it's
	// a no-op on terminals that already had it on.
	useEffect(() => {
		const keyInput = (
			renderer as unknown as {
				keyInput?: {
					on: (event: string, handler: (e: unknown) => void) => void
					off: (event: string, handler: (e: unknown) => void) => void
				}
			}
		).keyInput
		if (!keyInput) return
		try {
			process.stdout.write("\x1b[?2004h")
		} catch {
			// Best effort — some test environments don't have a real TTY.
		}
		const handler = (event: unknown) => {
			const bytes = (event as { bytes?: Uint8Array }).bytes
			if (!bytes || bytes.length === 0) return
			const text = Buffer.from(bytes)
				.toString("utf8")
				.replace(/[\x00-\x1f\x7f]+/g, (match) => (match === "\n" ? " " : ""))
			if (!text) return
			const s = stateRef.current
			if (s.pickerMode !== "off") {
				setPickerInput((current) => current + text)
				setPickerIndex(0)
				return
			}
			if (s.filterMode) {
				setFilterText((current) => current + text)
				return
			}
		}
		keyInput.on("paste", handler)
		return () => {
			keyInput.off("paste", handler)
			try {
				process.stdout.write("\x1b[?2004l")
			} catch {}
		}
	}, [renderer, setFilterText, setPickerInput, setPickerIndex])

	const buildStateSnapshot = () => ({
		traceState,
		serviceLogState,
		selectedServiceLogIndex,
		selectedTheme,
		selectedTraceIndex,
		selectedSpanIndex,
		selectedTraceService,
		detailView,
		showHelp,
		collapsedSpanIds,
		spanNavActive,
		serviceLogNavActive,
		attrNavActive,
		chatNavActive,
		selectedAttrIndex,
		chatDetailChunkId,
		chatDetailScrollOffset,
		selectedChatChunkId,
		filterMode,
		filterText,
		autoRefresh,
		traceSort,
		pickerMode,
		pickerInput,
		pickerIndex,
		attrFacets,
		activeAttrKey,
		activeAttrValue,
		waterfallFilterMode,
		waterfallFilterText,
		...params,
	})

	const stateRef = useRef(buildStateSnapshot())
	// Keep the keyboard handler's state mirror in sync before the next paint.
	// OpenTUI's own effect-event helper uses useLayoutEffect for this same reason:
	// rapid repeated keypresses can otherwise observe stale selection state.
	useLayoutEffect(() => {
		stateRef.current = buildStateSnapshot()
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

	const resetPicker = () => {
		setPickerInput("")
		setPickerIndex(0)
	}

	const hydrateCachedPickerKeys = (service: string | null) => {
		if (!service) {
			setAttrFacets(initialAttrFacetState)
			return
		}
		const cached = getCachedFacetKeys(service)
		if (!cached) return
		setAttrFacets({
			status: "ready",
			key: null,
			data: cached.data,
			error: null,
		})
	}

	const hydrateCachedPickerValues = (
		service: string | null,
		key: string | null,
	) => {
		if (!service || !key) {
			setAttrFacets(initialAttrFacetState)
			return
		}
		const cached = getCachedFacetValues(service, key)
		if (!cached) return
		setAttrFacets({ status: "ready", key, data: cached.data, error: null })
	}

	const closePicker = () => {
		setPickerMode("off")
		resetPicker()
	}

	const getVisibleSelectedSpans = () => {
		const s = $()
		return s.selectedTrace
			? getVisibleSpans(s.selectedTrace.spans, s.collapsedSpanIds)
			: []
	}

	const getSelectedVisibleSpan = () => {
		const s = $()
		if (s.selectedSpanIndex === null) return null
		return getVisibleSelectedSpans()[s.selectedSpanIndex] ?? null
	}

	const selectFilteredTraceAt = (filteredIdx: number) => {
		const s = $()
		const trace = s.filteredTraces[filteredIdx]
		if (!trace) return
		const fullIndex = findTraceIndexById(s.traceState.data, trace.traceId)
		if (fullIndex >= 0) setSelectedTraceIndex(fullIndex)
	}

	const currentFilteredTraceIndex = () => {
		const s = $()
		const selectedTraceId =
			s.traceState.data[s.selectedTraceIndex]?.traceId ?? null
		return findTraceIndexById(s.filteredTraces, selectedTraceId)
	}

	const attrCountForSelectedSpan = () => {
		const span = getSelectedVisibleSpan()
		return span ? Object.keys(span.tags).length : 0
	}

	const moveTraceBy = (delta: number) => {
		const s = $()
		if (s.filteredTraces.length === 0) return
		const currentIndex = currentFilteredTraceIndex()
		const nextIndex =
			currentIndex < 0
				? 0
				: Math.max(
						0,
						Math.min(currentIndex + delta, s.filteredTraces.length - 1),
					)
		selectFilteredTraceAt(nextIndex)
	}

	const moveServiceLogBy = (delta: number) => {
		const s = $()
		if (s.serviceLogState.data.length === 0) {
			setSelectedServiceLogIndex(0)
			return
		}
		setSelectedServiceLogIndex(
			Math.max(
				0,
				Math.min(
					s.selectedServiceLogIndex + delta,
					s.serviceLogState.data.length - 1,
				),
			),
		)
	}

	const moveSpanBy = (delta: number) => {
		const s = $()
		if (!s.selectedTrace) return
		const visibleCount = getVisibleSelectedSpans().length
		if (visibleCount === 0) {
			setSelectedSpanIndex(null)
			return
		}
		const current = s.selectedSpanIndex ?? 0
		setSelectedSpanIndex(
			Math.max(0, Math.min(current + delta, visibleCount - 1)),
		)
	}

	const moveAttrBy = (delta: number) => {
		const count = attrCountForSelectedSpan()
		if (count === 0) return
		const s = $()
		setSelectedAttrIndex(
			Math.max(0, Math.min(s.selectedAttrIndex + delta, count - 1)),
		)
	}

	const moveChatChunkBy = (direction: -1 | 1) => {
		const s = $()
		const chunks = s.aiChatChunks
		if (chunks.length === 0) return
		if (s.chatDetailChunkId) return
		const currentIdx = s.selectedChatChunkId
			? chunks.findIndex((c) => c.id === s.selectedChatChunkId)
			: 0
		const nextIdx = Math.max(
			0,
			Math.min(currentIdx + direction, chunks.length - 1),
		)
		const next = chunks[nextIdx]
		if (next) setSelectedChatChunkId(next.id)
	}

	const jumpToStart = () => {
		const s = $()
		if (s.chatNavActive) {
			if (s.chatDetailChunkId) {
				setChatDetailScrollOffset(0)
				return
			}
			const first = s.aiChatChunks[0]
			if (first) setSelectedChatChunkId(first.id)
			return
		}
		if (s.attrNavActive) {
			setSelectedAttrIndex(0)
			return
		}
		if (s.spanNavActive && s.selectedTrace) {
			const visibleCount = getVisibleSelectedSpans().length
			setSelectedSpanIndex(visibleCount === 0 ? null : 0)
		} else {
			selectFilteredTraceAt(0)
		}
	}

	const jumpToEnd = () => {
		const s = $()
		if (s.chatNavActive) {
			if (s.chatDetailChunkId) {
				const openChunk = s.aiChatChunks.find(
					(c) => c.id === s.chatDetailChunkId,
				)
				if (!openChunk) return
				const lines = renderChunkDetailLines(openChunk, 80)
				const pageSize = Math.max(
					4,
					Math.floor(
						(s.isWideLayout ? s.wideBodyLines : s.narrowBodyLines) * 0.75,
					),
				)
				setChatDetailScrollOffset(Math.max(0, lines.length - pageSize))
				return
			}
			const last = s.aiChatChunks[s.aiChatChunks.length - 1]
			if (last) setSelectedChatChunkId(last.id)
			return
		}
		if (s.attrNavActive) {
			const count = attrCountForSelectedSpan()
			setSelectedAttrIndex(Math.max(0, count - 1))
			return
		}
		if (s.spanNavActive && s.selectedTrace) {
			const visibleCount = getVisibleSelectedSpans().length
			setSelectedSpanIndex(visibleCount === 0 ? null : visibleCount - 1)
		} else {
			selectFilteredTraceAt(s.filteredTraces.length - 1)
		}
	}

	const cycleService = (direction: -1 | 1) => {
		const s = $()
		if (s.traceState.services.length === 0) return
		const currentIndex = s.selectedTraceService
			? s.traceState.services.indexOf(s.selectedTraceService)
			: -1
		const nextIndex =
			currentIndex >= 0
				? (currentIndex + direction + s.traceState.services.length) %
					s.traceState.services.length
				: 0
		setSelectedTraceService(
			s.traceState.services[nextIndex] ?? s.selectedTraceService,
		)
	}

	const refresh = (message?: string) => {
		const s = $()
		setRefreshNonce((current) => current + 1)
		if (message) s.flashNotice(message)
	}

	const copySelectedAttrValue = () => {
		const s = $()
		const span = getSelectedVisibleSpan()
		if (!span) return
		const entries = Object.entries(span.tags)
		const entry = entries[s.selectedAttrIndex] ?? entries[0]
		if (!entry) {
			s.flashNotice("No tag to copy")
			return
		}
		const [key, value] = entry
		void copyToClipboard(value)
			.then(() => {
				const preview =
					value.length > 40 ? `${value.slice(0, 39)}\u2026` : value
				s.flashNotice(`Copied ${key}: ${preview}`)
			})
			.catch((error) => {
				s.flashNotice(error instanceof Error ? error.message : String(error))
			})
	}

	const copySelectedChatChunk = () => {
		const s = $()
		const chunkId = s.chatDetailChunkId ?? s.selectedChatChunkId
		const chunk = s.aiChatChunks.find((c) => c.id === chunkId)
		if (!chunk) {
			s.flashNotice("No chunk selected")
			return
		}
		const payload = chunk.body.length > 0 ? chunk.body : chunk.header
		void copyToClipboard(payload)
			.then(() => {
				const label = chunk.toolName ?? chunk.kind
				s.flashNotice(`Copied ${label} (${payload.length} chars)`)
			})
			.catch((error) => {
				s.flashNotice(error instanceof Error ? error.message : String(error))
			})
	}

	const copySelectedIds = () => {
		const s = $()
		if (s.serviceLogNavActive) {
			const selectedLog = s.serviceLogState.data[s.selectedServiceLogIndex]
			if (!selectedLog?.traceId) {
				s.flashNotice("No trace id to copy")
				return
			}
			const lines = [
				`traceId=${selectedLog.traceId}`,
				selectedLog.spanId ? `spanId=${selectedLog.spanId}` : null,
			]
				.filter((line): line is string => line !== null)
				.join("\n")
			void copyToClipboard(lines)
				.then(() => {
					s.flashNotice(
						selectedLog.spanId
							? "Copied trace and span ids"
							: "Copied trace id",
					)
				})
				.catch((error) => {
					s.flashNotice(error instanceof Error ? error.message : String(error))
				})
			return
		}

		if (!s.selectedTrace) {
			s.flashNotice("No trace selected")
			return
		}

		const selectedSpan = getSelectedVisibleSpan()
		const lines = [
			`traceId=${s.selectedTrace.traceId}`,
			selectedSpan ? `spanId=${selectedSpan.spanId}` : null,
		]
			.filter((line): line is string => line !== null)
			.join("\n")

		void copyToClipboard(lines)
			.then(() => {
				s.flashNotice(
					selectedSpan ? "Copied trace and span ids" : "Copied trace id",
				)
			})
			.catch((error) => {
				s.flashNotice(error instanceof Error ? error.message : String(error))
			})
	}

	const toggleServiceLogsView = () => {
		const s = $()
		if (!s.selectedTraceService && !s.selectedTrace) return
		setDetailView((current) =>
			current === "service-logs"
				? s.selectedSpanIndex !== null
					? "span-detail"
					: "waterfall"
				: "service-logs",
		)
	}

	const pageBy = (direction: -1 | 1) => {
		const s = $()
		if (s.chatNavActive) {
			if (s.chatDetailChunkId) {
				const openChunk = s.aiChatChunks.find(
					(c) => c.id === s.chatDetailChunkId,
				)
				if (!openChunk) return
				const pageSize = Math.max(
					1,
					Math.floor(
						(s.isWideLayout ? s.wideBodyLines : s.narrowBodyLines) / 2,
					),
				)
				const detailLines = renderChunkDetailLines(openChunk, 80)
				const maxOffset = Math.max(0, detailLines.length - pageSize)
				setChatDetailScrollOffset((current) =>
					clamp(current + direction * pageSize, 0, maxOffset),
				)
				return
			}
			// Page-by-half in chunk units.
			const pageSize = Math.max(1, Math.floor(s.aiChatChunks.length / 4))
			const chunks = s.aiChatChunks
			const currentIdx = s.selectedChatChunkId
				? chunks.findIndex((c) => c.id === s.selectedChatChunkId)
				: 0
			const nextIdx = Math.max(
				0,
				Math.min(currentIdx + direction * pageSize, chunks.length - 1),
			)
			const next = chunks[nextIdx]
			if (next) setSelectedChatChunkId(next.id)
			return
		}
		if (s.attrNavActive) {
			const count = attrCountForSelectedSpan()
			if (count === 0) return
			// Attr page size: ~half the viewport in "blocks", not rows.
			// Attributes are variable height so measuring in blocks keeps
			// the jump feeling consistent regardless of value length.
			const pageSize = Math.max(
				1,
				Math.floor((s.isWideLayout ? s.wideBodyLines : s.narrowBodyLines) / 4),
			)
			setSelectedAttrIndex((current) =>
				Math.max(0, Math.min(current + direction * pageSize, count - 1)),
			)
			return
		}
		if (s.serviceLogNavActive) {
			const serviceLogPageSize = Math.max(
				1,
				Math.floor(
					(s.isWideLayout ? s.wideBodyLines : s.narrowBodyLines) * 0.5,
				),
			)
			moveServiceLogBy(direction * serviceLogPageSize)
		} else if (s.spanNavActive) {
			moveSpanBy(direction * s.spanPageSize)
		} else {
			moveTraceBy(direction * s.tracePageSize)
		}
	}

	const handlePickerMode = (key: KeyboardKey) => {
		const s = $()
		if (s.pickerMode === "off") return false

		const rows = filterFacets(s.attrFacets.data, s.pickerInput)
		const clampedIndex =
			rows.length === 0
				? 0
				: Math.max(0, Math.min(s.pickerIndex, rows.length - 1))
		const move = (delta: number) => {
			if (rows.length === 0) return
			setPickerIndex(
				Math.max(0, Math.min(clampedIndex + delta, rows.length - 1)),
			)
		}

		if (key.name === "escape") {
			closePicker()
			return true
		}
		if (key.ctrl && key.name === "c") {
			if (s.pickerInput.length > 0) {
				resetPicker()
			} else {
				setPickerMode("off")
				setPickerIndex(0)
			}
			return true
		}
		if (key.name === "up" || (key.ctrl && key.name === "p")) {
			move(-1)
			return true
		}
		if (key.name === "down" || (key.ctrl && key.name === "n")) {
			move(1)
			return true
		}
		if (key.name === "pageup") {
			move(-10)
			return true
		}
		if (key.name === "pagedown") {
			move(10)
			return true
		}
		if (key.name === "return" || key.name === "enter") {
			const row = rows[clampedIndex]
			if (!row) return true
			if (s.pickerMode === "keys") {
				hydrateCachedPickerValues(s.selectedTraceService, row.value)
				setActiveAttrKey(row.value)
				setPickerMode("values")
				resetPicker()
			} else {
				setActiveAttrValue(row.value)
				closePicker()
				s.flashNotice(`Filter: ${s.activeAttrKey}=${row.value}`)
			}
			return true
		}
		if (key.name === "backspace") {
			if (s.pickerInput.length > 0) {
				setPickerInput(s.pickerInput.slice(0, -1))
				setPickerIndex(0)
				return true
			}
			if (s.pickerMode === "values") {
				hydrateCachedPickerKeys(s.selectedTraceService)
				setPickerMode("keys")
				setActiveAttrKey(null)
				setPickerIndex(0)
				return true
			}
			return true
		}

		const printable = extractPrintable(key)
		if (printable) {
			setPickerInput((current) => current + printable)
			setPickerIndex(0)
		}
		return true
	}

	const handleTraceFilterMode = (key: KeyboardKey) => {
		const s = $()
		if (!s.filterMode) return false

		if (key.name === "escape") {
			setFilterMode(false)
			setFilterText("")
			return true
		}
		if (key.ctrl && key.name === "c") {
			if (s.filterText.length > 0) setFilterText("")
			else setFilterMode(false)
			return true
		}
		if (key.name === "return" || key.name === "enter") {
			setFilterMode(false)
			return true
		}
		if (key.name === "backspace") {
			setFilterText((current) => current.slice(0, -1))
			return true
		}

		const printable = extractPrintable(key)
		if (printable) setFilterText((current) => current + printable)
		return true
	}

	const handleWaterfallFilterMode = (key: KeyboardKey) => {
		const s = $()
		if (!s.waterfallFilterMode) return false

		if (key.name === "escape") {
			setWaterfallFilterMode(false)
			setWaterfallFilterText("")
			return true
		}
		if (key.ctrl && key.name === "c") {
			if (s.waterfallFilterText.length > 0) setWaterfallFilterText("")
			else setWaterfallFilterMode(false)
			return true
		}
		if (key.name === "return" || key.name === "enter") {
			setWaterfallFilterMode(false)
			return true
		}
		if (key.name === "backspace") {
			setWaterfallFilterText((current) => current.slice(0, -1))
			return true
		}

		const printable = extractPrintable(key)
		if (printable) setWaterfallFilterText((current) => current + printable)
		return true
	}

	const handleQuestionMarkKey = (key: KeyboardKey) => {
		const questionMark = key.name === "?" || (key.name === "/" && key.shift)
		if (!questionMark) return false
		clearPendingG()
		setShowHelp((current) => !current)
		return true
	}

	const handleHelpModalKey = (key: KeyboardKey) => {
		if (!$().showHelp) return false
		if (key.name === "return" || key.name === "enter" || key.name === "escape")
			setShowHelp(false)
		return true
	}

	const handleJumpKeys = (key: KeyboardKey) => {
		const plainG =
			key.name === "g" && !key.ctrl && !key.meta && !key.option && !key.shift
		const shiftedG = key.name === "g" && key.shift
		if (plainG && !key.repeated) {
			if (pendingGRef.current) {
				clearPendingG()
				jumpToStart()
			} else {
				armPendingG()
			}
			return true
		}
		if (shiftedG) {
			clearPendingG()
			jumpToEnd()
			return true
		}
		return false
	}

	const handleSystemKeys = (key: KeyboardKey) => {
		const s = $()
		if (key.name === "q" || (key.ctrl && key.name === "c")) {
			if (quittingRef.current) return true
			quittingRef.current = true
			renderer.destroy()
			return true
		}
		if (key.name === "home") {
			if (s.serviceLogNavActive) setSelectedServiceLogIndex(0)
			else jumpToStart()
			return true
		}
		if (key.name === "end") {
			if (s.serviceLogNavActive)
				setSelectedServiceLogIndex(
					s.serviceLogState.data.length === 0
						? 0
						: s.serviceLogState.data.length - 1,
				)
			else jumpToEnd()
			return true
		}
		if (key.name === "pagedown" || (key.ctrl && key.name === "d")) {
			pageBy(1)
			return true
		}
		if (key.name === "pageup" || (key.ctrl && key.name === "u")) {
			pageBy(-1)
			return true
		}
		if (key.ctrl && key.name === "p") {
			moveTraceBy(-1)
			return true
		}
		if (key.ctrl && key.name === "n") {
			moveTraceBy(1)
			return true
		}
		return false
	}

	const handleEscapeKey = (key: KeyboardKey) => {
		if (key.name !== "escape") return false
		const s = $()
		if (s.chatDetailChunkId) {
			setChatDetailChunkId(null)
			setChatDetailScrollOffset(0)
			return true
		}
		if (s.waterfallFilterText.length > 0) {
			setWaterfallFilterText("")
			return true
		}
		if (s.detailView === "span-detail" || s.detailView === "service-logs") {
			setDetailView("waterfall")
			return true
		}
		if (s.spanNavActive) {
			setSelectedSpanIndex(null)
			return true
		}
		if (s.activeAttrKey || s.activeAttrValue) {
			setActiveAttrKey(null)
			setActiveAttrValue(null)
			s.flashNotice("Cleared attribute filter")
			return true
		}
		return true
	}

	const handleEnterKey = (key: KeyboardKey) => {
		if (key.name !== "return" && key.name !== "enter") return false
		const s = $()
		if (s.chatNavActive) {
			const chunk = s.aiChatChunks.find((c) => c.id === s.selectedChatChunkId)
			if (chunk) {
				setChatDetailChunkId(chunk.id)
				setChatDetailScrollOffset(0)
			}
			return true
		}
		if (s.detailView === "service-logs") {
			const selectedLog = s.serviceLogState.data[s.selectedServiceLogIndex]
			if (selectedLog?.traceId) {
				const traceIndex = findTraceIndexById(
					s.traceState.data,
					selectedLog.traceId,
				)
				if (traceIndex >= 0) {
					setSelectedTraceIndex(traceIndex)
					setDetailView("waterfall")
					s.flashNotice(`Jumped to trace ${selectedLog.traceId.slice(-8)}`)
				}
			}
			return true
		}
		if (s.spanNavActive && s.detailView === "waterfall") {
			setDetailView("span-detail")
			return true
		}
		if (
			!s.spanNavActive &&
			s.selectedTrace &&
			s.selectedTrace.spans.length > 0
		) {
			setSelectedSpanIndex(0)
			return true
		}
		return true
	}

	const handleToolbarKeys = (key: KeyboardKey) => {
		const s = $()
		if (key.name === "r") {
			refresh("Refreshing traces...")
			return true
		}
		if (key.name === "a") {
			setAutoRefresh(!s.autoRefresh)
			s.flashNotice(
				s.autoRefresh ? "Auto-refresh paused" : "Auto-refresh resumed",
			)
			return true
		}
		if (key.name === "s") {
			const modes: readonly TraceSortMode[] = ["recent", "slowest", "errors"]
			const nextMode =
				modes[(modes.indexOf(s.traceSort) + 1) % modes.length] ?? "recent"
			setTraceSort(nextMode)
			s.flashNotice(`Sort: ${nextMode}`)
			return true
		}
		if (key.name === "t") {
			const nextTheme = cycleThemeName(s.selectedTheme)
			setSelectedTheme(nextTheme)
			s.flashNotice(`Theme: ${themeLabel(nextTheme)}`)
			return true
		}
		if ((key.name === "n" || key.name === "N") && !key.ctrl && !key.meta) {
			const inWaterfall =
				s.detailView === "span-detail" || s.selectedSpanIndex !== null
			if (inWaterfall && s.waterfallFilterText.length > 0 && s.selectedTrace) {
				const visibleSpans = getVisibleSelectedSpans()
				const matchingIds = computeMatchingSpanIds(
					visibleSpans,
					s.waterfallFilterText,
				)
				if (matchingIds && matchingIds.size > 0) {
					const direction = key.name === "N" ? -1 : 1
					const next = findAdjacentMatch(
						visibleSpans,
						matchingIds,
						s.selectedSpanIndex,
						direction,
					)
					if (next !== null) setSelectedSpanIndex(next)
					else s.flashNotice("No matches")
				} else {
					s.flashNotice("No matches")
				}
				return true
			}
		}
		if (key.name === "/" && !key.shift) {
			const inWaterfall =
				s.detailView === "span-detail" || s.selectedSpanIndex !== null
			if (inWaterfall) setWaterfallFilterMode(true)
			else setFilterMode(true)
			return true
		}
		if ((key.name === "f" || key.name === "F") && !key.ctrl && !key.meta) {
			hydrateCachedPickerKeys(s.selectedTraceService)
			setPickerMode("keys")
			resetPicker()
			setActiveAttrKey(null)
			return true
		}
		if (key.name === "tab") {
			toggleServiceLogsView()
			return true
		}
		if (key.name === "[") {
			cycleService(-1)
			return true
		}
		if (key.name === "]") {
			cycleService(1)
			return true
		}
		return false
	}

	const handleMovementKeys = (key: KeyboardKey) => {
		const s = $()
		if (key.name === "up" || key.name === "k") {
			if (s.chatNavActive) {
				moveChatChunkBy(-1)
				return true
			}
			if (s.attrNavActive) {
				moveAttrBy(-1)
				return true
			}
			if (s.serviceLogNavActive) {
				moveServiceLogBy(-1)
				return true
			}
			if (s.spanNavActive) {
				moveSpanBy(-1)
				return true
			}
			moveTraceBy(-1)
			return true
		}
		if (key.name === "down" || key.name === "j") {
			if (s.chatNavActive) {
				moveChatChunkBy(1)
				return true
			}
			if (s.attrNavActive) {
				moveAttrBy(1)
				return true
			}
			if (s.serviceLogNavActive) {
				moveServiceLogBy(1)
				return true
			}
			if (s.spanNavActive) {
				moveSpanBy(1)
				return true
			}
			moveTraceBy(1)
			return true
		}
		if (key.name === "left" || key.name === "h") {
			if (s.spanNavActive && s.selectedTrace) {
				const trace = s.selectedTrace
				setCollapsedSpanIds((currentCollapsed) => {
					const result = resolveCollapseStep({
						spans: trace.spans,
						collapsed: currentCollapsed,
						selectedIndex: s.selectedSpanIndex,
						direction: "left",
					})
					if (result.selectedIndex !== s.selectedSpanIndex)
						setSelectedSpanIndex(result.selectedIndex)
					return result.collapsed
				})
			}
			return true
		}
		if (key.name === "right" || key.name === "l") {
			if (s.spanNavActive && s.selectedTrace) {
				const trace = s.selectedTrace
				setCollapsedSpanIds((currentCollapsed) => {
					const result = resolveCollapseStep({
						spans: trace.spans,
						collapsed: currentCollapsed,
						selectedIndex: s.selectedSpanIndex,
						direction: "right",
					})
					if (result.selectedIndex !== s.selectedSpanIndex)
						setSelectedSpanIndex(result.selectedIndex)
					return result.collapsed
				})
			} else if (!s.spanNavActive && !s.serviceLogNavActive) {
				toggleServiceLogsView()
			}
			return true
		}
		return false
	}

	const handleOpenCopyKeys = (key: KeyboardKey) => {
		const s = $()
		if (key.name === "o" && !key.shift) {
			if (s.serviceLogNavActive) {
				const selectedLog = s.serviceLogState.data[s.selectedServiceLogIndex]
				if (selectedLog?.traceId) {
					void Bun.spawn({
						cmd: ["open", traceUiUrl(selectedLog.traceId)],
						stdout: "ignore",
						stderr: "ignore",
					})
					s.flashNotice(`Opened trace ${selectedLog.traceId.slice(-8)}`)
				}
				return true
			}
			if (!s.selectedTrace) return true
			void Bun.spawn({
				cmd: ["open", traceUiUrl(s.selectedTrace.traceId)],
				stdout: "ignore",
				stderr: "ignore",
			})
			s.flashNotice(`Opened trace ${s.selectedTrace.traceId.slice(-8)}`)
			return true
		}
		if (key.name === "o" && key.shift) {
			void Bun.spawn({
				cmd: ["open", webUiUrl()],
				stdout: "ignore",
				stderr: "ignore",
			})
			s.flashNotice("Opened web UI")
			return true
		}
		if (key.name === "y" || key.name === "Y") {
			if (s.chatNavActive) copySelectedChatChunk()
			else if (s.attrNavActive) copySelectedAttrValue()
			else copySelectedIds()
			return true
		}
		if (key.name === "c" || key.name === "C") {
			void copyToClipboard(otelServerInstructions())
				.then(() => {
					s.flashNotice("Copied OTEL server details")
				})
				.catch((error) => {
					s.flashNotice(error instanceof Error ? error.message : String(error))
				})
			return true
		}
		return false
	}

	useKeyboard((key: KeyboardKey) => {
		if (handlePickerMode(key)) return
		if (handleTraceFilterMode(key)) return
		if (handleWaterfallFilterMode(key)) return
		if (handleQuestionMarkKey(key)) return
		if (handleHelpModalKey(key)) return
		if (handleJumpKeys(key)) return

		clearPendingG()

		if (handleSystemKeys(key)) return
		if (handleEscapeKey(key)) return
		if (handleEnterKey(key)) return
		if (handleToolbarKeys(key)) return
		if (handleMovementKeys(key)) return
		handleOpenCopyKeys(key)
	})

	return { spanNavActive }
}
