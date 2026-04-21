import { TextAttributes } from "@opentui/core"
import type { LogItem, TraceSpanItem } from "../domain.ts"
import {
	formatTimestamp,
	logSeverityColor,
	relevantLogAttributes,
	truncateText,
	wrapTextLines,
} from "./format.ts"
import { BlankRow, PlainLine, TextLine } from "./primitives.tsx"
import { colors, SEPARATOR } from "./theme.ts"

/**
 * Inline-vs-stacked threshold for tag rendering.
 *
 * A tag renders **inline** (`key  value` on one row) when:
 *   - the key is ≤ INLINE_KEY_MAX chars AND
 *   - the value fits in the remaining width on one line AND
 *   - the value contains no newlines.
 *
 * Otherwise it **stacks** — the key gets its own row (full, no truncation)
 * and the value is wrapped below with a leading indent. Long LLM payloads
 * (`ai.prompt.messages`, `gen_ai.completion`, etc.) always hit the stacked
 * path, which is what makes them readable at a glance.
 */
const INLINE_KEY_MAX = 24
/** Max wrapped rows we'll spend on a single stacked value's content. */
const VALUE_WRAP_MAX_LINES = 4
/** Leading indent for stacked values — subtle but visible. */
const STACK_INDENT = "  "

interface TagRender {
	readonly key: string
	readonly value: string
	readonly inline: boolean
	readonly valueLines: readonly string[]
	readonly rowCount: number
}

const planTag = (
	key: string,
	value: string,
	contentWidth: number,
	inlineKeyPad: number,
): TagRender => {
	const hasNewline = value.includes("\n")
	const inlineValueWidth = Math.max(1, contentWidth - inlineKeyPad - 2)
	const canInline =
		!hasNewline &&
		key.length <= INLINE_KEY_MAX &&
		value.length <= inlineValueWidth
	if (canInline) {
		return { key, value, inline: true, valueLines: [value], rowCount: 1 }
	}
	const wrapWidth = Math.max(16, contentWidth - STACK_INDENT.length)
	const valueLines = wrapTextLines(value, wrapWidth, VALUE_WRAP_MAX_LINES)
	// 1 row for the key + N rows for wrapped value (at least 1).
	const rowCount = 1 + Math.max(1, valueLines.length)
	return { key, value, inline: false, valueLines, rowCount }
}

export const SpanDetailView = ({
	span,
	logs,
	contentWidth,
	bodyLines,
}: {
	span: TraceSpanItem
	logs: readonly LogItem[]
	contentWidth: number
	bodyLines: number
}) => {
	const tagEntries = Object.entries(span.tags)
	// Column width for inline keys. We cap at INLINE_KEY_MAX so a single
	// very-long key doesn't widen the column for everyone. Short keys still
	// align against each other.
	const inlineKeyPad = Math.min(
		INLINE_KEY_MAX,
		tagEntries.reduce(
			(max, [key]) =>
				key.length <= INLINE_KEY_MAX ? Math.max(max, key.length) : max,
			0,
		),
	)

	const maxLogLines =
		logs.length > 0 ? Math.min(4, Math.max(1, Math.floor(bodyLines * 0.3))) : 0
	const visibleLogs = logs.slice(0, maxLogLines)
	const visibleWarnings = span.warnings.slice(0, visibleLogs.length > 0 ? 1 : 2)
	const visibleEvents = span.events.slice(0, 2)
	const reservedForWarnings =
		visibleWarnings.length > 0 ? visibleWarnings.length + 2 : 0
	const reservedForEvents =
		visibleEvents.length > 0 ? visibleEvents.length + 2 : 0
	const reservedForLogs =
		visibleLogs.length > 0
			? visibleLogs.reduce(
					(total, log) =>
						total +
						3 +
						Math.min(
							3,
							wrapTextLines(log.body, Math.max(16, contentWidth - 2), 3).length,
						),
					1,
				)
			: 0
	// Budget for the TAGS section: total body minus header (TAGS row + blank)
	// minus every other section's reservation. Each stacked tag spends more
	// rows than an inline one so we plan the full visible set up-front rather
	// than slicing by entry count.
	const tagBudget = Math.max(
		0,
		bodyLines - 2 - reservedForWarnings - reservedForEvents - reservedForLogs,
	)

	const planned: TagRender[] = []
	let rowsUsed = 0
	let skipped = 0
	for (const [key, value] of tagEntries) {
		const plan = planTag(key, value, contentWidth, inlineKeyPad)
		if (rowsUsed + plan.rowCount > tagBudget) {
			skipped = tagEntries.length - planned.length
			break
		}
		planned.push(plan)
		rowsUsed += plan.rowCount
	}

	// NOTE: op name, service, duration, lifecycle, status, and spanId are all
	// rendered by the enclosing SpanDetailPane header (rows 0..2). Starting
	// the body at TAGS avoids the visible duplication where the pane meta
	// and the first two body lines mirrored each other.
	return (
		<box flexDirection="column">
			{tagEntries.length > 0 ? (
				<>
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>
							TAGS
						</span>
					</TextLine>
					{planned.map((tag) =>
						tag.inline ? (
							<TextLine key={tag.key}>
								<span fg={colors.count}>{tag.key.padEnd(inlineKeyPad)}</span>
								<span fg={colors.muted}> </span>
								<span fg={colors.text}>{tag.value}</span>
							</TextLine>
						) : (
							<box key={tag.key} flexDirection="column">
								<TextLine>
									<span fg={colors.count}>{tag.key}</span>
								</TextLine>
								{tag.valueLines.length === 0 ? (
									<TextLine>
										<span fg={colors.muted}>{STACK_INDENT}</span>
										<span fg={colors.muted}>(empty)</span>
									</TextLine>
								) : (
									tag.valueLines.map((line, index) => (
										<TextLine key={index}>
											<span fg={colors.muted}>{STACK_INDENT}</span>
											<span fg={colors.text}>{line}</span>
										</TextLine>
									))
								)}
							</box>
						),
					)}
					{skipped > 0 ? (
						<PlainLine
							text={`${STACK_INDENT}\u2026 ${skipped} more`}
							fg={colors.muted}
						/>
					) : null}
				</>
			) : (
				<PlainLine text="No tags on this span." fg={colors.muted} />
			)}
			{visibleWarnings.length > 0 ? (
				<>
					<BlankRow />
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>
							WARNINGS
						</span>
					</TextLine>
					{visibleWarnings.map((warning, i) => (
						<PlainLine key={i} text={warning} fg={colors.error} />
					))}
				</>
			) : null}
			{visibleEvents.length > 0 ? (
				<>
					<BlankRow />
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>
							EVENTS
						</span>
					</TextLine>
					{visibleEvents.map((event, index) => {
						const preview = Object.entries(event.attributes).slice(0, 1)
						return (
							<box key={`${event.name}-${index}`} flexDirection="column">
								<TextLine>
									<span fg={colors.muted}>
										{formatTimestamp(event.timestamp)}
									</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.text}>{event.name}</span>
								</TextLine>
								{preview.map(([key, value]) => (
									<TextLine key={`${event.name}-${key}`}>
										<span fg={colors.count}>
											{truncateText(key, 18).padEnd(18, " ")}
										</span>
										<span fg={colors.muted}> </span>
										<span fg={colors.muted}>
											{truncateText(value, Math.max(12, contentWidth - 20))}
										</span>
									</TextLine>
								))}
							</box>
						)
					})}
				</>
			) : null}
			{visibleLogs.length > 0 ? (
				<>
					<BlankRow />
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>
							RELATED LOGS
						</span>
					</TextLine>
					{visibleLogs.map((log) => {
						const logBodyLines = wrapTextLines(
							log.body,
							Math.max(16, contentWidth - 2),
							3,
						)
						const attributePreview = relevantLogAttributes(log).slice(0, 1)

						return (
							<box key={log.id} flexDirection="column">
								<TextLine>
									<span fg={colors.muted}>
										{formatTimestamp(log.timestamp)}
									</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={logSeverityColor(log.severityText)}>
										{log.severityText.toLowerCase()}
									</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.defaultService}>
										{log.scopeName ?? log.serviceName}
									</span>
								</TextLine>
								{logBodyLines.map((line, index) => (
									<PlainLine
										key={`${log.id}-body-${index}`}
										text={line}
										fg={colors.text}
									/>
								))}
								{attributePreview.map(([key, value]) => (
									<TextLine key={`${log.id}-${key}`}>
										<span fg={colors.count}>
											{truncateText(key, 18).padEnd(18, " ")}
										</span>
										<span fg={colors.muted}> </span>
										<span fg={colors.muted}>
											{truncateText(value, Math.max(12, contentWidth - 20))}
										</span>
									</TextLine>
								))}
							</box>
						)
					})}
				</>
			) : null}
		</box>
	)
}
