import { describe, expect, it } from "bun:test"
import type { TraceSpanItem } from "../domain.ts"
import {
	computeMatchingSpanIds,
	findAdjacentMatch,
	spanMatchesFilter,
} from "./waterfallFilter.ts"

const span = (
	spanId: string,
	operationName: string,
	tags: Record<string, string> = {},
): TraceSpanItem => ({
	spanId,
	parentSpanId: null,
	serviceName: "test",
	scopeName: null,
	kind: null,
	operationName,
	startTime: new Date(0),
	isRunning: false,
	durationMs: 1,
	status: "ok",
	depth: 0,
	tags,
	warnings: [],
	events: [],
})

describe("spanMatchesFilter", () => {
	it("matches operation name case-insensitively", () => {
		expect(spanMatchesFilter(span("a", "ai.StreamText"), "stream")).toBe(true)
		expect(spanMatchesFilter(span("a", "ai.StreamText"), "nope")).toBe(false)
	})

	it("matches tag values but not keys", () => {
		expect(
			spanMatchesFilter(span("a", "op", { "ai.model.id": "claude" }), "claude"),
		).toBe(true)
		// Key-only match should not count, otherwise searching "ai" dims nothing.
		expect(
			spanMatchesFilter(
				span("a", "op", { "ai.model.id": "claude" }),
				"model.id",
			),
		).toBe(false)
	})

	it("returns true when the needle is empty", () => {
		expect(spanMatchesFilter(span("a", "op"), "")).toBe(true)
	})
})

describe("computeMatchingSpanIds", () => {
	it("returns null for empty/whitespace filter", () => {
		expect(computeMatchingSpanIds([span("a", "op")], "")).toBeNull()
		expect(computeMatchingSpanIds([span("a", "op")], "   ")).toBeNull()
	})

	it("returns only matching span ids", () => {
		const spans = [
			span("a", "ai.streamText"),
			span("b", "Agent.get"),
			span("c", "ai.toolCall"),
		]
		const ids = computeMatchingSpanIds(spans, "ai")
		expect(ids).not.toBeNull()
		expect(Array.from(ids!)).toEqual(["a", "c"])
	})
})

describe("findAdjacentMatch", () => {
	const spans = [
		span("a", "one"),
		span("b", "two"),
		span("c", "three"),
		span("d", "four"),
	]
	const matches = new Set(["b", "d"])

	it("finds next from current selection", () => {
		expect(findAdjacentMatch(spans, matches, 0, 1)).toBe(1) // a -> b
		expect(findAdjacentMatch(spans, matches, 1, 1)).toBe(3) // b -> d
	})

	it("wraps forward past the end", () => {
		expect(findAdjacentMatch(spans, matches, 3, 1)).toBe(1) // d -> b (wrap)
	})

	it("finds previous from current selection", () => {
		expect(findAdjacentMatch(spans, matches, 3, -1)).toBe(1) // d -> b
		expect(findAdjacentMatch(spans, matches, 1, -1)).toBe(3) // b -> d (wrap)
	})

	it("starts from beginning/end when nothing is selected", () => {
		expect(findAdjacentMatch(spans, matches, null, 1)).toBe(1) // forward → first match
		expect(findAdjacentMatch(spans, matches, null, -1)).toBe(3) // backward → last match
	})

	it("returns null when there are no matches", () => {
		expect(findAdjacentMatch(spans, new Set(), 0, 1)).toBeNull()
	})

	it("handles a single match by returning it regardless of direction", () => {
		expect(findAdjacentMatch(spans, new Set(["c"]), 0, 1)).toBe(2)
		expect(findAdjacentMatch(spans, new Set(["c"]), 0, -1)).toBe(2)
	})
})
