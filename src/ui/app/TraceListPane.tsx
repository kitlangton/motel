import { FilterBar } from "../primitives.tsx"
import {
	TraceListBody,
	TraceListHeader,
	type TraceListProps,
} from "../TraceList.tsx"

interface TraceListPaneProps {
	readonly traceListProps: TraceListProps
	readonly filterMode: boolean
	readonly filterText: string
	readonly filterWidth: number
	readonly containerHeight: number
	readonly bodyHeight: number
	readonly padding: number
}

/**
 * Replaced the opentui <scrollbox> with a direct virtual-windowed body.
 * Rationale: the scrollbox's scrollSize is updated during opentui's render
 * pass, not during React commit, so the useLayoutEffect that adjusted
 * scrollTop on refresh was reading a stale max and clamping our intended
 * scroll position. Rendering only the visible rows ourselves keeps the
 * viewport math entirely in React state and eliminates the race.
 */
export const TraceListPane = ({
	traceListProps,
	filterMode,
	filterText,
	filterWidth,
	containerHeight,
	bodyHeight,
	padding,
}: TraceListPaneProps) => {
	const bodyRows = Math.max(1, filterMode ? bodyHeight - 1 : bodyHeight)
	return (
		<box
			height={containerHeight}
			flexDirection="column"
			paddingLeft={padding}
			paddingRight={0}
		>
			<TraceListHeader {...traceListProps} />
			{filterMode ? <FilterBar text={filterText} width={filterWidth} /> : null}
			<TraceListBody {...traceListProps} viewportRows={bodyRows} />
		</box>
	)
}
