import type { LogItem, TraceItem, TraceSpanItem } from "../domain.ts"
import { colors } from "./theme.ts"

export const truncateText = (text: string, width: number) => {
	if (width <= 0) return ""
	if (text.length <= width) return text
	if (width <= 3) return text.slice(0, width)
	return `${text.slice(0, width - 3)}...`
}

export const fitCell = (text: string, width: number, align: "left" | "right" = "left") => {
	const trimmed = text.length > width ? `${text.slice(0, Math.max(0, width - 3))}...` : text
	return align === "right" ? trimmed.padStart(width, " ") : trimmed.padEnd(width, " ")
}

export const formatShortDate = (date: Date) => date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })

export const formatTimestamp = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase()

export const formatDuration = (durationMs: number) => {
	if (durationMs >= 10_000) return `${Math.round(durationMs / 1000)}s`
	if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(1)}s`
	if (durationMs >= 100) return `${Math.round(durationMs)}ms`
	if (durationMs >= 10) return `${durationMs.toFixed(1)}ms`
	return `${durationMs.toFixed(2)}ms`
}

export const relativeTime = (date: Date) => {
	const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
	return `${Math.floor(seconds / 86_400)}d`
}

export const formatLogTimestamp = (timestamp: Date) => `${formatShortDate(timestamp)} ${formatTimestamp(timestamp)}`

export const logHeadline = (body: string) => body.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() || ""

export const wrapTextLines = (text: string, width: number, maxLines: number) => {
	const normalized = text.replace(/\r/g, "")
	const hardLines = normalized.split("\n")
	const lines: string[] = []

	for (const hardLine of hardLines) {
		let remaining = hardLine
		if (remaining.length === 0) {
			lines.push("")
			if (lines.length >= maxLines) return lines
			continue
		}
		while (remaining.length > 0) {
			lines.push(remaining.slice(0, width))
			remaining = remaining.slice(width)
			if (lines.length >= maxLines) {
				if (remaining.length > 0) {
					lines[maxLines - 1] = truncateText(lines[maxLines - 1]!, width)
				}
				return lines
			}
		}
	}

	return lines.slice(0, maxLines)
}

export const traceIndicator = (trace: TraceItem) => (trace.errorCount > 0 ? "!" : "\u00b7")
export const traceIndicatorColor = (trace: TraceItem) => (trace.errorCount > 0 ? colors.error : colors.passing)
export const traceSpanColor = (span: TraceSpanItem) => (span.status === "error" ? colors.error : colors.text)
export const traceRowId = (traceId: string) => `trace-row-${traceId}`

export const logSeverityColor = (severity: string) => {
	if (severity.startsWith("ERROR") || severity.startsWith("FATAL")) return colors.error
	if (severity.startsWith("WARN")) return colors.accent
	return colors.count
}

export const relevantLogAttributes = (log: LogItem) =>
	Object.entries(log.attributes).filter(([key]) =>
		![
			"deployment.environment.name",
			"service.instance.id",
			"service.name",
			"telemetry.sdk.name",
			"telemetry.sdk.language",
			"fiberId",
			"spanId",
			"traceId",
		].includes(key),
	)

export const copyToClipboard = async (value: string) => {
	const proc = Bun.spawn({
		cmd: ["pbcopy"],
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	})

	if (!proc.stdin) {
		throw new Error("Clipboard is not available")
	}

	proc.stdin.write(value)
	proc.stdin.end()

	const exitCode = await proc.exited
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(stderr.trim() || "Could not copy setup instructions")
	}
}
