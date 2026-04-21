import { type ChatFixture, makeDetail, makeSpan } from "./index.ts"

// User pastes an image as a data URL alongside text. The renderer
// should replace the base64 blob with a compact `[data:image/png
// base64 NNk]` marker and leave the prose readable. Regression case
// for the "screen filled with base64" bug.
const base64Chunk = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD".repeat(
	1000,
)

export const imagePasteFixture: ChatFixture = {
	id: "image-paste",
	label: "image",
	span: makeSpan(),
	detail: makeDetail({
		promptMessages: {
			messages: [
				{ role: "system", content: "You are a code review assistant." },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `I captured this screenshot of the bug: data:image/png;base64,${base64Chunk}\n\nCan you tell me what's off about the formatting here?`,
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Based on the image, the top padding looks inconsistent between rows. Let me open the component to check.",
						},
						{
							type: "tool-call",
							toolCallId: "tc-1",
							toolName: "read",
							input: { filePath: "/src/ui/Row.tsx" },
						},
					],
				},
			],
		},
		responseText:
			"The padding comes from two different tokens; we should unify them.",
	}),
}
