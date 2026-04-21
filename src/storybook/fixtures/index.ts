// Shared fixture type for the AI-chat storybook. Each fixture is a
// label + a synthetic span + a synthetic AI call detail, in the same
// shape the real server returns. Prefer hand-crafted minimal examples
// over real captures — they exercise renderer cases deliberately and
// don't leak session content into the repo.

import type { AiCallDetail, TraceSpanItem } from "../../domain.ts"

export interface ChatFixture {
	readonly id: string
	readonly label: string
	readonly span: TraceSpanItem
	readonly detail: AiCallDetail
}

export const makeSpan = (
	overrides: Partial<TraceSpanItem> = {},
): TraceSpanItem => ({
	spanId: "fixture-span-0000",
	parentSpanId: null,
	operationName: "ai.streamText",
	serviceName: "storybook",
	scopeName: "ai",
	kind: "internal",
	status: "ok",
	startTime: new Date(),
	durationMs: 2400,
	isRunning: false,
	depth: 0,
	tags: {
		"ai.operationId": "ai.streamText",
		"ai.model.id": "claude-opus-4-7",
		"ai.model.provider": "anthropic",
		"ai.prompt.messages": "[]",
	},
	warnings: [],
	events: [],
	...overrides,
})

export const makeDetail = (
	overrides: Partial<AiCallDetail> = {},
): AiCallDetail => ({
	traceId: "fixture-trace-0000",
	spanId: "fixture-span-0000",
	operation: "streamText",
	service: "storybook",
	functionId: "story.demo",
	provider: "anthropic",
	model: "claude-opus-4-7",
	status: "ok",
	startedAt: new Date().toISOString(),
	durationMs: 2400,
	sessionId: "ses_fixture",
	userId: "kit",
	finishReason: "stop",
	promptMessages: null,
	responseText: null,
	toolCalls: [],
	toolsAvailable: null,
	providerMetadata: null,
	usage: {
		inputTokens: 1234,
		outputTokens: 321,
		totalTokens: 1555,
		cachedInputTokens: 0,
		reasoningTokens: null,
	},
	timing: {
		msToFirstChunk: null,
		msToFinish: null,
		avgOutputTokensPerSecond: null,
	},
	logs: [],
	...overrides,
})
