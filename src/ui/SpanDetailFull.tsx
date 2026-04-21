import { TextAttributes } from "@opentui/core"
import type { ReactNode } from "react"
import type { LogItem, TraceSpanItem } from "../domain.ts"
import {
	formatDuration,
	formatShortDate,
	formatTimestamp,
	lifecycleLabel,
	logSeverityColor,
	relevantLogAttributes,
	truncateText,
	wrapTextLines,
} from "./format.ts"
import { BlankRow, PlainLine, TextLine } from "./primitives.tsx"
import { colors, SEPARATOR } from "./theme.ts"

type Line = ReactNode

/**
 * Full-pane span detail view. Shows everything we know about a span:
 * - identifiers, timing, scope, kind, status
 * - all tags
 * - all events with all attributes
 * - all warnings
 * - all correlated logs with wrapped bodies and relevant attributes
 *
 * The view builds a flat array of rendered lines then slices it to `bodyLines`,
 * honoring a scroll offset so `j/k` scrolling can be wired later.
 */
export const SpanDetailFullView = ({
	span,
	logs,
	contentWidth,
	bodyLines,
	scrollOffset = 0,
}: {
	span: TraceSpanItem
	logs: readonly LogItem[]
	contentWidth: number
	bodyLines: number
	scrollOffset?: number
}) => {
	const lines: Line[] = []
	let key = 0
	const push = (node: Line) => lines.push(<box key={key++}>{node}</box>)

	// --- Header: operation + status line ---
	push(
		<TextLine>
			<span fg={colors.text} attributes={TextAttributes.BOLD}>
				{span.operationName}
			</span>
		</TextLine>,
	)
	push(
		<TextLine>
			<span fg={colors.defaultService}>{span.serviceName}</span>
			<span fg={colors.separator}>{SEPARATOR}</span>
			<span fg={colors.count}>{formatDuration(span.durationMs)}</span>
			<span fg={colors.separator}>{SEPARATOR}</span>
			<span fg={span.isRunning ? colors.warning : colors.muted}>
				{lifecycleLabel(span)}
			</span>
			<span fg={colors.separator}>{SEPARATOR}</span>
			<span fg={span.status === "error" ? colors.error : colors.passing}>
				{span.status}
			</span>
		</TextLine>,
	)
	push(<BlankRow />)

	// --- Metadata block ---
	const metaKeyWidth = 10
	const metaRow = (k: string, v: string, vFg: string = colors.text) => (
		<TextLine>
			<span fg={colors.count}>{k.padEnd(metaKeyWidth)}</span>
			<span fg={colors.muted}> </span>
			<span fg={vFg}>
				{truncateText(v, Math.max(8, contentWidth - metaKeyWidth - 1))}
			</span>
		</TextLine>
	)
	push(
		<TextLine>
			<span fg={colors.accent} attributes={TextAttributes.BOLD}>
				META
			</span>
		</TextLine>,
	)
	push(metaRow("span id", span.spanId))
	if (span.parentSpanId) push(metaRow("parent", span.parentSpanId))
	if (span.kind) push(metaRow("kind", span.kind))
	if (span.scopeName) push(metaRow("scope", span.scopeName))
	push(
		metaRow(
			"started",
			`${formatShortDate(span.startTime)} ${formatTimestamp(span.startTime)}`,
		),
	)
	push(metaRow("depth", String(span.depth), colors.muted))

	// --- Tags ---
	const tagEntries = Object.entries(span.tags)
	if (tagEntries.length > 0) {
		push(<BlankRow />)
		push(
			<TextLine>
				<span fg={colors.accent} attributes={TextAttributes.BOLD}>
					TAGS
				</span>
				<span fg={colors.muted}> ({tagEntries.length})</span>
			</TextLine>,
		)
		const maxKeyLen = Math.min(
			32,
			tagEntries.reduce((m, [k]) => Math.max(m, k.length), 0),
		)
		const valMaxWidth = Math.max(8, contentWidth - maxKeyLen - 2)
		for (const [tagKey, value] of tagEntries) {
			const keyStr =
				tagKey.length > maxKeyLen
					? `${tagKey.slice(0, maxKeyLen - 1)}\u2026`
					: tagKey.padEnd(maxKeyLen)
			const wrapped = wrapTextLines(value, valMaxWidth, 4)
			wrapped.forEach((line, idx) => {
				push(
					<TextLine>
						<span fg={colors.count}>
							{idx === 0 ? keyStr : " ".repeat(maxKeyLen)}
						</span>
						<span fg={colors.muted}> </span>
						<span fg={colors.text}>{line}</span>
					</TextLine>,
				)
			})
		}
	}

	// --- Warnings ---
	if (span.warnings.length > 0) {
		push(<BlankRow />)
		push(
			<TextLine>
				<span fg={colors.accent} attributes={TextAttributes.BOLD}>
					WARNINGS
				</span>
				<span fg={colors.muted}> ({span.warnings.length})</span>
			</TextLine>,
		)
		for (const warning of span.warnings) {
			for (const line of wrapTextLines(
				warning,
				Math.max(16, contentWidth - 2),
				4,
			)) {
				push(<PlainLine text={line} fg={colors.error} />)
			}
		}
	}

	// --- Events ---
	if (span.events.length > 0) {
		push(<BlankRow />)
		push(
			<TextLine>
				<span fg={colors.accent} attributes={TextAttributes.BOLD}>
					EVENTS
				</span>
				<span fg={colors.muted}> ({span.events.length})</span>
			</TextLine>,
		)
		for (const event of span.events) {
			push(
				<TextLine>
					<span fg={colors.muted}>{formatTimestamp(event.timestamp)}</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={colors.text}>{event.name}</span>
				</TextLine>,
			)
			const attrs = Object.entries(event.attributes)
			if (attrs.length > 0) {
				const attrKeyWidth = Math.min(
					24,
					attrs.reduce((m, [k]) => Math.max(m, k.length), 0),
				)
				const attrValWidth = Math.max(8, contentWidth - attrKeyWidth - 4)
				for (const [attrKey, attrVal] of attrs) {
					const wrapped = wrapTextLines(attrVal, attrValWidth, 2)
					wrapped.forEach((line, idx) => {
						push(
							<TextLine>
								<span fg={colors.muted}> </span>
								<span fg={colors.count}>
									{idx === 0
										? attrKey.length > attrKeyWidth
											? `${attrKey.slice(0, attrKeyWidth - 1)}\u2026`
											: attrKey.padEnd(attrKeyWidth)
										: " ".repeat(attrKeyWidth)}
								</span>
								<span fg={colors.muted}> </span>
								<span fg={colors.muted}>{line}</span>
							</TextLine>,
						)
					})
				}
			}
		}
	}

	// --- Logs ---
	if (logs.length > 0) {
		push(<BlankRow />)
		push(
			<TextLine>
				<span fg={colors.accent} attributes={TextAttributes.BOLD}>
					LOGS
				</span>
				<span fg={colors.muted}> ({logs.length})</span>
			</TextLine>,
		)
		for (const log of logs) {
			push(
				<TextLine>
					<span fg={colors.muted}>{formatTimestamp(log.timestamp)}</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={logSeverityColor(log.severityText)}>
						{log.severityText.toLowerCase()}
					</span>
					<span fg={colors.separator}>{SEPARATOR}</span>
					<span fg={colors.defaultService}>
						{log.scopeName ?? log.serviceName}
					</span>
				</TextLine>,
			)
			for (const line of wrapTextLines(
				log.body,
				Math.max(16, contentWidth - 2),
				8,
			)) {
				push(<PlainLine text={line} fg={colors.text} />)
			}
			const attrs = relevantLogAttributes(log)
			if (attrs.length > 0) {
				const attrKeyWidth = Math.min(
					22,
					attrs.reduce((m, [k]) => Math.max(m, k.length), 0),
				)
				const attrValWidth = Math.max(8, contentWidth - attrKeyWidth - 4)
				for (const [attrKey, attrVal] of attrs) {
					const wrapped = wrapTextLines(attrVal, attrValWidth, 2)
					wrapped.forEach((line, idx) => {
						push(
							<TextLine>
								<span fg={colors.muted}> </span>
								<span fg={colors.count}>
									{idx === 0
										? attrKey.length > attrKeyWidth
											? `${attrKey.slice(0, attrKeyWidth - 1)}\u2026`
											: attrKey.padEnd(attrKeyWidth)
										: " ".repeat(attrKeyWidth)}
								</span>
								<span fg={colors.muted}> </span>
								<span fg={colors.muted}>{line}</span>
							</TextLine>,
						)
					})
				}
			}
		}
	}

	// --- Slice by scroll ---
	const totalLines = lines.length
	const maxOffset = Math.max(0, totalLines - bodyLines)
	const offset = Math.min(Math.max(0, scrollOffset), maxOffset)
	const visible = lines.slice(offset, offset + bodyLines)

	return (
		<box flexDirection="column">
			{visible}
			{totalLines > bodyLines ? (
				<TextLine>
					<span fg={colors.muted}>
						{`\u2014 ${offset + 1}\u2013${Math.min(offset + bodyLines, totalLines)} of ${totalLines} lines${offset < maxOffset ? " \u00b7 j/k to scroll" : ""}`}
					</span>
				</TextLine>
			) : null}
		</box>
	)
}
