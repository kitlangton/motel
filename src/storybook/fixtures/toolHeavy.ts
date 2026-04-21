import { type ChatFixture, makeDetail, makeSpan } from "./index.ts"

// Realistic multi-turn session with bash + read + edit tool calls and
// tool results. Mirrors the shape we saw in actual opencode traces.
// Exercises: smart tool-input summaries, consecutive tool calls,
// bounded tool-result rendering, reasoning blocks.
export const toolHeavyFixture: ChatFixture = {
	id: "tool-heavy",
	label: "tools",
	span: makeSpan({ operationName: "ai.streamText", durationMs: 9_400 }),
	detail: makeDetail({
		durationMs: 9_400,
		finishReason: "tool-calls",
		usage: {
			inputTokens: 135_131,
			outputTokens: 943,
			totalTokens: 136_074,
			cachedInputTokens: 133_818,
			reasoningTokens: null,
		},
		promptMessages: {
			messages: [
				{
					role: "system",
					content: Array.from(
						{ length: 120 },
						(_, i) =>
							`System rule ${i}: long boilerplate content goes here that nobody usually needs to read inline`,
					).join("\n"),
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Can you review the formatter changes in PR 23020 and tell me if it looks like a regression?",
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "reasoning",
							text: "I should inspect the current worktree state and compare it against the PR diff. Starting with `git status` and then grabbing the diff from GitHub.",
						},
						{
							type: "tool-call",
							toolCallId: "tc-1",
							toolName: "bash",
							input: {
								command: "git status --short --branch",
								timeout: 120_000,
								workdir: "/Users/kit/code/open-source/opencode",
								description: "Show branch state",
							},
						},
						{
							type: "tool-call",
							toolCallId: "tc-2",
							toolName: "bash",
							input: {
								command: "git worktree list",
								timeout: 120_000,
								workdir: "/Users/kit/code/open-source/opencode",
							},
						},
						{
							type: "tool-call",
							toolCallId: "tc-3",
							toolName: "bash",
							input: {
								command:
									"gh pr view 23020 --json title,headRefName,baseRefName,author,url,files",
								timeout: 120_000,
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
								type: "text",
								value:
									"## dev...origin/dev [ahead 8, behind 11]\n M packages/opencode/specs/effect/loose-ends.md",
							},
						},
						{
							type: "tool-result",
							toolCallId: "tc-2",
							toolName: "bash",
							output: {
								type: "text",
								value: [
									"/Users/kit/code/open-source/opencode                       6b7f34df2 [dev]",
									"/private/tmp/oc-repro-22872                                69f7182f0 [kit/repro-write-lsp-hang]",
									"/private/tmp/opencode-pr22385-base                         87b2a9d74 (detached HEAD)",
									"/Users/kit/code/open-source/opencode-1.4.7                 9f201d637 (detached HEAD)",
									"/Users/kit/code/open-source/opencode-await-thenable        343a56418 [kit/oxlint-await-thenable]",
									"/Users/kit/code/open-source/opencode-config-httpapi        df7e2fe63 [kit/config-httpapi]",
								].join("\n"),
							},
						},
						{
							type: "tool-result",
							toolCallId: "tc-3",
							toolName: "bash",
							output: {
								type: "text",
								value:
									'{"title":"fix: add formatter","headRefName":"pr-23020","baseRefName":"dev","url":"https://github.com/anomalyco/opencode/pull/23020","files":[{"path":"packages/opencode/src/formatter.ts","additions":43,"deletions":12}]}',
							},
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Let me read the actual formatter diff to see what changed in detail.",
						},
						{
							type: "tool-call",
							toolCallId: "tc-4",
							toolName: "read",
							input: {
								filePath:
									"/Users/kit/code/open-source/opencode/packages/opencode/src/formatter.ts",
							},
						},
						{
							type: "tool-call",
							toolCallId: "tc-5",
							toolName: "read",
							input: {
								filePath:
									"/Users/kit/code/open-source/opencode/packages/opencode/src/formatter.test.ts",
								offset: 1,
								limit: 200,
							},
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "tc-4",
							toolName: "read",
							output: {
								type: "text",
								value: Array.from(
									{ length: 60 },
									(_, i) => `${i + 1}: // formatter source line ${i}`,
								).join("\n"),
							},
						},
						{
							type: "tool-result",
							toolCallId: "tc-5",
							toolName: "read",
							output: {
								type: "text",
								value: Array.from(
									{ length: 30 },
									(_, i) =>
										`${i + 1}: test("case ${i}", () => { expect(x).toBe(y) })`,
								).join("\n"),
							},
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "The diff changes how trailing newlines are emitted. It looks intentional — they're aligning the output with what prettier does downstream. I wouldn't flag it as a regression.",
						},
						{
							type: "tool-call",
							toolCallId: "tc-6",
							toolName: "todowrite",
							input: {
								todos: [
									{ title: "verify tests still pass" },
									{ title: "comment on the PR" },
									{ title: "merge if CI green" },
								],
							},
						},
					],
				},
			],
		},
		responseText:
			"Not a regression. The formatter change aligns with how prettier emits trailing newlines; the test still covers the behaviour. I'd approve it.",
	}),
}
