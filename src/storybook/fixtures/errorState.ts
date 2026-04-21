import { type ChatFixture, makeDetail, makeSpan } from "./index.ts"

// A tool-call that errored mid-stream: finishReason === "error" and a
// tool-result whose output shape is irregular (object without the
// expected `type: "text"` wrapper). Covers graceful-degrade rendering.
export const errorFixture: ChatFixture = {
	id: "error",
	label: "error",
	span: makeSpan({ status: "error", durationMs: 820 }),
	detail: makeDetail({
		status: "error",
		finishReason: "error",
		durationMs: 820,
		promptMessages: {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Grab the latest commits from main." },
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "tc-1",
							toolName: "bash",
							input: {
								command:
									"git fetch origin main && git log --oneline -5 origin/main",
							},
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "tc-1",
							toolName: "bash",
							output: {
								error: "HTTP 429 rate limited",
								code: 429,
								retryable: true,
							},
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "The request was rate-limited. I'll retry after a delay — or you can rerun manually.",
						},
					],
				},
			],
		},
		responseText: null,
	}),
}
