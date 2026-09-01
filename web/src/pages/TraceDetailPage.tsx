import { useEffect, useMemo, useState } from "react"
import { useParams, Link, useSearchParams } from "react-router-dom"
import { useAtomValue } from "@effect/atom-react"

import { MotelClient } from "../api"
import {
	PageContainer,
	RefreshButton,
	LiveBadge,
	TabButton,
	LoadingState,
	ErrorState,
	EmptyState,
} from "../components/shared"
import { formatDuration, formatTimestamp, serviceColor } from "../format"
import { Waterfall } from "../components/Waterfall"
import { SpanDetailPanel } from "../components/SpanDetail"
import { LogTable } from "../components/LogTable"

export function TraceDetailPage() {
	const { traceId = "" } = useParams<{ traceId: string }>()
	const [searchParams, setSearchParams] = useSearchParams()

	const spanParam = searchParams.get("span")
	const logParam = searchParams.get("log")
	const tabParam = searchParams.get("tab")
	const [selectedSpanId, setSelectedSpanId] = useState<string | null>(spanParam)
	const [activeTab, setActiveTab] = useState<"waterfall" | "logs">(tabParam === "logs" || logParam ? "logs" : "waterfall")

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

	useEffect(() => {
		setSelectedSpanId(spanParam)
	}, [spanParam])

	useEffect(() => {
		setActiveTab(tabParam === "logs" || logParam ? "logs" : "waterfall")
	}, [tabParam, logParam])

	const selectSpan = (spanId: string | null) => {
		setSelectedSpanId(spanId)
		const p = new URLSearchParams(searchParams)
		spanId ? p.set("span", spanId) : p.delete("span")
		p.delete("log")
		if (activeTab === "logs") p.set("tab", "logs")
		else p.delete("tab")
		setSearchParams(p, { replace: true })
	}

	const selectTab = (tab: "waterfall" | "logs") => {
		setActiveTab(tab)
		const p = new URLSearchParams(searchParams)
		tab === "logs" ? p.set("tab", "logs") : p.delete("tab")
		if (tab === "waterfall") p.delete("log")
		setSearchParams(p, { replace: true })
	}

	const openLogDetail = (log: { id: string; spanId: string | null }) => {
		if (log.spanId) setSelectedSpanId(log.spanId)
		setActiveTab("logs")
		const p = new URLSearchParams(searchParams)
		p.set("tab", "logs")
		p.set("log", log.id)
		if (log.spanId) p.set("span", log.spanId)
		setSearchParams(p, { replace: true })
	}

	const closeLogDetail = () => {
		const p = new URLSearchParams(searchParams)
		p.delete("log")
		setSearchParams(p, { replace: true })
	}

	if (!traceId) return <EmptyState title="No trace ID" />
	if (traceResult._tag !== "Success") {
		if (traceResult._tag === "Failure") return <ErrorState message="Trace not found" />
		return <LoadingState message="Loading trace..." />
	}

	const trace = traceResult.value.data
	const logs = logsResult?._tag === "Success" ? logsResult.value.data : []
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
							{trace.isRunning && <LiveBadge />}
						</dl>
					</div>
					<RefreshButton atom={traceAtom} />
				</div>
			</PageContainer>

			{/* Tabs */}
			<PageContainer className="flex gap-1 py-2 border-b border-white/5">
				<TabButton active={activeTab === "waterfall"} onClick={() => selectTab("waterfall")}>Waterfall</TabButton>
				<TabButton active={activeTab === "logs"} onClick={() => selectTab("logs")}>Logs ({logs.length})</TabButton>
			</PageContainer>

			{/* Body */}
			<div className="flex flex-1 overflow-hidden w-full min-h-0">
				{activeTab === "waterfall" ? (
					<div className="flex flex-col flex-1 min-w-0 min-h-0">
						<Waterfall
							spans={trace.spans}
							traceStartMs={trace.startedAt.getTime()}
							traceDurationMs={trace.durationMs}
							selectedSpanId={selectedSpanId}
							onSelectSpan={selectSpan}
							logs={logs as any}
						/>
						{selectedSpan && (
							<SpanDetailPanel
								span={selectedSpan}
								logs={selectedSpanLogs}
								onOpenLog={openLogDetail}
								onClose={() => selectSpan(null)}
							/>
						)}
					</div>
				) : (
					<TraceLogsView logs={logs} selectedLogId={logParam} onSelectSpan={selectSpan} onOpenLog={openLogDetail} onCloseLog={closeLogDetail} />
				)}
			</div>
		</div>
	)
}

function TraceLogsView({
	logs,
	selectedLogId,
	onSelectSpan,
	onOpenLog,
	onCloseLog,
}: {
	logs: any[]
	selectedLogId: string | null
	onSelectSpan: (id: string | null) => void
	onOpenLog: (log: any) => void
	onCloseLog: () => void
}) {
	if (logs.length === 0) {
		return (
			<div className="flex-1">
				<EmptyState title="No logs for this trace" />
			</div>
		)
	}

	return (
		<LogTable
			logs={logs}
			traceScoped
			onSelectSpan={onSelectSpan}
			className="flex-1"
			initialExpandedId={logs[0]?.id ?? null}
			expandedId={selectedLogId}
			onExpandedIdChange={(id) => {
				const log = id ? logs.find((item) => item.id === id) : null
				if (log) onOpenLog(log)
				else onCloseLog()
			}}
		/>
	)
}
