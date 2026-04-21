import { type ChatFixture, makeDetail, makeSpan } from "./index.ts"

// Older AI SDK captures stored `ai.prompt` as a plain string instead
// of a structured `{ messages: [...] }` object. Renderer should fall
// back to a single PROMPT (raw) block. Smoke-test for the fallback
// path.
export const rawPromptFixture: ChatFixture = {
	id: "raw-prompt",
	label: "raw",
	span: makeSpan(),
	detail: makeDetail({
		promptMessages:
			"Summarise the following: a long bare prompt with no message structure. Imagine this is how an older ai-sdk version captured the conversation. It's just one opaque text blob that used to flow into the model.",
		responseText: "Here's a one-line summary.",
	}),
}
