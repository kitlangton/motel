// Pure transforms that turn an AiCallDetail into a list of semantic
// "chunks" — the navigation unit in the chat view. Rendering from
// chunks to viewport lines is a separate step so the view can react
// to expansion state + width without rebuilding the model.
//
// A chunk is one logical piece of a conversation: a system prompt, a
// user text turn, an assistant text/reasoning block, a single tool
// call, a single tool result, or the trailing response. Each gets a
// stable id (`m{messageIndex}p{partIndex}`) so the UI can remember
// which chunks are expanded and which is selected across re-renders.

import { wrapTextLines } from "./format.ts"

// ---------------------------------------------------------------------------
// Roles + chunk kinds
// ---------------------------------------------------------------------------

export type Role =
	| "system"
	| "user"
	| "assistant"
	| "tool"
	| "response"
	| "unknown"

export type ChunkKind =
	| "system"
	| "user-text"
	| "assistant-text"
	| "reasoning"
	| "tool-call"
	| "tool-result"
	| "response"
	| "raw-prompt"
	| "unknown"

/**
 * A single navigable chunk. Width-independent: produced once per
 * detail, then rendered to lines on demand with the current viewport
 * width. Storing stable `id`s lets us keep expansion + selection
 * across re-renders without re-deriving state.
 */
export interface Chunk {
	readonly id: string
	readonly kind: ChunkKind
	readonly role: Role
	readonly messageIndex: number
	readonly partIndex: number
	/** One-line header label (e.g. "SYSTEM", "→ bash  git status", "← read"). */
	readonly header: string
	/** Optional right-aligned metadata for the header (byte count, etc). */
	readonly headerMeta: string | null
	/** Full body text. For purely-header chunks like tool-calls, may be ""; for
	 *  text-only chunks like user-text this is the message content. */
	readonly body: string
	/** Whether to render a chunk-header row for this chunk. Plain text kinds
	 *  (user-text, assistant-text, system when expanded, response, raw-prompt)
	 *  skip it — the role divider rendered once per turn provides enough
	 *  context. Tool calls, tool results, reasoning, and unknown parts get
	 *  their own header because they need to show the tool name / kind. */
	readonly needsHeader: boolean
	/** Whether the user can expand this chunk for more detail. */
	readonly collapsible: boolean
	/** When true, body is hidden by default unless expanded. When false the
	 *  body is always shown in full. */
	readonly collapsedByDefault: boolean
	/** For tool chunks only — lets consumers correlate calls with results
	 *  and later cross-reference child spans in the trace. */
	readonly toolName?: string
	readonly toolCallId?: string
}

/** One row in the main chat list. */
export interface ChatListRow {
	readonly kind: "separator" | "role-divider" | "chunk"
	readonly role: Role
	readonly chunkId: string | null
	readonly text: string
	readonly meta: string | null
}

// ---------------------------------------------------------------------------
// Content sanitisation
//
// LLM prompts and tool outputs routinely contain data URLs (images
// pasted into a chat, files embedded as base64) and absurdly long
// single-field values. Scrubbing these before wrap keeps the viewport
// readable without losing the signal that they were there.
// ---------------------------------------------------------------------------

const MAX_INLINE_TEXT_LEN = 8_000

const formatKilo = (n: number) =>
	n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`

const scrubDataUrls = (text: string): string =>
	text.replace(
		/data:([\w./+-]+);base64,[A-Za-z0-9+/=]+/g,
		(_m, mime: string) => `[data:${mime} base64 ${formatKilo(_m.length)}]`,
	)

const sanitizeText = (text: string): string => {
	const scrubbed = scrubDataUrls(text)
	if (scrubbed.length <= MAX_INLINE_TEXT_LEN) return scrubbed
	return `${scrubbed.slice(0, MAX_INLINE_TEXT_LEN)}\u2026 [${formatKilo(scrubbed.length)} chars total]`
}

// ---------------------------------------------------------------------------
// Tool-input summarisation
// ---------------------------------------------------------------------------

const NOISY_INPUT_KEYS = new Set([
	"timeout",
	"workdir",
	"description",
	"filter",
	"outputFormat",
	"heredoc_delimiter",
])

const shorten = (text: string, width: number) => {
	const scrubbed = scrubDataUrls(text).replace(/\s+/g, " ").trim()
	if (scrubbed.length <= width) return scrubbed
	return `${scrubbed.slice(0, Math.max(1, width - 1))}\u2026`
}

const pickPrimaryField = (input: Record<string, unknown>): string | null => {
	const preferred = [
		"command",
		"filePath",
		"file_path",
		"path",
		"url",
		"query",
		"pattern",
		"title",
		"name",
		"prompt",
	]
	for (const key of preferred) {
		const value = input[key]
		if (typeof value === "string" && value.length > 0) return value
	}
	return null
}

interface ToolSummary {
	readonly inline: string
	readonly fullJson: string
}

const summarizeToolInput = (
	toolName: string,
	input: unknown,
	inlineWidth: number,
): ToolSummary => {
	const toJson = () => {
		try {
			return JSON.stringify(input, null, 2)
		} catch {
			return String(input)
		}
	}
	const fullJson = toJson()

	if (input == null) return { inline: "", fullJson }
	if (typeof input === "string")
		return { inline: shorten(input, inlineWidth), fullJson }
	if (typeof input !== "object")
		return { inline: shorten(String(input), inlineWidth), fullJson }

	const obj = input as Record<string, unknown>

	if (toolName === "todowrite" && Array.isArray(obj.todos)) {
		return {
			inline: `${obj.todos.length} todo${obj.todos.length === 1 ? "" : "s"}`,
			fullJson,
		}
	}
	if (toolName === "task" && typeof obj.description === "string") {
		const sub =
			typeof obj.subagent_type === "string" ? ` [${obj.subagent_type}]` : ""
		return {
			inline: shorten(`${obj.description}${sub}`, inlineWidth),
			fullJson,
		}
	}
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		const path = obj.filePath ?? obj.file_path ?? obj.path
		if (typeof path === "string") {
			const offset = typeof obj.offset === "number" ? ` @${obj.offset}` : ""
			const limit = typeof obj.limit === "number" ? ` +${obj.limit}` : ""
			return { inline: `${path}${offset}${limit}`, fullJson }
		}
	}

	const primaryValue = pickPrimaryField(obj)
	if (primaryValue)
		return { inline: shorten(primaryValue, inlineWidth), fullJson }

	const compact = (() => {
		try {
			return JSON.stringify(
				Object.fromEntries(
					Object.entries(obj).filter(([k]) => !NOISY_INPUT_KEYS.has(k)),
				),
			)
		} catch {
			return String(obj)
		}
	})()
	return { inline: shorten(compact, inlineWidth), fullJson }
}

// ---------------------------------------------------------------------------
// Tool-result body extraction
// ---------------------------------------------------------------------------

const extractToolResultBody = (output: unknown): string => {
	if (typeof output === "string") return output
	if (output && typeof output === "object") {
		const asObj = output as {
			readonly type?: string
			readonly value?: unknown
			readonly text?: unknown
		}
		if (asObj.type === "text" && typeof asObj.value === "string")
			return asObj.value
		if (typeof asObj.text === "string") return asObj.text
		try {
			return JSON.stringify(output, null, 2)
		} catch {
			return String(output)
		}
	}
	return output == null ? "" : String(output)
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

interface Message {
	readonly role?: string
	readonly content?: unknown
}

const normalizeRole = (role: string | undefined): Role => {
	switch (role) {
		case "system":
		case "user":
		case "assistant":
		case "tool":
			return role
		default:
			return "unknown"
	}
}

const extractMessages = (messages: unknown): readonly Message[] => {
	if (!messages) return []
	if (Array.isArray(messages)) return messages as readonly Message[]
	if (typeof messages === "object" && messages !== null) {
		const nested = (messages as { messages?: unknown }).messages
		if (Array.isArray(nested)) return nested as readonly Message[]
	}
	return []
}

// ---------------------------------------------------------------------------
// Chunk building
// ---------------------------------------------------------------------------

/** Soft cap: how many wrapped lines a tool-result renders when collapsed. */
const TOOL_RESULT_PREVIEW_LINES = 8
/** Soft cap for a system-prompt preview in collapsed state. */
const SYSTEM_PREVIEW_LINES = 0 // hidden entirely when collapsed; header-only

const chunkId = (messageIndex: number, partIndex: number, suffix = "") =>
	`m${messageIndex}p${partIndex}${suffix ? `-${suffix}` : ""}`

/**
 * Build the navigable chunks for an AI call detail. Width-independent:
 * tool-input summaries are formatted against a generous target width
 * (80 cols) and the view is expected to re-wrap when it renders. This
 * lets us keep chunk identity stable across viewport resizes.
 */
export const buildChunks = (
	detail: {
		readonly promptMessages: unknown
		readonly responseText: string | null
	} | null,
): readonly Chunk[] => {
	if (!detail) return []

	const chunks: Chunk[] = []
	const messages = extractMessages(detail.promptMessages)

	// Legacy ai.prompt-as-string: no messages, just a raw blob.
	if (messages.length === 0 && typeof detail.promptMessages === "string") {
		const raw = sanitizeText(detail.promptMessages as string)
		chunks.push({
			id: chunkId(0, 0),
			kind: "raw-prompt",
			role: "user",
			messageIndex: 0,
			partIndex: 0,
			header: "PROMPT (raw)",
			headerMeta: `${formatKilo(raw.length)} chars`,
			body: raw,
			needsHeader: false,
			collapsible: true,
			collapsedByDefault: false,
		})
	}

	messages.forEach((message, mi) => {
		const role = normalizeRole(message.role)
		const content = message.content

		// Skip empty messages — render-wise they'd leave a naked role header.
		if (
			content == null ||
			(typeof content === "string" && content.length === 0) ||
			(Array.isArray(content) && content.length === 0)
		) {
			return
		}

		if (role === "system" && typeof content === "string") {
			const sanitized = sanitizeText(content)
			chunks.push({
				id: chunkId(mi, 0),
				kind: "system",
				role: "system",
				messageIndex: mi,
				partIndex: 0,
				header: "SYSTEM",
				headerMeta: `${formatKilo(sanitized.length)} chars`,
				body: sanitized,
				// System prompts keep their own "SYSTEM" header so the
				// collapse marker (▸/▾) + char count have somewhere to
				// sit when collapsed by default. The role divider just
				// above renders "SYSTEM" again — acceptable since the
				// collapsed system chunk has no body text visible.
				needsHeader: true,
				collapsible: true,
				collapsedByDefault: true,
			})
			return
		}

		if (typeof content === "string") {
			const sanitized = sanitizeText(content)
			chunks.push({
				id: chunkId(mi, 0),
				kind:
					role === "assistant"
						? "assistant-text"
						: role === "user"
							? "user-text"
							: "unknown",
				role,
				messageIndex: mi,
				partIndex: 0,
				header: role.toUpperCase(),
				headerMeta: null,
				body: sanitized,
				needsHeader: false,
				collapsible: false,
				collapsedByDefault: false,
			})
			return
		}

		if (!Array.isArray(content)) return

		content.forEach((part, pi) => {
			if (!part || typeof part !== "object") return
			const t = (part as { readonly type?: string }).type

			if (t === "text") {
				const text = sanitizeText(
					(part as { readonly text?: string }).text ?? "",
				)
				if (!text) return
				chunks.push({
					id: chunkId(mi, pi),
					kind:
						role === "assistant"
							? "assistant-text"
							: role === "user"
								? "user-text"
								: "unknown",
					role,
					messageIndex: mi,
					partIndex: pi,
					header: role.toUpperCase(),
					headerMeta: null,
					body: text,
					needsHeader: false,
					collapsible: false,
					collapsedByDefault: false,
				})
				return
			}

			if (t === "reasoning") {
				const text = sanitizeText(
					(part as { readonly text?: string }).text ?? "",
				)
				if (!text) return
				chunks.push({
					id: chunkId(mi, pi),
					kind: "reasoning",
					role,
					messageIndex: mi,
					partIndex: pi,
					header: "reasoning",
					headerMeta: `${formatKilo(text.length)} chars`,
					body: text,
					needsHeader: true,
					collapsible: true,
					collapsedByDefault: true,
				})
				return
			}

			if (t === "tool-call") {
				const tc = part as {
					readonly toolName?: string
					readonly toolCallId?: string
					readonly input?: unknown
				}
				const name = tc.toolName ?? "tool"
				const summary = summarizeToolInput(name, tc.input, 80)
				const header = summary.inline
					? `\u2192 ${name}  ${summary.inline}`
					: `\u2192 ${name}`
				chunks.push({
					id: chunkId(mi, pi),
					kind: "tool-call",
					role,
					messageIndex: mi,
					partIndex: pi,
					header,
					headerMeta: null,
					body: summary.fullJson,
					needsHeader: true,
					collapsible:
						summary.fullJson.length > 0 &&
						summary.fullJson.length > summary.inline.length,
					collapsedByDefault: true,
					toolName: name,
					toolCallId: tc.toolCallId,
				})
				return
			}

			if (t === "tool-result") {
				const tr = part as {
					readonly toolName?: string
					readonly toolCallId?: string
					readonly output?: unknown
				}
				const name = tr.toolName ?? "tool"
				const rawBody = extractToolResultBody(tr.output)
				const body = sanitizeText(rawBody)
				chunks.push({
					id: chunkId(mi, pi),
					kind: "tool-result",
					role,
					messageIndex: mi,
					partIndex: pi,
					header: `\u2190 ${name}`,
					headerMeta:
						body.length > 0 ? `${formatKilo(body.length)} chars` : "(empty)",
					body,
					needsHeader: true,
					collapsible: body.length > 0,
					// Long results collapse by default; short ones inline.
					collapsedByDefault:
						body.length > 240 ||
						body.split("\n").length > TOOL_RESULT_PREVIEW_LINES,
					toolName: name,
					toolCallId: tr.toolCallId,
				})
				return
			}

			// Unknown content-part type.
			let body = ""
			try {
				body = JSON.stringify(part, null, 2)
			} catch {
				body = String(part)
			}
			chunks.push({
				id: chunkId(mi, pi),
				kind: "unknown",
				role,
				messageIndex: mi,
				partIndex: pi,
				header: `[${t ?? "unknown"}]`,
				headerMeta: `${formatKilo(body.length)} chars`,
				body,
				needsHeader: true,
				collapsible: body.length > 0,
				collapsedByDefault: true,
			})
		})
	})

	if (detail.responseText && detail.responseText.length > 0) {
		chunks.push({
			id: chunkId(messages.length, 0, "response"),
			kind: "response",
			role: "response",
			messageIndex: messages.length,
			partIndex: 0,
			header: "RESPONSE",
			headerMeta: null,
			body: sanitizeText(detail.responseText),
			needsHeader: false,
			collapsible: false,
			collapsedByDefault: false,
		})
	}

	return chunks
}

const firstBodyLine = (body: string) => {
	const line = body.split("\n").find((part) => part.trim().length > 0) ?? ""
	return line.replace(/\s+/g, " ").trim()
}

const stripTransportGlyph = (text: string) => text.replace(/^[→←]\s+/, "")

const toolRowPreview = (text: string, width = 40) => {
	const compact = firstBodyLine(text)
	return compact.length > 0 ? shorten(compact, width) : null
}

/**
 * Stable list rows for the main chat pane. One role divider per turn,
 * one selectable row per chunk. Plain text chunks use their first body
 * line as the row text; structured chunks (tool call/result, reasoning,
 * system) use their explicit header.
 */
export const buildChatListRows = (
	chunks: readonly Chunk[],
): readonly ChatListRow[] => {
	const rows: ChatListRow[] = []
	const toolCallById = new Map<string, Chunk>()
	for (const chunk of chunks) {
		if (chunk.kind === "tool-call" && chunk.toolCallId)
			toolCallById.set(chunk.toolCallId, chunk)
	}
	let prevRole: Role | null = null
	let prevMessageIndex = -1

	for (const chunk of chunks) {
		const roleChanged =
			chunk.role !== prevRole || chunk.messageIndex !== prevMessageIndex
		if (roleChanged) {
			if (rows.length > 0) {
				rows.push({
					kind: "separator",
					role: "unknown",
					chunkId: null,
					text: "",
					meta: null,
				})
			}
			rows.push({
				kind: "role-divider",
				role: chunk.role,
				chunkId: null,
				text: chunk.role.toUpperCase(),
				meta: null,
			})
		}

		let text = chunk.header
		let meta = chunk.headerMeta
		if (!chunk.needsHeader) {
			text = firstBodyLine(chunk.body)
			meta = null
		}
		// Main list rows add their own semantic prefix glyph via
		// `rowPrefix()` in AiChatView, so strip the transport glyph from
		// structured chunk headers here. Otherwise tool rows render as
		// `→ → bash ...` and results as `← ← read ...`.
		if (chunk.kind === "tool-call" || chunk.kind === "tool-result") {
			text = stripTransportGlyph(text)
		}

		if (chunk.kind === "tool-call") {
			const preview = toolRowPreview(chunk.body)
			// Keep row text focused on the primary action (already encoded in
			// `header`) and use the dim right column for "there is more here"
			// metadata only when it adds signal. For JSON-heavy tool args this
			// is usually just noise, so we currently leave meta alone.
			if (preview && preview !== text) {
				meta = meta ?? null
			}
		}

		if (chunk.kind === "tool-result") {
			const matchingCall = chunk.toolCallId
				? (toolCallById.get(chunk.toolCallId) ?? null)
				: null
			if (matchingCall) {
				// Carry the originating call summary into the result row so the
				// list can answer "result of what?" without opening the modal.
				// Example: `← bash  git status --short --branch`,
				// `← read  /src/formatter.ts @40 +80`.
				text = stripTransportGlyph(matchingCall.header)
			}
			const preview = toolRowPreview(chunk.body)
			if (preview) {
				meta = chunk.headerMeta ? `${chunk.headerMeta} · ${preview}` : preview
			}
		}
		if (chunk.kind === "system") {
			text = "prompt"
		}
		if (text.length === 0) {
			text = chunk.kind.replace(/-/g, " ")
		}

		rows.push({
			kind: "chunk",
			role: chunk.role,
			chunkId: chunk.id,
			text,
			meta,
		})

		prevRole = chunk.role
		prevMessageIndex = chunk.messageIndex
	}

	return rows
}

/** Human-facing title for the detail modal. */
export const chunkDetailTitle = (chunk: Chunk): string => {
	if (chunk.kind === "system") return "SYSTEM PROMPT"
	if (chunk.kind === "raw-prompt") return "RAW PROMPT"
	if (chunk.kind === "response") return "RESPONSE"
	if (chunk.kind === "user-text") return "USER"
	if (chunk.kind === "assistant-text") return "ASSISTANT"
	if (chunk.kind === "reasoning") return "REASONING"
	if (chunk.kind === "tool-call")
		return chunk.toolName ? `TOOL CALL · ${chunk.toolName}` : "TOOL CALL"
	if (chunk.kind === "tool-result")
		return chunk.toolName ? `TOOL RESULT · ${chunk.toolName}` : "TOOL RESULT"
	return chunk.header.toUpperCase()
}

/**
 * Full wrapped body lines for the detail modal. Unlike the old in-line
 * expansion view this is always the complete chunk body, never a preview.
 */
export const renderChunkDetailLines = (
	chunk: Chunk,
	width: number,
): readonly string[] => {
	const usableWidth = Math.max(16, width)
	const source = chunk.body.length > 0 ? chunk.body : chunk.header
	return wrapTextLines(source, usableWidth, 4_000)
}

// ---------------------------------------------------------------------------
// Rendering chunks → viewport lines
// ---------------------------------------------------------------------------

export type ChatLineKind =
	| "role-divider"
	| "chunk-header"
	| "text"
	| "reasoning"
	| "tool-call-body"
	| "tool-result-body"
	| "hint"
	| "separator"
	| "empty"

export interface ChatLine {
	readonly kind: ChatLineKind
	readonly role: Role
	readonly text: string
	/** Right-aligned metadata for header lines only. */
	readonly headerMeta?: string
	/** Id of the chunk this line belongs to (or null for role dividers / separators). */
	readonly chunkId: string | null
}

/** Is this chunk currently showing its body? */
export const isChunkExpanded = (
	chunk: Chunk,
	expanded: ReadonlySet<string>,
): boolean => {
	if (!chunk.collapsible) return true
	const forceOpen = expanded.has(chunk.id)
	if (chunk.collapsedByDefault) return forceOpen
	const forceShut = expanded.has(`!${chunk.id}`)
	return !forceShut
}

/** Flip a chunk's visible state. Uses the pair `id` / `!id` so toggling can
 *  both force-open a default-collapsed chunk and force-shut a default-open
 *  one without losing track of which state is the "default". */
export const toggleChunkExpansion = (
	chunk: Chunk,
	expanded: ReadonlySet<string>,
): ReadonlySet<string> => {
	if (!chunk.collapsible) return expanded
	const next = new Set(expanded)
	if (chunk.collapsedByDefault) {
		if (next.has(chunk.id)) next.delete(chunk.id)
		else next.add(chunk.id)
	} else {
		const key = `!${chunk.id}`
		if (next.has(key)) next.delete(key)
		else next.add(key)
	}
	return next
}

export interface RenderOptions {
	readonly width: number
	readonly expanded: ReadonlySet<string>
}

/** Render chunks into a flat list of viewport lines. Each line carries
 *  its `chunkId` so the view can highlight the selected chunk and so we
 *  can compute a scroll offset that keeps a chosen chunk visible. */
export const renderChunks = (
	chunks: readonly Chunk[],
	options: RenderOptions,
): readonly ChatLine[] => {
	const { width, expanded } = options
	const wrapWidth = Math.max(24, width - 2)
	const bodyWidth = Math.max(16, wrapWidth - 2)
	const lines: ChatLine[] = []

	if (chunks.length === 0) {
		return [
			{
				kind: "empty",
				role: "unknown",
				text: "no chat content",
				chunkId: null,
			},
		]
	}

	// Two visual layers:
	//
	// 1. A role divider (USER / ASSISTANT / TOOL / SYSTEM / RESPONSE)
	//    renders once at every turn boundary. It's a lightweight title
	//    that anchors the reader and visually separates conversation
	//    beats without repeating per chunk.
	//
	// 2. Each chunk contributes either:
	//    - Text-kind chunks (user-text, assistant-text, response,
	//      raw-prompt): just their body, flush-indented under the role
	//      divider. No chunk-header row — `needsHeader` is false.
	//    - Structured chunks (reasoning, tool-call, tool-result, system,
	//      unknown): a chunk-header row carrying the kind + expand
	//      marker, followed by the body when expanded.
	//
	// Every rendered line carries the owning `chunkId` so the view can
	// draw a continuous left-edge selection bar across the chunk's
	// full footprint (header + body).
	let prevRole: Role | null = null
	let prevMessageIndex = -1

	for (const chunk of chunks) {
		const roleChanged =
			chunk.role !== prevRole || chunk.messageIndex !== prevMessageIndex
		if (roleChanged) {
			if (lines.length > 0) {
				lines.push({
					kind: "separator",
					role: "unknown",
					text: "",
					chunkId: null,
				})
			}
			lines.push({
				kind: "role-divider",
				role: chunk.role,
				text: chunk.role.toUpperCase(),
				chunkId: null,
			})
		}

		if (chunk.needsHeader) {
			lines.push({
				kind: "chunk-header",
				role: chunk.role,
				text: chunk.header,
				headerMeta: chunk.headerMeta ?? undefined,
				chunkId: chunk.id,
			})
		}

		const expandedNow = isChunkExpanded(chunk, expanded)

		if (expandedNow && chunk.body.length > 0) {
			const bodyKind: ChatLineKind =
				chunk.kind === "tool-call"
					? "tool-call-body"
					: chunk.kind === "tool-result"
						? "tool-result-body"
						: chunk.kind === "reasoning"
							? "reasoning"
							: chunk.kind === "unknown"
								? "hint"
								: "text"

			// Text bodies hang off the role divider with a small indent
			// so prose reads clean. Structured bodies (tool args, tool
			// results, reasoning) indent deeper so they're obviously
			// subordinate to their own chunk header.
			const indent = chunk.needsHeader ? "  " : " "
			const wrapped = wrapTextLines(
				chunk.body,
				chunk.needsHeader ? bodyWidth : wrapWidth,
				2_000,
			)
			for (const line of wrapped) {
				lines.push({
					kind: bodyKind,
					role: chunk.role,
					text: `${indent}${line}`,
					chunkId: chunk.id,
				})
			}
		}
		// Collapsed chunks: the header already shows the expand marker
		// + char count on the right; no "enter to expand" per-line hint.
		// The footer carries the keyboard hint globally.

		prevRole = chunk.role
		prevMessageIndex = chunk.messageIndex
	}

	return lines
}

/** Find the viewport line index where the given chunk's header lives.
 *  Returns -1 if the chunk isn't in the rendered list. */
export const chunkHeaderLineIndex = (
	lines: readonly ChatLine[],
	chunkId: string,
): number =>
	lines.findIndex((l) => l.kind === "chunk-header" && l.chunkId === chunkId)
