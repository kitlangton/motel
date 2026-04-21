import { describe, expect, test } from "bun:test"
import { AI_FTS_KEYS, isAiSpan } from "./domain.ts"

describe("isAiSpan", () => {
	test("returns false for empty tags", () => {
		expect(isAiSpan({})).toBe(false)
	})

	test("returns false when no AI key is present", () => {
		expect(
			isAiSpan({
				"service.name": "web",
				"http.method": "GET",
				"db.statement": "SELECT 1",
			}),
		).toBe(false)
	})

	test("detects Vercel AI SDK keys", () => {
		expect(isAiSpan({ "ai.prompt.messages": "[]" })).toBe(true)
		expect(isAiSpan({ "ai.response.text": "hi" })).toBe(true)
		expect(isAiSpan({ "ai.toolCall.args": "{}" })).toBe(true)
	})

	test("detects OpenTelemetry gen_ai semconv keys", () => {
		expect(isAiSpan({ "gen_ai.prompt": "foo" })).toBe(true)
		expect(isAiSpan({ "gen_ai.input.messages": "[]" })).toBe(true)
		expect(isAiSpan({ "gen_ai.tool.definitions": "[]" })).toBe(true)
	})

	test("detects OpenInference keys", () => {
		expect(isAiSpan({ "input.value": "hi" })).toBe(true)
		expect(isAiSpan({ "output.value": "hi" })).toBe(true)
	})

	test("detects a single AI key among many non-AI keys", () => {
		expect(
			isAiSpan({
				"service.name": "web",
				"http.method": "POST",
				"http.status_code": "200",
				"ai.model.id": "ignored-not-in-fts-keys",
				"ai.prompt": "tell me a joke",
			}),
		).toBe(true)
	})

	test("ignores AI-adjacent keys that are not in the FTS set", () => {
		// `ai.model.provider`, `ai.settings.*`, `ai.telemetry.*` carry
		// metadata, not content, so they intentionally aren't part of
		// AI_FTS_KEYS. A span with ONLY those should not be flagged.
		expect(
			isAiSpan({
				"ai.model.provider": "openai",
				"ai.model.id": "gpt-4",
				"ai.settings.maxRetries": "2",
			}),
		).toBe(false)
	})

	test("every documented key triggers detection", () => {
		// Guard against a future reshuffle of AI_FTS_KEYS that might
		// drop a key silently — every declared key should round-trip.
		for (const key of AI_FTS_KEYS) {
			expect(isAiSpan({ [key]: "payload" })).toBe(true)
		}
	})
})
