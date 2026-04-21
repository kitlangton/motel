import { RGBA, TextAttributes } from "@opentui/core"
import { useLayoutEffect, useMemo, useState } from "react"
import { isAiSpan, type TraceSpanItem } from "../domain.ts"
import {
	buildChatListRows,
	chunkDetailTitle,
	renderChunkDetailLines,
	type Chunk,
	type ChatListRow,
	type Role,
} from "./aiChatModel.ts"
import { formatDuration, truncateText } from "./format.ts"
import {
	AlignedHeaderLine,
	BlankRow,
	Divider,
	PlainLine,
	TextLine,
} from "./primitives.tsx"
import type { AiCallDetailState } from "./state.ts"
import { colors, SEPARATOR } from "./theme.ts"

export const AI_CHAT_HEADER_ROWS = 4

const roleColor = (role: Role): string => {
	switch (role) {
		case "user":
			return colors.accent
		case "assistant":
			return colors.text
		case "system":
			return colors.muted
		case "tool":
			return colors.passing
		case "response":
			return colors.accent
		default:
			return colors.muted
	}
}

const rowPrefix = (chunk: Chunk | null): string => {
	if (!chunk) return "  "
	switch (chunk.kind) {
		case "tool-call":
			return "→ "
		case "tool-result":
			return "← "
		case "reasoning":
			return "• "
		case "response":
			return "↳ "
		default:
			return ""
	}
}

const rowTextColor = (
	chunk: Chunk | null,
	role: Role,
	selected: boolean,
): string => {
	if (selected) return colors.selectedText
	if (!chunk) return roleColor(role)
	if (chunk.kind === "tool-call") return colors.count
	if (chunk.kind === "tool-result") return colors.passing
	if (chunk.kind === "reasoning") return colors.muted
	if (chunk.kind === "system") return colors.muted
	return colors.text
}

const splitToolRowText = (
	text: string,
): { readonly head: string; readonly tail: string | null } => {
	const match = text.match(/\s{2,}/)
	const sep = match?.index ?? -1
	if (sep < 0) return { head: text, tail: null }
	return {
		head: text.slice(0, sep),
		tail: text.slice(sep + match![0].length),
	}
}

const clamp = (n: number, min: number, max: number) =>
	Math.max(min, Math.min(max, n))

const chunkRows = (rows: readonly ChatListRow[]) =>
	rows.filter((row) => row.kind === "chunk")

interface MouseScrollEvent {
	readonly scroll?: {
		readonly direction: string
		readonly delta: number
	}
	readonly stopPropagation?: () => void
}

const scrollDelta = (event: MouseScrollEvent): number => {
	const info = event.scroll
	if (!info) return 0
	const magnitude = Math.max(1, Math.round(info.delta))
	if (info.direction === "up") return -magnitude
	if (info.direction === "down") return magnitude
	return 0
}

const ChatDetailModal = ({
	chunk,
	scrollOffset,
	onScrollOffset,
	paneWidth,
	paneHeight,
	onClose,
}: {
	readonly chunk: Chunk
	readonly scrollOffset: number
	readonly onScrollOffset: (updater: (current: number) => number) => void
	readonly paneWidth: number
	readonly paneHeight: number
	readonly onClose: () => void
}) => {
	const modalWidth = Math.min(
		Math.max(56, Math.floor(paneWidth * 0.8)),
		paneWidth - 4,
	)
	const modalHeight = Math.min(
		Math.max(12, Math.floor(paneHeight * 0.75)),
		paneHeight - 2,
	)
	const left = Math.max(2, Math.floor((paneWidth - modalWidth) / 2))
	const top = Math.max(1, Math.floor((paneHeight - modalHeight) / 2))
	const innerWidth = Math.max(16, modalWidth - 4)
	const bodyLines = Math.max(4, modalHeight - 4)
	const lines = renderChunkDetailLines(chunk, innerWidth)
	const maxOffset = Math.max(0, lines.length - bodyLines)
	const offset = clamp(scrollOffset, 0, maxOffset)
	const visible = lines.slice(offset, offset + bodyLines)
	const meta = chunk.headerMeta ?? `${lines.length} lines`
	const handleWheel = (event: MouseScrollEvent) => {
		const delta = scrollDelta(event)
		if (delta === 0) return
		onScrollOffset((current) => clamp(current + delta, 0, maxOffset))
		event.stopPropagation?.()
	}

	return (
		<box
			position="absolute"
			zIndex={3500}
			left={0}
			top={0}
			width={paneWidth}
			height={paneHeight}
			backgroundColor={RGBA.fromInts(0, 0, 0, 110)}
			onMouseUp={onClose}
		>
			<box
				position="absolute"
				left={left}
				top={top}
				width={modalWidth}
				height={modalHeight}
				flexDirection="column"
				backgroundColor={RGBA.fromHex(colors.screenBg)}
				onMouseScroll={handleWheel}
			>
				<box paddingLeft={1} paddingRight={1}>
					<AlignedHeaderLine
						left={chunkDetailTitle(chunk)}
						right={`${meta} ${SEPARATOR} esc close`}
						width={modalWidth - 2}
						rightFg={colors.count}
					/>
				</box>
				<Divider width={modalWidth} />
				<box flexDirection="column" paddingLeft={2} paddingRight={2}>
					{visible.map((line, i) => (
						<PlainLine
							key={`detail-${i + offset}`}
							text={line}
							fg={colors.text}
						/>
					))}
					{visible.length < bodyLines
						? Array.from({ length: bodyLines - visible.length }, (_, i) => (
								<BlankRow key={`detail-pad-${i}`} />
							))
						: null}
				</box>
			</box>
		</box>
	)
}

export const AiChatView = ({
	span,
	detailState,
	chunks,
	selectedChunkId,
	onSelectChunk,
	detailChunkId,
	onOpenDetail,
	onCloseDetail,
	detailScrollOffset,
	onSetDetailScrollOffset,
	contentWidth,
	bodyLines,
	paneWidth,
}: {
	readonly span: TraceSpanItem | null
	readonly detailState: AiCallDetailState
	readonly chunks: readonly Chunk[]
	readonly selectedChunkId: string | null
	readonly onSelectChunk: (chunkId: string) => void
	readonly detailChunkId: string | null
	readonly onOpenDetail: (chunkId: string) => void
	readonly onCloseDetail: () => void
	readonly detailScrollOffset: number
	readonly onSetDetailScrollOffset: (
		updater: (current: number) => number,
	) => void
	readonly contentWidth: number
	readonly bodyLines: number
	readonly paneWidth: number
}) => {
	const rows = useMemo(() => buildChatListRows(chunks), [chunks])
	const selectable = useMemo(() => chunkRows(rows), [rows])
	const chunkById = useMemo(
		() => new Map(chunks.map((chunk) => [chunk.id, chunk] as const)),
		[chunks],
	)
	const selectedOrdinal = useMemo(
		() =>
			selectedChunkId
				? selectable.findIndex((row) => row.chunkId === selectedChunkId)
				: -1,
		[selectable, selectedChunkId],
	)
	const [scrollOffset, setScrollOffset] = useState(0)

	const detailChunk = useMemo(
		() => (detailChunkId ? (chunkById.get(detailChunkId) ?? null) : null),
		[chunkById, detailChunkId],
	)

	const selectedRowIndex = useMemo(
		() =>
			selectedChunkId
				? rows.findIndex(
						(row) => row.kind === "chunk" && row.chunkId === selectedChunkId,
					)
				: -1,
		[rows, selectedChunkId],
	)

	useLayoutEffect(() => {
		const maxOffset = Math.max(0, rows.length - bodyLines)
		if (selectedRowIndex < 0) {
			setScrollOffset((current) => clamp(current, 0, maxOffset))
			return
		}
		setScrollOffset((current) => {
			let next = clamp(current, 0, maxOffset)
			if (selectedRowIndex < next) next = selectedRowIndex
			else if (selectedRowIndex >= next + bodyLines)
				next = selectedRowIndex - bodyLines + 1
			return clamp(next, 0, maxOffset)
		})
	}, [rows.length, bodyLines, selectedRowIndex])

	if (!span || !isAiSpan(span.tags)) {
		return (
			<box
				flexDirection="column"
				width={paneWidth}
				height={bodyLines + AI_CHAT_HEADER_ROWS}
				overflow="hidden"
			>
				<box paddingLeft={1} paddingRight={1}>
					<AlignedHeaderLine
						left="AI CHAT"
						right="not an ai span"
						width={contentWidth}
						rightFg={colors.muted}
					/>
				</box>
			</box>
		)
	}

	const detail = detailState.data
	const model = detail?.model ?? span.tags["ai.model.id"] ?? "unknown model"
	const provider = detail?.provider ?? span.tags["ai.model.provider"] ?? null
	const operation = detail?.operation ?? span.operationName
	const finishReason = detail?.finishReason ?? null
	const usage = detail?.usage ?? null
	const durationLabel = formatDuration(detail?.durationMs ?? span.durationMs)
	const maxOffset = Math.max(0, rows.length - bodyLines)
	const offset = clamp(scrollOffset, 0, maxOffset)
	const visible = rows.slice(offset, offset + bodyLines)
	const headerRight = `${operation} ${SEPARATOR} ${durationLabel} ${SEPARATOR} ${selectable.length > 0 ? `${Math.max(1, selectedOrdinal + 1)}/${selectable.length}` : "0/0"}`
	const handleListWheel = (event: MouseScrollEvent) => {
		if (detailChunk) return
		const delta = scrollDelta(event)
		if (delta === 0) return
		setScrollOffset((current) => clamp(current + delta, 0, maxOffset))
		event.stopPropagation?.()
	}

	return (
		<box
			flexDirection="column"
			width={paneWidth}
			height={bodyLines + AI_CHAT_HEADER_ROWS}
			overflow="hidden"
		>
			<box paddingLeft={1} paddingRight={1}>
				<AlignedHeaderLine
					left="AI CHAT"
					right={headerRight}
					width={contentWidth}
					rightFg={colors.count}
				/>
			</box>
			<box flexDirection="column" paddingLeft={1} paddingRight={1}>
				<TextLine>
					<span fg={colors.accent} attributes={TextAttributes.BOLD}>
						{"✦ "}
					</span>
					<span fg={colors.text}>{model}</span>
					{provider ? (
						<>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{provider}</span>
						</>
					) : null}
					{finishReason ? (
						<>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{`finish=${finishReason}`}</span>
						</>
					) : null}
				</TextLine>
				<TextLine>
					{usage ? (
						<>
							<span fg={colors.muted}>{"tokens "}</span>
							<span fg={colors.count}>
								{usage.inputTokens != null ? `in=${usage.inputTokens}` : ""}
							</span>
							<span fg={colors.muted}>
								{usage.cachedInputTokens != null
									? ` cached=${usage.cachedInputTokens}`
									: ""}
							</span>
							<span fg={colors.count}>
								{usage.outputTokens != null ? ` out=${usage.outputTokens}` : ""}
							</span>
							<span fg={colors.muted}>
								{usage.reasoningTokens != null
									? ` reason=${usage.reasoningTokens}`
									: ""}
							</span>
						</>
					) : (
						<span fg={colors.muted}>
							{detail?.sessionId
								? `session ${detail.sessionId}`
								: "no usage reported"}
						</span>
					)}
				</TextLine>
			</box>
			<Divider width={paneWidth} />
			<box
				flexDirection="column"
				paddingLeft={1}
				paddingRight={1}
				onMouseScroll={handleListWheel}
			>
				{detailState.status === "loading" && !detail ? (
					<PlainLine text="loading chat transcript…" fg={colors.muted} />
				) : detailState.status === "error" ? (
					<PlainLine
						text={detailState.error ?? "failed to load chat detail"}
						fg={colors.error}
					/>
				) : rows.length === 0 ? (
					<PlainLine
						text="no chat content parsed from this span"
						fg={colors.muted}
					/>
				) : (
					visible.map((row, i) => {
						if (row.kind === "separator") {
							return <BlankRow key={`row-${offset + i}`} />
						}
						if (row.kind === "role-divider") {
							return (
								<TextLine key={`row-${offset + i}`}>
									<span fg={colors.separator}> </span>
									<span
										fg={roleColor(row.role)}
										attributes={TextAttributes.BOLD}
									>
										{row.text}
									</span>
								</TextLine>
							)
						}
						const chunk = row.chunkId
							? (chunkById.get(row.chunkId) ?? null)
							: null
						const isSelected = row.chunkId === selectedChunkId
						const prefix = rowPrefix(chunk)
						const meta = row.meta ?? ""
						const textWidth = Math.max(
							8,
							contentWidth - prefix.length - meta.length - 4,
						)
						const display = truncateText(row.text, textWidth)
						const gap = Math.max(
							1,
							contentWidth - prefix.length - display.length - meta.length - 1,
						)
						const toolLike =
							chunk?.kind === "tool-call" || chunk?.kind === "tool-result"
						const { head, tail } = toolLike
							? splitToolRowText(display)
							: { head: display, tail: null }
						const headColor = rowTextColor(chunk, row.role, isSelected)
						const tailColor = isSelected ? colors.muted : colors.separator
						return (
							<box
								key={`row-${offset + i}`}
								height={1}
								onMouseDown={() => {
									if (row.chunkId) onSelectChunk(row.chunkId)
								}}
							>
								<TextLine bg={isSelected ? colors.selectedBg : undefined}>
									<span
										fg={isSelected ? roleColor(row.role) : colors.separator}
									>
										{isSelected ? "▎" : " "}
									</span>
									<span
										fg={headColor}
										attributes={isSelected ? TextAttributes.BOLD : undefined}
									>{`${prefix}${head}`}</span>
									{tail ? <span fg={tailColor}>{` ${tail}`}</span> : null}
									{meta ? (
										<>
											<span fg={colors.muted}>{" ".repeat(gap)}</span>
											<span fg={colors.muted}>{meta}</span>
										</>
									) : null}
								</TextLine>
							</box>
						)
					})
				)}
				{visible.length < bodyLines && rows.length > 0
					? Array.from({ length: bodyLines - visible.length }, (_, i) => (
							<BlankRow key={`pad-${i}`} />
						))
					: null}
			</box>
			{detailChunk ? (
				<ChatDetailModal
					chunk={detailChunk}
					scrollOffset={detailScrollOffset}
					onScrollOffset={onSetDetailScrollOffset}
					paneWidth={paneWidth}
					paneHeight={bodyLines + AI_CHAT_HEADER_ROWS}
					onClose={onCloseDetail}
				/>
			) : null}
		</box>
	)
}
