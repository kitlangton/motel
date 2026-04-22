import { describe, expect, it } from "bun:test"
import { classifyContentType, classifyIngestError, isJsonParseError } from "./otlpIngestResponse.ts"

describe("classifyContentType", () => {
	it("accepts application/json", () => {
		expect(classifyContentType("application/json").kind).toBe("ok")
	})

	it("accepts application/json with charset parameter", () => {
		expect(classifyContentType("application/json; charset=utf-8").kind).toBe("ok")
	})

	it("is case-insensitive", () => {
		expect(classifyContentType("Application/JSON").kind).toBe("ok")
	})

	it("rejects protobuf with a 415 and exporter hint", () => {
		const result = classifyContentType("application/x-protobuf")
		expect(result.kind).toBe("unsupported")
		if (result.kind === "unsupported") {
			expect(result.response.status).toBe(415)
			expect(result.response.body.hint).toMatch(/http\/json/)
		}
	})

	it("rejects an absent Content-Type with a 415 and generic hint", () => {
		const result = classifyContentType(undefined)
		expect(result.kind).toBe("unsupported")
		if (result.kind === "unsupported") {
			expect(result.response.status).toBe(415)
			expect(result.response.body.hint).toMatch(/\(none\)/)
		}
	})

	it("rejects an unrelated Content-Type with a 415 naming the value", () => {
		const result = classifyContentType("text/plain")
		expect(result.kind).toBe("unsupported")
		if (result.kind === "unsupported") {
			expect(result.response.body.hint).toMatch(/text\/plain/)
		}
	})
})

describe("isJsonParseError", () => {
	it("matches Effect platform's JSON failure shape", () => {
		expect(isJsonParseError("Failed to parse JSON: Unexpected token")).toBe(true)
	})

	it("matches plain 'SyntaxError' messages", () => {
		expect(isJsonParseError("SyntaxError: Unexpected end of JSON input")).toBe(true)
	})

	it("matches the Effect platform's `RequestParseError` wrapper", () => {
		expect(isJsonParseError("RequestParseError (POST /v1/traces)")).toBe(true)
	})

	it("does not match SQLite / worker errors", () => {
		expect(isJsonParseError("SQLITE_CONSTRAINT: UNIQUE constraint failed: spans.span_id")).toBe(false)
		expect(isJsonParseError("Worker terminated unexpectedly")).toBe(false)
	})
})

describe("classifyIngestError", () => {
	it("maps JSON parse failures to 400 with a body hint", () => {
		const result = classifyIngestError(new Error("Failed to parse JSON"))
		expect(result.status).toBe(400)
		expect(result.body.hint).toMatch(/OTLP JSON/)
	})

	it("maps genuine downstream failures to 500", () => {
		const result = classifyIngestError(new Error("Worker crashed"))
		expect(result.status).toBe(500)
		expect(result.body.error).toBe("Worker crashed")
	})

	it("stringifies non-Error rejections", () => {
		const result = classifyIngestError("something bad")
		expect(result.status).toBe(500)
		expect(result.body.error).toBe("something bad")
	})
})
