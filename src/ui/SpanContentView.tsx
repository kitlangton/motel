import { TextAttributes } from "@opentui/core"
import { useMemo } from "react"
import { isAiSpan, type TraceSpanItem } from "../domain.ts"
import { formatDuration, lifecycleLabel, wrapTextLines } from "./format.ts"
import {
	AlignedHeaderLine,
	BlankRow,
	Divider,
	PlainLine,
	TextLine,
} from "./primitives.tsx"
import { colors, SEPARATOR } from "./theme.ts"

/** Header above the attribute list: "SPAN CONTENT" + status/duration strip. */
export const SPAN_CONTENT_HEADER_ROWS = 4
/** Width of the indent used for wrapped lines of a stacked value. */
const VALUE_INDENT = "  "
/** Width of the leading marker column that signals "selected" on the cursor row. */
const CURSOR_WIDTH = 2

/**
 * Layout plan for a single attribute row. Each attribute renders as at least
 * two rows (key line + one wrapped value line) plus however many extra wrap
 * lines the value needs. We precompute row counts up front so the viewport
 * (j/k scroll) can pick exactly `bodyLines` worth of content without
 * measuring twice.
 */
interface AttrBlock {
	readonly key: string
	readonly valueLines: readonly string[]
	readonly rowCount: number
}

/**
 * Full-screen span content view (level 2). Triggered by pressing enter on
 * a span in the waterfall. Renders every tag stacked key-above-value with
 * no truncation and word-wrapping to fit the viewport. The selected
 * attribute is highlighted (accent color on the key, leading `▶`) and
 * `y` copies its value. Step 3 will branch AI-flagged spans into a
 * specialised chat-transcript view; this is the generic fallback that
 * also serves as the baseline for any non-AI span.
 */
export const SpanContentView = ({
	span,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedAttrIndex,
}: {
	readonly span: TraceSpanItem | null
	readonly contentWidth: number
	readonly bodyLines: number
	readonly paneWidth: number
	readonly selectedAttrIndex: number
}) => {
	if (!span) {
		return (
			<box
				flexDirection="column"
				width={paneWidth}
				height={bodyLines + SPAN_CONTENT_HEADER_ROWS}
				overflow="hidden"
			>
				<box paddingLeft={1} paddingRight={1}>
					<AlignedHeaderLine
						left="SPAN CONTENT"
						right="no span selected"
						width={contentWidth}
						rightFg={colors.muted}
					/>
				</box>
				<BlankRow />
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<PlainLine
						text="Select a span in the waterfall to view its full content."
						fg={colors.muted}
					/>
				</box>
			</box>
		)
	}

	const entries = Object.entries(span.tags)
	const selected = Math.max(0, Math.min(selectedAttrIndex, entries.length - 1))
	const valueWrapWidth = Math.max(
		16,
		contentWidth - VALUE_INDENT.length - CURSOR_WIDTH,
	)
	const aiFlag = isAiSpan(span.tags)

	// Block layout is memoised on entries identity — otherwise every j/k
	// press would rewrap every attribute's value even though only the
	// highlight moved.
	const blocks = useMemo<readonly AttrBlock[]>(() => {
		return entries.map(([key, value]) => {
			// Word-wrap with a generous line cap — the view is scrollable so
			// we can afford to show the whole value rather than forcing an
			// ellipsis. 200 lines covers enormous LLM prompts without
			// blowing up the render tree.
			const valueLines = wrapTextLines(value, valueWrapWidth, 200)
			return { key, valueLines, rowCount: 1 + Math.max(1, valueLines.length) }
		})
	}, [entries, valueWrapWidth])

	// Viewport: pick the contiguous window of blocks that (a) fits inside
	// bodyLines and (b) contains the selected block. We find the first
	// start index whose accumulated row count from there through `selected`
	// fits in the budget; that start is the window top. If the selected
	// block alone is larger than bodyLines we still render it — oversize
	// values just get cut at the pane edge, no ellipsis.
	const fitsFrom = (start: number) => {
		let rows = 0
		for (let i = start; i <= selected; i++) {
			rows += blocks[i]?.rowCount ?? 0
			if (rows > bodyLines) return false
		}
		return true
	}
	let windowStart = 0
	for (let i = 0; i <= selected; i++) {
		if (fitsFrom(i)) {
			windowStart = i
			break
		}
	}
	const visible: AttrBlock[] = []
	let visibleRows = 0
	for (let i = windowStart; i < blocks.length; i++) {
		const block = blocks[i]!
		if (visibleRows + block.rowCount > bodyLines && i > selected) break
		visible.push(block)
		visibleRows += block.rowCount
	}
	const firstVisibleIndex = windowStart

	const headerStatus = `${span.status} ${SEPARATOR} ${formatDuration(span.durationMs)}`
	const headerStatusColor = span.isRunning
		? colors.warning
		: span.status === "error"
			? colors.error
			: colors.passing

	return (
		<box
			flexDirection="column"
			width={paneWidth}
			height={bodyLines + SPAN_CONTENT_HEADER_ROWS}
			overflow="hidden"
		>
			<box paddingLeft={1} paddingRight={1}>
				<AlignedHeaderLine
					left="SPAN CONTENT"
					right={headerStatus}
					width={contentWidth}
					rightFg={headerStatusColor}
				/>
			</box>
			<box flexDirection="column" paddingLeft={1} paddingRight={1}>
				<TextLine>
					{aiFlag ? <span fg={colors.accent}>{"\u2726 "}</span> : null}
					<span fg={colors.text}>{span.operationName}</span>
				</TextLine>
				<TextLine>
					<span fg={colors.defaultService}>{span.serviceName}</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={colors.muted}>{span.scopeName ?? "no scope"}</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={span.isRunning ? colors.warning : colors.muted}>
						{lifecycleLabel(span)}
					</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={colors.muted}>{span.spanId.slice(0, 16)}</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={colors.count}>{`${entries.length} tags`}</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={colors.muted}>{`${selected + 1}/${entries.length}`}</span>
				</TextLine>
			</box>
			<Divider width={paneWidth} />
			<box flexDirection="column" paddingLeft={1} paddingRight={1}>
				{entries.length === 0 ? (
					<PlainLine text="No tags on this span." fg={colors.muted} />
				) : (
					visible.map((block, offset) => {
						const index = firstVisibleIndex + offset
						const isSelected = index === selected
						const keyColor = isSelected ? colors.accent : colors.count
						const cursor = isSelected ? "\u25b8 " : "  "
						return (
							<box key={`${span.spanId}-${block.key}`} flexDirection="column">
								<TextLine>
									<span fg={isSelected ? colors.accent : colors.separator}>
										{cursor}
									</span>
									<span
										fg={keyColor}
										attributes={isSelected ? TextAttributes.BOLD : undefined}
									>
										{block.key}
									</span>
								</TextLine>
								{block.valueLines.length === 0 ? (
									<TextLine>
										<span fg={colors.separator}>{VALUE_INDENT}</span>
										<span fg={colors.muted}>(empty)</span>
									</TextLine>
								) : (
									block.valueLines.map((line, i) => (
										<TextLine key={i}>
											<span fg={colors.separator}>{VALUE_INDENT}</span>
											<span fg={isSelected ? colors.text : colors.muted}>
												{line}
											</span>
										</TextLine>
									))
								)}
							</box>
						)
					})
				)}
			</box>
		</box>
	)
}
