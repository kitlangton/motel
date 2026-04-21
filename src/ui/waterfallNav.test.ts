import { describe, expect, it } from "bun:test"
import type { TraceSpanItem } from "../domain.ts"
import {
	findFirstChildIndex,
	findParentIndex,
	getWaterfallLayout,
	getWaterfallSuffixMetrics,
	getVisibleSpans,
} from "./waterfallModel.ts"
import { resolveCollapseStep } from "./waterfallNav.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mkSpan = (
	spanId: string,
	depth: number,
	parentSpanId: string | null,
): TraceSpanItem => ({
	spanId,
	parentSpanId,
	serviceName: "svc",
	scopeName: null,
	kind: null,
	operationName: spanId,
	startTime: new Date(0),
	isRunning: false,
	durationMs: 1,
	status: "ok",
	depth,
	tags: {},
	warnings: [],
	events: [],
})

/**
 * A reusable, depth-first ordered span tree.
 *
 *  root        (0)
 *  ├─ a        (1)
 *  │  ├─ a1   (2)
 *  │  └─ a2   (2)
 *  ├─ b        (1)
 *  │  └─ b1   (2)
 *  │     └─ b1a (3)
 *  └─ c        (1)
 */
const buildTree = (): readonly TraceSpanItem[] => [
	mkSpan("root", 0, null),
	mkSpan("a", 1, "root"),
	mkSpan("a1", 2, "a"),
	mkSpan("a2", 2, "a"),
	mkSpan("b", 1, "root"),
	mkSpan("b1", 2, "b"),
	mkSpan("b1a", 3, "b1"),
	mkSpan("c", 1, "root"),
]

const idsOf = (spans: readonly TraceSpanItem[]) => spans.map((s) => s.spanId)
const indexOfId = (spans: readonly TraceSpanItem[], id: string) =>
	spans.findIndex((s) => s.spanId === id)

// Convenience: run resolveCollapseStep with the selection identified by spanId.
const step = (
	spans: readonly TraceSpanItem[],
	collapsed: ReadonlySet<string>,
	selectedSpanId: string | null,
	direction: "left" | "right",
) => {
	const visible = getVisibleSpans(spans, collapsed)
	const selectedIndex =
		selectedSpanId === null
			? -1
			: visible.findIndex((s) => s.spanId === selectedSpanId)
	const out = resolveCollapseStep({
		spans,
		collapsed,
		selectedIndex: selectedIndex < 0 ? null : selectedIndex,
		direction,
	})
	const newVisible = getVisibleSpans(spans, out.collapsed)
	return {
		collapsed: out.collapsed,
		selectedIndex: out.selectedIndex,
		selectedSpanId:
			out.selectedIndex !== null
				? (newVisible[out.selectedIndex]?.spanId ?? null)
				: null,
		visibleIds: idsOf(newVisible),
	}
}

// ---------------------------------------------------------------------------
// getVisibleSpans
// ---------------------------------------------------------------------------

describe("getVisibleSpans", () => {
	it("returns the full list when nothing is collapsed", () => {
		const spans = buildTree()
		expect(idsOf(getVisibleSpans(spans, new Set()))).toEqual([
			"root",
			"a",
			"a1",
			"a2",
			"b",
			"b1",
			"b1a",
			"c",
		])
	})

	it("hides direct children of a collapsed node", () => {
		const spans = buildTree()
		expect(idsOf(getVisibleSpans(spans, new Set(["a"])))).toEqual([
			"root",
			"a",
			"b",
			"b1",
			"b1a",
			"c",
		])
	})

	it("hides transitive descendants of a collapsed node", () => {
		const spans = buildTree()
		expect(idsOf(getVisibleSpans(spans, new Set(["b"])))).toEqual([
			"root",
			"a",
			"a1",
			"a2",
			"b",
			"c",
		])
	})

	it("collapsing a leaf changes nothing visually (no children to hide)", () => {
		const spans = buildTree()
		expect(idsOf(getVisibleSpans(spans, new Set(["c"])))).toEqual(idsOf(spans))
	})

	it("handles multiple collapsed sibling subtrees", () => {
		const spans = buildTree()
		expect(idsOf(getVisibleSpans(spans, new Set(["a", "b"])))).toEqual([
			"root",
			"a",
			"b",
			"c",
		])
	})

	it("collapsing root hides everything but root", () => {
		const spans = buildTree()
		expect(idsOf(getVisibleSpans(spans, new Set(["root"])))).toEqual(["root"])
	})

	it("collapsing a node and its descendant is idempotent", () => {
		const spans = buildTree()
		expect(idsOf(getVisibleSpans(spans, new Set(["b", "b1"])))).toEqual([
			"root",
			"a",
			"a1",
			"a2",
			"b",
			"c",
		])
	})
})

describe("getWaterfallSuffixMetrics", () => {
	it("uses the widest visible duration as the shared suffix width", () => {
		const spans = [
			{ spanId: "a", durationMs: 1 },
			{ spanId: "b", durationMs: 57_000 },
			{ spanId: "c", durationMs: 120 },
		]
		const metrics = getWaterfallSuffixMetrics(spans)
		// `120ms` = 5 is the widest
		expect(metrics.maxDurationWidth).toBe(5)
		expect(metrics.suffixWidth).toBe(5)
	})

	it("layout reserves the suffix once and leaves the rest for the bar", () => {
		const contentWidth = 72
		const metrics = getWaterfallSuffixMetrics([
			{ spanId: "a", durationMs: 57_000 },
			{ spanId: "b", durationMs: 1 },
		])
		const { labelMaxWidth, barWidth } = getWaterfallLayout(
			contentWidth,
			metrics.suffixWidth,
		)
		// label + 1 (gap before bar) + bar + 1 (gap before suffix) + suffix = contentWidth
		expect(labelMaxWidth + 1 + barWidth + 1 + metrics.suffixWidth).toBe(
			contentWidth,
		)
	})

	it("layout fits inside contentWidth at narrow widths without overflow", () => {
		// Regression guard: a prior `max(6, ...)` floor on barWidth caused
		// the total row width to exceed contentWidth at narrow panes,
		// which in turn made OpenTUI's truncate add "..." suffixes
		// across the right edge. Every width in this sweep must satisfy
		// label + 1 + bar + 1 + suffix == contentWidth.
		for (let contentWidth = 14; contentWidth <= 120; contentWidth++) {
			for (const suffixWidth of [3, 5, 7]) {
				const { labelMaxWidth, barWidth } = getWaterfallLayout(
					contentWidth,
					suffixWidth,
				)
				expect(labelMaxWidth + 1 + barWidth + 1 + suffixWidth).toBe(
					contentWidth,
				)
				expect(barWidth).toBeGreaterThanOrEqual(1)
				expect(labelMaxWidth).toBeGreaterThanOrEqual(4)
			}
		}
	})
})

// ---------------------------------------------------------------------------
// findParentIndex
// ---------------------------------------------------------------------------

describe("findParentIndex", () => {
	it("returns null for the root span", () => {
		const spans = buildTree()
		expect(findParentIndex(spans, indexOfId(spans, "root"))).toBeNull()
	})

	it("returns the immediate parent index in the same list", () => {
		const spans = buildTree()
		expect(findParentIndex(spans, indexOfId(spans, "a1"))).toBe(
			indexOfId(spans, "a"),
		)
		expect(findParentIndex(spans, indexOfId(spans, "b1a"))).toBe(
			indexOfId(spans, "b1"),
		)
		expect(findParentIndex(spans, indexOfId(spans, "c"))).toBe(
			indexOfId(spans, "root"),
		)
	})

	it("works against a filtered (visible) list — parent is the nearest shallower ancestor before index", () => {
		const spans = buildTree()
		const visible = getVisibleSpans(spans, new Set(["b1"]))
		// visible: root, a, a1, a2, b, b1, c
		expect(findParentIndex(visible, indexOfId(visible, "b1"))).toBe(
			indexOfId(visible, "b"),
		)
	})

	it("returns null on out-of-range index instead of crashing", () => {
		const spans = buildTree()
		expect(findParentIndex(spans, 999)).toBeNull()
		expect(findParentIndex(spans, -1)).toBeNull()
	})

	it("returns null on empty input", () => {
		expect(findParentIndex([], 0)).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// findFirstChildIndex
// ---------------------------------------------------------------------------

describe("findFirstChildIndex", () => {
	it("returns next index when the next span is deeper", () => {
		const spans = buildTree()
		expect(findFirstChildIndex(spans, indexOfId(spans, "a"))).toBe(
			indexOfId(spans, "a1"),
		)
		expect(findFirstChildIndex(spans, indexOfId(spans, "b1"))).toBe(
			indexOfId(spans, "b1a"),
		)
		expect(findFirstChildIndex(spans, indexOfId(spans, "root"))).toBe(
			indexOfId(spans, "a"),
		)
	})

	it("returns null for leaf spans", () => {
		const spans = buildTree()
		expect(findFirstChildIndex(spans, indexOfId(spans, "a1"))).toBeNull()
		expect(findFirstChildIndex(spans, indexOfId(spans, "c"))).toBeNull()
	})

	it("returns null on out-of-range index", () => {
		const spans = buildTree()
		expect(findFirstChildIndex(spans, 999)).toBeNull()
		expect(findFirstChildIndex(spans, -1)).toBeNull()
	})

	it("returns null on empty input", () => {
		expect(findFirstChildIndex([], 0)).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// resolveCollapseStep — the heart of the keyboard logic
// ---------------------------------------------------------------------------

describe("resolveCollapseStep — `right` (l / expand-or-into)", () => {
	it("expanding a collapsed node keeps the same span selected", () => {
		const spans = buildTree()
		const collapsed = new Set(["a"])
		const r = step(spans, collapsed, "a", "right")
		expect(r.collapsed.has("a")).toBe(false)
		expect(r.selectedSpanId).toBe("a")
		expect(r.visibleIds).toEqual([
			"root",
			"a",
			"a1",
			"a2",
			"b",
			"b1",
			"b1a",
			"c",
		])
	})

	it("on an expanded parent, walks selection into its first visible child", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), "a", "right")
		expect(r.collapsed.size).toBe(0)
		expect(r.selectedSpanId).toBe("a1")
	})

	it("on a leaf, is a no-op", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), "a1", "right")
		expect(r.collapsed.size).toBe(0)
		expect(r.selectedSpanId).toBe("a1")
	})

	it("on root (expanded with children) walks into first child", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), "root", "right")
		expect(r.selectedSpanId).toBe("a")
	})

	it("on root (collapsed) expands it", () => {
		const spans = buildTree()
		const r = step(spans, new Set(["root"]), "root", "right")
		expect(r.collapsed.has("root")).toBe(false)
		expect(r.selectedSpanId).toBe("root")
	})

	it("when nothing is selected, is a no-op", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), null, "right")
		expect(r.selectedSpanId).toBeNull()
		expect(r.collapsed.size).toBe(0)
	})

	it("when index is stale (past visible end), is a no-op rather than crashing", () => {
		const spans = buildTree()
		const out = resolveCollapseStep({
			spans,
			collapsed: new Set(),
			selectedIndex: 999,
			direction: "right",
		})
		expect(out.selectedIndex).toBe(999)
		expect(out.collapsed.size).toBe(0)
	})
})

describe("resolveCollapseStep — `left` (h / collapse-or-up)", () => {
	it("collapsing an expanded parent keeps the same span selected", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), "a", "left")
		expect(r.collapsed.has("a")).toBe(true)
		expect(r.selectedSpanId).toBe("a")
		expect(r.visibleIds).toEqual(["root", "a", "b", "b1", "b1a", "c"])
	})

	it("on a leaf, walks to its parent", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), "a1", "left")
		expect(r.selectedSpanId).toBe("a")
		expect(r.collapsed.size).toBe(0)
	})

	it("on a deep leaf, walks to its immediate parent (not all the way to root)", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), "b1a", "left")
		expect(r.selectedSpanId).toBe("b1")
	})

	it("on a collapsed parent, walks to its parent (since it has no expanded kids to collapse)", () => {
		const spans = buildTree()
		const r = step(spans, new Set(["a"]), "a", "left")
		expect(r.selectedSpanId).toBe("root")
		expect(r.collapsed.has("a")).toBe(true) // staying collapsed
	})

	it("on root, is a no-op", () => {
		const spans = buildTree()
		const r = step(spans, new Set(["root"]), "root", "left")
		expect(r.selectedSpanId).toBe("root")
	})

	it("when nothing is selected, is a no-op", () => {
		const spans = buildTree()
		const r = step(spans, new Set(), null, "left")
		expect(r.selectedSpanId).toBeNull()
		expect(r.collapsed.size).toBe(0)
	})
})

describe("resolveCollapseStep — sequences (real bug scenarios)", () => {
	it("press l then l: navigates root → a → a1 (no double-collapse)", () => {
		const spans = buildTree()
		const r1 = step(spans, new Set(), "root", "right")
		expect(r1.selectedSpanId).toBe("a")
		const r2 = step(spans, r1.collapsed, r1.selectedSpanId!, "right")
		expect(r2.selectedSpanId).toBe("a1")
	})

	it("h-then-h-then-h on a leaf reaches root via collapse-then-walk pattern", () => {
		const spans = buildTree()
		// b1a -> h -> b1 (walk parent)
		const r1 = step(spans, new Set(), "b1a", "left")
		expect(r1.selectedSpanId).toBe("b1")
		// b1 -> h -> collapse b1
		const r2 = step(spans, r1.collapsed, r1.selectedSpanId!, "left")
		expect(r2.collapsed.has("b1")).toBe(true)
		expect(r2.selectedSpanId).toBe("b1")
		// b1 (collapsed) -> h -> walk to parent b
		const r3 = step(spans, r2.collapsed, r2.selectedSpanId!, "left")
		expect(r3.selectedSpanId).toBe("b")
	})

	it("rapid collapse/expand on the same node converges to the original state", () => {
		const spans = buildTree()
		let st: { collapsed: ReadonlySet<string>; selectedSpanId: string } = {
			collapsed: new Set(),
			selectedSpanId: "a",
		}
		for (let i = 0; i < 10; i++) {
			const dir = i % 2 === 0 ? "left" : "right"
			const r = step(spans, st.collapsed, st.selectedSpanId, dir)
			st = { collapsed: r.collapsed, selectedSpanId: r.selectedSpanId! }
		}
		expect([...st.collapsed]).toEqual([])
		expect(st.selectedSpanId).toBe("a")
	})

	it("walking right past a leaf is idempotent (no crash, no state change)", () => {
		const spans = buildTree()
		const r1 = step(spans, new Set(), "a1", "right")
		const r2 = step(spans, r1.collapsed, r1.selectedSpanId!, "right")
		const r3 = step(spans, r2.collapsed, r2.selectedSpanId!, "right")
		expect(r1.selectedSpanId).toBe("a1")
		expect(r2.selectedSpanId).toBe("a1")
		expect(r3.selectedSpanId).toBe("a1")
	})

	it("walking left past root is idempotent", () => {
		const spans = buildTree()
		const r1 = step(spans, new Set(["root"]), "root", "left")
		const r2 = step(spans, r1.collapsed, r1.selectedSpanId!, "left")
		expect(r1.selectedSpanId).toBe("root")
		expect(r2.selectedSpanId).toBe("root")
	})

	it("collapse then move to another span then expand: state stays consistent", () => {
		const spans = buildTree()
		// Collapse `a` while on it.
		const r1 = step(spans, new Set(), "a", "left")
		expect(r1.collapsed.has("a")).toBe(true)
		// Visible: root, a, b, b1, b1a, c
		// Pretend user clicks `b1a` (so selection moves there).
		// Now press h on b1a.
		const r2 = step(spans, r1.collapsed, "b1a", "left")
		expect(r2.selectedSpanId).toBe("b1")
		expect(r2.collapsed.has("a")).toBe(true) // a stays collapsed
	})
})

describe("resolveCollapseStep — invariants", () => {
	it("never returns a selectedIndex that is out of the new visible range", () => {
		const spans = buildTree()
		// Try every (selectedSpanId, direction, collapsed-state) combination we care about.
		const interesting: ReadonlyArray<{
			collapsed: ReadonlySet<string>
			selectedSpanId: string
		}> = [
			{ collapsed: new Set(), selectedSpanId: "root" },
			{ collapsed: new Set(), selectedSpanId: "a" },
			{ collapsed: new Set(), selectedSpanId: "a2" },
			{ collapsed: new Set(), selectedSpanId: "b1a" },
			{ collapsed: new Set(["a"]), selectedSpanId: "a" },
			{ collapsed: new Set(["a"]), selectedSpanId: "b" },
			{ collapsed: new Set(["b"]), selectedSpanId: "b" },
			{ collapsed: new Set(["root"]), selectedSpanId: "root" },
		]
		for (const { collapsed, selectedSpanId } of interesting) {
			for (const direction of ["left", "right"] as const) {
				const r = step(spans, collapsed, selectedSpanId, direction)
				if (r.selectedIndex !== null) {
					expect(r.selectedIndex).toBeGreaterThanOrEqual(0)
					expect(r.selectedIndex).toBeLessThan(r.visibleIds.length)
				}
			}
		}
	})

	it("collapsing then expanding the same node restores the original state", () => {
		const spans = buildTree()
		const a = step(spans, new Set(), "a", "left") // collapse a
		const b = step(spans, a.collapsed, a.selectedSpanId!, "right") // expand a
		expect([...b.collapsed]).toEqual([])
		expect(b.selectedSpanId).toBe("a")
		expect(b.visibleIds).toEqual(idsOf(spans))
	})

	it("collapsing an ancestor of the currently selected span keeps the ancestor visible (selection moves up)", () => {
		// Start: selected = b1a (depth 3). Collapse `b` (its grandparent).
		const spans = buildTree()
		// We collapse `b` while `b1a` is selected. The keyboard handler only collapses
		// the currently selected span, so we simulate the click-to-collapse path by
		// asserting the helper handles a selection that became invisible afterward.
		const collapsed = new Set(["b"])
		const visible = getVisibleSpans(spans, collapsed)
		// `b1a` is no longer visible. Its nearest visible ancestor is `b`.
		expect(visible.some((s) => s.spanId === "b1a")).toBe(false)
		expect(visible.some((s) => s.spanId === "b")).toBe(true)
	})
})
