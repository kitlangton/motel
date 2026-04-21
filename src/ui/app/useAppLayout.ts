import { useMemo } from "react"
import { fitCell } from "../format.ts"
import type { DetailView } from "../state.ts"

interface UseAppLayoutInput {
	readonly width: number | undefined
	readonly height: number | undefined
	readonly notice: string | null
	readonly detailView: DetailView
	readonly selectedSpanIndex: number | null
}

export const useAppLayout = ({
	width,
	height,
	notice,
	detailView,
	selectedSpanIndex,
}: UseAppLayoutInput) =>
	useMemo(() => {
		const contentWidth = Math.max(60, width ?? 100)
		const isWideLayout = (width ?? 100) >= 100
		const splitGap = 1
		const sectionPadding = 1
		const traceListHeaderHeight = 1
		const footerNotice = notice
			? fitCell(notice, Math.max(24, contentWidth - 2))
			: null
		const footerHeight = 1
		const footerFrameHeight = footerHeight > 0 ? 1 + footerHeight : 0
		const frameHeight = 1 + 1 + footerFrameHeight
		const availableContentHeight = Math.max(10, (height ?? 24) - frameHeight)
		const viewLevelForLayout: 0 | 1 | 2 =
			detailView === "span-detail" ? 2 : selectedSpanIndex !== null ? 1 : 0
		// Split ratios for the two-pane body:
		//   L0 (trace list + trace preview):  40% / 60%  — list narrow, preview wide
		//   L1 (waterfall + span preview):    60% / 40%  — always-on preview,
		//                                                  read-only (enter drills
		//                                                  one level deeper)
		//   L2 (full-screen span content):    single pane — the waterfall is
		//                                                  hidden entirely; the
		//                                                  workspace reads
		//                                                  contentWidth directly
		//                                                  and the split ratio
		//                                                  is irrelevant.
		const splitRatio = viewLevelForLayout === 1 ? 0.6 : 0.4
		const listHidden = viewLevelForLayout >= 1
		const leftPaneWidth = !isWideLayout
			? contentWidth
			: Math.max(40, Math.floor((contentWidth - splitGap) * splitRatio))
		const rightPaneWidth = !isWideLayout
			? contentWidth
			: Math.max(28, contentWidth - leftPaneWidth - splitGap)
		// Left pane: paddingLeft (1) + scrollbar column (1). No right padding —
		// the vertical pane divider handles visual separation from the right pane.
		const leftContentWidth = isWideLayout
			? Math.max(24, leftPaneWidth - 2)
			: Math.max(24, contentWidth - sectionPadding * 2)
		// Right pane: both left and right padding. Trace details and span detail
		// content needs a little breathing room on the right so long op names
		// and the duration column don't butt against the pane border.
		const rightContentWidth = isWideLayout
			? Math.max(24, rightPaneWidth - sectionPadding * 2)
			: Math.max(24, contentWidth - sectionPadding * 2)
		const headerFooterWidth = Math.max(24, contentWidth - 2)
		const wideBodyHeight = availableContentHeight
		// TraceDetailsPane + SpanDetailPane both reserve 4 rows for their header
		// (title, op line, meta line, divider), so `bodyLines = paneHeight - 4`
		// makes the pane fill its parent exactly. Using `-5` here left a visible
		// blank row between the last waterfall span and the bottom divider.
		const wideBodyLines = Math.max(8, wideBodyHeight - 4)
		const narrowSplitHeight = Math.max(10, availableContentHeight - 1)
		const narrowListHeight = Math.max(
			4,
			Math.min(10, Math.floor(narrowSplitHeight * 0.4), narrowSplitHeight - 9),
		)
		const narrowDetailHeight = narrowSplitHeight - narrowListHeight
		const narrowBodyLines = Math.max(2, narrowDetailHeight - 4)
		const narrowFullBodyLines = Math.max(8, availableContentHeight - 6)
		const wideTraceListBodyHeight = Math.max(
			1,
			wideBodyHeight - traceListHeaderHeight,
		)
		const narrowTraceListBodyHeight = Math.max(
			1,
			narrowListHeight - traceListHeaderHeight,
		)
		const traceViewportRows = isWideLayout
			? wideTraceListBodyHeight
			: narrowTraceListBodyHeight
		const tracePageSize = Math.max(1, traceViewportRows - 1)
		const spanViewportRows = Math.max(
			1,
			(isWideLayout ? wideBodyLines : narrowBodyLines) - 1,
		)
		const spanPageSize = Math.max(1, spanViewportRows - 1)

		return {
			contentWidth,
			isWideLayout,
			splitGap,
			sectionPadding,
			availableContentHeight,
			viewLevel: viewLevelForLayout,
			listHidden,
			footerNotice,
			footerHeight,
			leftPaneWidth,
			rightPaneWidth,
			leftContentWidth,
			rightContentWidth,
			headerFooterWidth,
			wideBodyHeight,
			wideBodyLines,
			narrowListHeight,
			narrowBodyLines,
			narrowFullBodyLines,
			wideTraceListBodyHeight,
			narrowTraceListBodyHeight,
			traceViewportRows,
			tracePageSize,
			spanPageSize,
		} as const
	}, [detailView, height, notice, selectedSpanIndex, width])

export type AppLayout = ReturnType<typeof useAppLayout>
