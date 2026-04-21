import { describe, expect, it } from "bun:test"
import { parseFilterText } from "./filterParser.ts"

describe("parseFilterText", () => {
	it("returns empty state for empty input", () => {
		expect(parseFilterText("")).toEqual({
			aiText: null,
			errorOnly: false,
			operationNeedle: "",
		})
	})

	it("extracts a bare operation-name needle", () => {
		expect(parseFilterText("streamText")).toEqual({
			aiText: null,
			errorOnly: false,
			operationNeedle: "streamtext",
		})
	})

	it("recognizes :error modifier", () => {
		expect(parseFilterText(":error")).toEqual({
			aiText: null,
			errorOnly: true,
			operationNeedle: "",
		})
	})

	it("composes :error with an operation needle", () => {
		expect(parseFilterText("llm :error")).toEqual({
			aiText: null,
			errorOnly: true,
			operationNeedle: "llm",
		})
	})

	it("extracts :ai query up to end of string", () => {
		expect(parseFilterText(":ai rate limit")).toEqual({
			aiText: "rate limit",
			errorOnly: false,
			operationNeedle: "",
		})
	})

	it("extracts :ai query stopping at the next modifier", () => {
		expect(parseFilterText(":ai tool_use :error")).toEqual({
			aiText: "tool_use",
			errorOnly: true,
			operationNeedle: "",
		})
	})

	it("composes operation needle + :ai + :error", () => {
		expect(parseFilterText("stream :ai rate :error")).toEqual({
			aiText: "rate",
			errorOnly: true,
			operationNeedle: "stream",
		})
	})

	it("ignores :ai with empty query", () => {
		expect(parseFilterText(":ai ")).toEqual({
			aiText: null,
			errorOnly: false,
			operationNeedle: "",
		})
	})

	it("is case-insensitive for modifiers", () => {
		expect(parseFilterText(":AI foo :ERROR")).toEqual({
			aiText: "foo",
			errorOnly: true,
			operationNeedle: "",
		})
	})
})
