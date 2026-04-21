import type { ScrollBoxRenderable } from "@opentui/core"
import { useLayoutEffect, useRef } from "react"
import type { LogItem } from "../domain.ts"
import {
	fitCell,
	formatLogTimestamp,
	formatTimestamp,
	logHeadline,
	logSeverityColor,
	relevantLogAttributes,
	truncateText,
	wrapTextLines,
} from "./format.ts"
import { Divider, PlainLine, TextLine } from "./primitives.tsx"
import type { ServiceLogState } from "./state.ts"
import { colors, SEPARATOR } from "./theme.ts"

export const ServiceLogsView = ({
	serviceName,
	logsState,
	selectedIndex,
	onSelectLog,
	contentWidth,
	bodyLines,
}: {
	serviceName: string | null
	logsState: ServiceLogState
	selectedIndex: number
	onSelectLog: (index: number) => void
	contentWidth: number
	bodyLines: number
}) => {
	const timeWidth = 8
	const levelWidth = 5
	const traceWidth = 8
	const messageWidth = Math.max(
		16,
		contentWidth - timeWidth - levelWidth - traceWidth - 3,
	)

	if (logsState.status === "loading" && logsState.data.length === 0) {
		return <PlainLine text="Loading recent service logs..." fg={colors.count} />
	}

	if (logsState.status === "error") {
		return (
			<PlainLine
				text={logsState.error ?? "Could not load logs."}
				fg={colors.error}
			/>
		)
	}

	if (logsState.data.length === 0) {
		return (
			<PlainLine
				text={`No logs captured yet for service ${serviceName ?? "unknown"}.`}
				fg={colors.muted}
			/>
		)
	}

	const scrollRef = useRef<ScrollBoxRenderable | null>(null)
	const safeSelectedIndex = Math.max(
		0,
		Math.min(selectedIndex, logsState.data.length - 1),
	)
	const selectedLog = logsState.data[safeSelectedIndex] ?? null
	const detailWidth = Math.max(16, contentWidth - 2)
	const detailBodyLines = selectedLog
		? wrapTextLines(selectedLog.body, detailWidth, 6)
		: []
	const detailAttributeLines = selectedLog
		? relevantLogAttributes(selectedLog).slice(0, 3)
		: []
	const detailHeight = selectedLog
		? 3 + detailBodyLines.length + detailAttributeLines.length
		: 0
	const listHeight = Math.max(4, bodyLines - detailHeight - 1)

	useLayoutEffect(() => {
		scrollRef.current?.scrollChildIntoView(`svc-log-${safeSelectedIndex}`)
	}, [safeSelectedIndex])

	return (
		<box flexDirection="column">
			{selectedLog ? (
				<>
					<TextLine>
						<span fg={logSeverityColor(selectedLog.severityText)}>
							{selectedLog.severityText.toLowerCase()}
						</span>
						<span fg={colors.separator}>{SEPARATOR}</span>
						<span fg={colors.muted}>
							{formatLogTimestamp(selectedLog.timestamp)}
						</span>
						<span fg={colors.separator}>{SEPARATOR}</span>
						<span fg={colors.count}>
							{selectedLog.traceId ? selectedLog.traceId.slice(-8) : "no-trace"}
						</span>
					</TextLine>
					<TextLine>
						<span fg={colors.defaultService}>
							{selectedLog.scopeName ?? selectedLog.serviceName}
						</span>
						{selectedLog.spanId ? (
							<>
								<span fg={colors.separator}>{SEPARATOR}</span>
								<span fg={colors.muted}>{selectedLog.spanId.slice(-8)}</span>
							</>
						) : null}
					</TextLine>
					{detailBodyLines.map((line, index) => (
						<PlainLine
							key={`log-detail-${selectedLog.id}-${index}`}
							text={line}
							fg={colors.text}
						/>
					))}
					{detailAttributeLines.map(([key, value]) => (
						<TextLine key={`log-attr-${selectedLog.id}-${key}`}>
							<span fg={colors.count}>
								{truncateText(key, 18).padEnd(18, " ")}
							</span>
							<span fg={colors.muted}> </span>
							<span fg={colors.muted}>
								{truncateText(value, Math.max(12, detailWidth - 20))}
							</span>
						</TextLine>
					))}
					<Divider width={contentWidth} />
				</>
			) : null}
			<TextLine fg={colors.muted}>
				<span>{fitCell("time", timeWidth)}</span>
				<span> </span>
				<span>{fitCell("lvl", levelWidth)}</span>
				<span> </span>
				<span>{fitCell("trace", traceWidth)}</span>
				<span> </span>
				<span>{fitCell("message", messageWidth)}</span>
			</TextLine>
			<scrollbox ref={scrollRef} height={listHeight} flexGrow={0}>
				{logsState.data.map((log, index) => {
					const selected = index === safeSelectedIndex
					const trace = log.traceId ? log.traceId.slice(-8) : "-"
					return (
						<box
							id={`svc-log-${index}`}
							key={log.id}
							height={1}
							onMouseDown={() => onSelectLog(index)}
						>
							<TextLine
								fg={selected ? colors.selectedText : colors.text}
								bg={selected ? colors.selectedBg : undefined}
							>
								<span fg={colors.muted}>
									{fitCell(formatTimestamp(log.timestamp), timeWidth)}
								</span>
								<span> </span>
								<span fg={logSeverityColor(log.severityText)}>
									{fitCell(log.severityText.toLowerCase(), levelWidth)}
								</span>
								<span> </span>
								<span fg={colors.count}>{fitCell(trace, traceWidth)}</span>
								<span> </span>
								<span fg={selected ? colors.selectedText : colors.text}>
									{fitCell(logHeadline(log.body), messageWidth)}
								</span>
							</TextLine>
						</box>
					)
				})}
			</scrollbox>
		</box>
	)
}
