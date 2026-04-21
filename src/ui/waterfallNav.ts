import type { TraceSpanItem } from "../domain.ts"
import {
	findFirstChildIndex,
	findParentIndex,
	getVisibleSpans,
} from "./waterfallModel.ts"

export type CollapseStep = {
	readonly collapsed: ReadonlySet<string>
	readonly selectedIndex: number | null
}

export type ResolveCollapseParams = {
	readonly spans: readonly TraceSpanItem[]
	readonly collapsed: ReadonlySet<string>
	readonly selectedIndex: number | null
	readonly direction: "left" | "right"
}

/**
 * Pure resolver for the `h` (left) / `l` (right) keys in the waterfall.
 *
 * Semantics:
 * - `right`: if the selected span has children and is currently collapsed,
 *   expand it; selection stays on the same span. Otherwise, if it has visible
 *   children, move selection to its first child. Otherwise no-op.
 * - `left`: if the selected span has children and is currently expanded,
 *   collapse it; selection stays on the same span. Otherwise, if it has a
 *   parent in the visible list, move selection to that parent. Otherwise no-op.
 *
 * Stale or out-of-range selection indices are treated as no-ops rather than
 * crashing — defensive against the one-frame window between a state change
 * and the next render.
 */
export const resolveCollapseStep = ({
	spans,
	collapsed,
	selectedIndex,
	direction,
}: ResolveCollapseParams): CollapseStep => {
	const noChange: CollapseStep = { collapsed, selectedIndex }

	if (selectedIndex === null) return noChange

	const visible = getVisibleSpans(spans, collapsed)
	if (selectedIndex < 0 || selectedIndex >= visible.length) return noChange

	const span = visible[selectedIndex]!
	const fullIndex = spans.indexOf(span)
	const hasChildren =
		fullIndex >= 0 && findFirstChildIndex(spans, fullIndex) !== null
	const isCollapsed = collapsed.has(span.spanId)

	if (direction === "right") {
		// Expand a collapsed parent (selection stays).
		if (hasChildren && isCollapsed) {
			const next = new Set(collapsed)
			next.delete(span.spanId)
			return { collapsed: next, selectedIndex }
		}
		// Walk into first visible child.
		if (hasChildren) {
			const childIdx = findFirstChildIndex(visible, selectedIndex)
			if (childIdx !== null) return { collapsed, selectedIndex: childIdx }
		}
		return noChange
	}

	// direction === "left"
	// Collapse an expanded parent (selection stays).
	if (hasChildren && !isCollapsed) {
		const next = new Set(collapsed)
		next.add(span.spanId)
		return { collapsed: next, selectedIndex }
	}
	// Walk to parent in the visible list.
	const parentIdx = findParentIndex(visible, selectedIndex)
	if (parentIdx !== null) return { collapsed, selectedIndex: parentIdx }
	return noChange
}
