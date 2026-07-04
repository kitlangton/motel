import { memo, useMemo, useState } from "react"
import { useParams, Link } from "react-router-dom"
import { useAtomValue, useAtomRefresh } from "@effect/atom-react"

import { MotelClient } from "../api"
import {
	PageContainer,
	RefreshButton,
	SeverityBadge,
	LiveBadge,
	TabButton,
	LoadingState,
	EmptyState,
} from "../components/shared"
import { useLivePolling } from "../useLivePolling"
import { formatDuration, formatTimestamp, serviceColor } from "../format"
import { Waterfall } from "../components/Waterfall"
import { SpanDetailPanel } from "../components/SpanDetail"

export function TraceDetailPage() {
	const { traceId = "" } = useParams<{ traceId: string }>()

	const traceAtom = useMemo(
		() => MotelClient.query("telemetry", "trace", { params: { traceId } }),
		[traceId],
	)
	const logsAtom = useMemo(
		() => MotelClient.query("telemetry", "traceLogs", { params: { traceId }, query: { limit: 200 } }),
		[traceId],
	)

	const traceResult: any = useAtomValue(traceAtom)
	const logsResult: any = useAtomValue(logsAtom)
	const refreshLogs = useAtomRefresh(logsAtom)

	const found = traceResult._tag === "Success"
	const trace = found ? traceResult.value.data : null
	const logs = logsResult?._tag === "Success" ? logsResult.value.data : []

	// Poll while the trace is missing or growing. spanCount is the fingerprint —
	// a change means new spans arrived; see useLivePolling for the full policy.
	const isLive = useLivePolling({
		atom: traceAtom,
		fingerprint: found ? trace.spanCount : -1,
		running: found ? trace.isRunning : false,
		pending: !found,
		onRefresh: refreshLogs,
	})

	if (!traceId) return <EmptyState title="No trace ID" />

	if (!found) {
		// Not found yet (opened from a permalink before any spans arrived) or still
		// loading. The live poll keeps running — the trace fills in once spans land.
		if (traceResult._tag === "Failure") {
			return <WaitingForTrace traceId={traceId} isLive={isLive} />
		}
		return <LoadingState message="Loading trace..." />
	}

	return (
		<TraceContent
			trace={trace}
			logs={logs}
			isLive={isLive}
			traceAtom={traceAtom}
			fingerprint={trace.spanCount}
			logsFingerprint={logs.length}
		/>
	)
}

function WaitingForTrace({ traceId, isLive }: { traceId: string; isLive: boolean }) {
	return (
		<div className="flex flex-col h-full">
			<PageContainer className="pt-4 pb-3 border-b border-white/5">
				<Link to="/traces" className="text-sm text-zinc-500 no-underline hover:text-zinc-300">
					&larr; Traces
				</Link>
				<div className="flex items-center gap-3 mt-1.5">
					<h1 className="text-base font-semibold text-zinc-100 truncate" title={traceId}>
						{traceId}
					</h1>
					{isLive && <LiveBadge pulse />}
				</div>
			</PageContainer>
			<EmptyState
				title="Waiting for spans…"
				description="No spans have arrived for this trace yet. This page updates automatically."
			/>
		</div>
	)
}

interface TraceContentProps {
	trace: any
	logs: any[]
	isLive: boolean
	traceAtom: any
	fingerprint: number
	logsFingerprint: number
}

// Each poll produces a fresh result object, so skip re-rendering the (heavy,
// virtualised) waterfall when the underlying data is unchanged. Selection and
// tab are internal state, so they still re-render normally.
const TraceContent = memo(
	function TraceContent({ trace, logs, isLive, traceAtom }: TraceContentProps) {
		const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)
		const [activeTab, setActiveTab] = useState<"waterfall" | "logs">("waterfall")

		const selectedSpan = selectedSpanId ? trace.spans.find((s: any) => s.spanId === selectedSpanId) ?? null : null
		const selectedSpanLogs = selectedSpanId ? logs.filter((l: any) => l.spanId === selectedSpanId) : []

		return (
			<div className="flex flex-col h-full">
				{/* Header */}
				<PageContainer className="pt-4 pb-3 border-b border-white/5">
					<Link to="/traces" className="text-sm text-zinc-500 no-underline hover:text-zinc-300">
						&larr; Traces
					</Link>
					<div className="flex items-start gap-4 mt-1.5">
						<div className="min-w-0 flex-1">
							<h1 className="text-base font-semibold text-zinc-100 text-balance truncate" title={trace.rootOperationName}>
								{trace.rootOperationName}
							</h1>
							<dl className="flex gap-x-5 gap-y-1 text-sm mt-1 items-center flex-wrap">
								<div className="flex items-center gap-1.5">
									<span className="size-1.5 rounded-full" style={{ backgroundColor: serviceColor(trace.serviceName) }} />
									<dt className="sr-only">Service</dt>
									<dd className="text-zinc-300">{trace.serviceName}</dd>
								</div>
								<div className="flex items-center gap-1.5">
									<dt className="text-zinc-600">Duration</dt>
									<dd className="text-zinc-300 tabular-nums">{formatDuration(trace.durationMs)}</dd>
								</div>
								<div className="flex items-center gap-1.5">
									<dt className="text-zinc-600">Spans</dt>
									<dd className="text-zinc-300 tabular-nums">{trace.spanCount.toLocaleString()}</dd>
								</div>
								{trace.errorCount > 0 && (
									<div className="flex items-center gap-1.5">
										<dt className="text-zinc-600">Errors</dt>
										<dd className="text-red-400 tabular-nums">{trace.errorCount}</dd>
									</div>
								)}
								<div className="flex items-center gap-1.5">
									<dt className="text-zinc-600">Started</dt>
									<dd className="text-zinc-300 tabular-nums">{formatTimestamp(trace.startedAt)}</dd>
								</div>
								{isLive && <LiveBadge pulse />}
							</dl>
						</div>
						<RefreshButton atom={traceAtom} />
					</div>
				</PageContainer>

				{/* Tabs */}
				<PageContainer className="flex gap-1 py-2 border-b border-white/5">
					<TabButton active={activeTab === "waterfall"} onClick={() => setActiveTab("waterfall")}>Waterfall</TabButton>
					<TabButton active={activeTab === "logs"} onClick={() => setActiveTab("logs")}>Logs ({logs.length})</TabButton>
				</PageContainer>

				{/* Body — full page width for the waterfall */}
				<div className="flex flex-1 overflow-hidden w-full">
					{activeTab === "waterfall" ? (
						<>
							<Waterfall
								spans={trace.spans}
								traceStartMs={trace.startedAt.getTime()}
								traceDurationMs={trace.durationMs}
								selectedSpanId={selectedSpanId}
								onSelectSpan={setSelectedSpanId}
								logs={logs as any}
							/>
							{selectedSpan && (
								<SpanDetailPanel
									span={selectedSpan}
									logs={selectedSpanLogs}
									onClose={() => setSelectedSpanId(null)}
								/>
							)}
						</>
					) : (
						<TraceLogsView logs={logs} onSelectSpan={setSelectedSpanId} />
					)}
				</div>
			</div>
		)
	},
	(prev, next) =>
		prev.fingerprint === next.fingerprint &&
		prev.logsFingerprint === next.logsFingerprint &&
		prev.isLive === next.isLive,
)

function TraceLogsView({ logs, onSelectSpan }: { logs: any[]; onSelectSpan: (id: string | null) => void }) {
	if (logs.length === 0) {
		return (
			<div className="flex-1">
				<EmptyState title="No logs for this trace" />
			</div>
		)
	}

	return (
		<div className="flex-1 overflow-auto">
			<table className="w-full">
				<thead>
					<tr className="text-left text-sm text-zinc-500 sticky top-0 bg-zinc-950">
						<th className="whitespace-nowrap pb-2 pt-3 pl-6 pr-4 font-medium w-[7rem]">Time</th>
						<th className="whitespace-nowrap pb-2 pt-3 px-4 font-medium w-16">Level</th>
						<th className="whitespace-nowrap pb-2 pt-3 pl-4 pr-6 font-medium">Body</th>
					</tr>
				</thead>
				<tbody>
					{logs.map((log) => (
						<tr
							key={log.id}
							className={`border-t border-white/5 ${log.spanId ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
							onClick={() => log.spanId && onSelectSpan(log.spanId)}
						>
							<td className="py-1.5 pl-6 pr-4 text-sm tabular-nums text-zinc-500 align-top">{formatTimestamp(log.timestamp)}</td>
							<td className="py-1.5 px-4 align-top"><SeverityBadge severity={log.severityText} /></td>
							<td className="py-1.5 pl-4 pr-6 text-sm whitespace-pre-wrap break-words text-zinc-300">{log.body}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
