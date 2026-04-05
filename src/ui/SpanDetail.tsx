import { TextAttributes } from "@opentui/core"
import type { LogItem, TraceSpanItem } from "../domain.ts"
import { formatDuration, formatTimestamp, logSeverityColor, relevantLogAttributes, truncateText, wrapTextLines } from "./format.ts"
import { BlankRow, PlainLine, TextLine } from "./primitives.tsx"
import { colors, SEPARATOR } from "./theme.ts"

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
	const maxKeyLen = Math.min(28, tagEntries.reduce((max, [key]) => Math.max(max, key.length), 0))
	const maxLogLines = logs.length > 0 ? Math.min(4, Math.max(1, Math.floor(bodyLines * 0.3))) : 0
	const visibleLogs = logs.slice(0, maxLogLines)
	const visibleWarnings = span.warnings.slice(0, visibleLogs.length > 0 ? 1 : 2)
	const visibleEvents = span.events.slice(0, 2)
	const reservedForWarnings = visibleWarnings.length > 0 ? visibleWarnings.length + 2 : 0
	const reservedForEvents = visibleEvents.length > 0 ? visibleEvents.length + 2 : 0
	const reservedForLogs = visibleLogs.length > 0 ? visibleLogs.reduce((total, log) => total + 3 + Math.min(3, wrapTextLines(log.body, Math.max(16, contentWidth - 2), 3).length), 1) : 0
	const maxTagLines = Math.max(0, bodyLines - 4 - reservedForWarnings - reservedForEvents - reservedForLogs)

	return (
		<box flexDirection="column">
			<TextLine>
				<span fg={colors.text}>{span.operationName}</span>
			</TextLine>
			<TextLine>
				<span fg={colors.defaultService}>{span.serviceName}</span>
				<span fg={colors.separator}>{SEPARATOR}</span>
				<span fg={colors.count}>{formatDuration(span.durationMs)}</span>
				<span fg={colors.separator}>{SEPARATOR}</span>
				<span fg={span.status === "error" ? colors.error : colors.passing}>{span.status}</span>
			</TextLine>
			<BlankRow />
			{tagEntries.length > 0 ? (
				<>
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>TAGS</span>
					</TextLine>
					{tagEntries.slice(0, maxTagLines).map(([key, value]) => {
						const keyStr = key.length > maxKeyLen ? `${key.slice(0, maxKeyLen - 1)}\u2026` : key.padEnd(maxKeyLen)
						const valMaxWidth = Math.max(8, contentWidth - maxKeyLen - 2)
						const valStr = value.length > valMaxWidth ? `${value.slice(0, valMaxWidth - 1)}\u2026` : value

						return (
							<TextLine key={key}>
								<span fg={colors.count}>{keyStr}</span>
								<span fg={colors.muted}>  </span>
								<span fg={colors.text}>{valStr}</span>
							</TextLine>
						)
					})}
					{tagEntries.length > maxTagLines ? (
						<PlainLine text={`  \u2026 ${tagEntries.length - maxTagLines} more`} fg={colors.muted} />
					) : null}
				</>
			) : (
				<PlainLine text="No tags on this span." fg={colors.muted} />
			)}
			{visibleWarnings.length > 0 ? (
				<>
					<BlankRow />
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>WARNINGS</span>
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
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>EVENTS</span>
					</TextLine>
					{visibleEvents.map((event, index) => {
						const preview = Object.entries(event.attributes).slice(0, 1)
						return (
							<box key={`${event.name}-${index}`} flexDirection="column">
								<TextLine>
									<span fg={colors.muted}>{formatTimestamp(event.timestamp)}</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.text}>{event.name}</span>
								</TextLine>
								{preview.map(([key, value]) => (
									<TextLine key={`${event.name}-${key}`}>
										<span fg={colors.count}>{truncateText(key, 18).padEnd(18, " ")}</span>
										<span fg={colors.muted}> </span>
										<span fg={colors.muted}>{truncateText(value, Math.max(12, contentWidth - 20))}</span>
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
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>RELATED LOGS</span>
					</TextLine>
					{visibleLogs.map((log) => {
						const logBodyLines = wrapTextLines(log.body, Math.max(16, contentWidth - 2), 3)
						const attributePreview = relevantLogAttributes(log).slice(0, 1)

						return (
							<box key={log.id} flexDirection="column">
								<TextLine>
									<span fg={colors.muted}>{formatTimestamp(log.timestamp)}</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={logSeverityColor(log.severityText)}>{log.severityText.toLowerCase()}</span>
									<span fg={colors.separator}>{SEPARATOR}</span>
									<span fg={colors.defaultService}>{log.scopeName ?? log.serviceName}</span>
								</TextLine>
								{logBodyLines.map((line, index) => (
									<PlainLine key={`${log.id}-body-${index}`} text={line} fg={colors.text} />
								))}
								{attributePreview.map(([key, value]) => (
									<TextLine key={`${log.id}-${key}`}>
										<span fg={colors.count}>{truncateText(key, 18).padEnd(18, " ")}</span>
										<span fg={colors.muted}> </span>
										<span fg={colors.muted}>{truncateText(value, Math.max(12, contentWidth - 20))}</span>
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
