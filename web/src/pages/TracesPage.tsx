import { useMemo, useRef, Suspense } from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useAtomValue } from "@effect/atom-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { AsyncResult } from "effect/unstable/reactivity"
import { MotelClient } from "../api"
import { PageHeader, RefreshButton, LiveBadge, LoadingState, ErrorState, EmptyState } from "../components/shared"
import { useLivePolling } from "../useLivePolling"
import { formatDuration, formatRelativeTime, serviceColor } from "../format"

export function TracesPage() {
	const [searchParams] = useSearchParams()
	const service = searchParams.get("service") || undefined

	const tracesAtom = useMemo(
		() => MotelClient.query("telemetry", "traces", {
			query: { ...(service ? { service } : {}), limit: 500 },
		}),
		[service],
	)

	// Poll the list while visible so new traces (and running ones) surface without
	// a reload — same decaying policy as the detail page.
	const result: any = useAtomValue(tracesAtom)
	const traces = result._tag === "Success" ? result.value.data : []
	const isLive = useLivePolling({
		atom: tracesAtom,
		fingerprint: traces.length,
		running: traces.some((t: any) => t.isRunning),
		pending: traces.length === 0,
	})

	return (
		<div className="flex flex-col h-full">
			<PageHeader title={service ? `Traces / ${service}` : "Traces"}>
				{isLive && <LiveBadge pulse />}
				<Suspense fallback={null}>
					<RefreshButton atom={tracesAtom} />
				</Suspense>
			</PageHeader>
			<Suspense fallback={<LoadingState message="Loading traces..." />}>
				<TraceTable atom={tracesAtom} />
			</Suspense>
		</div>
	)
}

const ROW_HEIGHT = 44

function TraceTable({ atom }: { atom: any }) {
	const navigate = useNavigate()
	const scrollRef = useRef<HTMLDivElement>(null)

	const result = useAtomValue(atom) as AsyncResult.AsyncResult<{
		data: Array<{
			traceId: string
			serviceName: string
			rootOperationName: string
			startedAt: Date
			isRunning: boolean
			durationMs: number
			spanCount: number
			errorCount: number
		}>
	}>

	const traces = result._tag === "Success" ? result.value.data : []

	const virtualizer = useVirtualizer({
		count: traces.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 20,
	})

	if (result._tag === "Initial" || (result._tag !== "Success" && result._tag !== "Failure")) {
		return <LoadingState message="Loading traces..." />
	}
	if (result._tag === "Failure") {
		return <ErrorState message="Failed to load traces" detail={String(result.cause)} />
	}
	if (traces.length === 0) {
		return <EmptyState title="No traces found" description="Waiting for telemetry data..." />
	}

	const items = virtualizer.getVirtualItems()
	const totalHeight = virtualizer.getTotalSize()

	return (
		<div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
			<div className="mx-auto max-w-7xl">
				<table className="w-full">
					<thead className="sticky top-0 bg-zinc-950 z-10">
						<tr className="text-left text-sm text-zinc-500">
							<th className="whitespace-nowrap pb-3 pl-6 pr-4 font-medium">Operation</th>
							<th className="whitespace-nowrap pb-3 px-4 font-medium">Service</th>
							<th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Duration</th>
							<th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Spans</th>
							<th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Errors</th>
							<th className="whitespace-nowrap pb-3 pl-4 pr-6 font-medium text-right">Time</th>
						</tr>
					</thead>
					<tbody>
						{items.length > 0 && items[0]!.start > 0 && (
							<tr><td colSpan={6} style={{ height: items[0]!.start }} /></tr>
						)}
						{items.map((virtual) => {
							const t = traces[virtual.index]!
							return (
								<tr
									key={t.traceId}
									data-index={virtual.index}
									className="border-t border-white/5 cursor-pointer hover:bg-white/[0.03]"
									style={{ height: ROW_HEIGHT }}
									onClick={() => navigate(`/trace/${t.traceId}`)}
								>
									<td className="py-3 pl-6 pr-4">
										<p className="text-sm text-zinc-200 font-medium">
											{t.isRunning && <span className="inline-block mr-2"><LiveBadge /></span>}
											{t.rootOperationName}
										</p>
									</td>
									<td className="py-3 px-4">
										<p className="text-sm" style={{ color: serviceColor(t.serviceName) }}>{t.serviceName}</p>
									</td>
									<td className="py-3 px-4 text-right tabular-nums">
										<p className="text-sm text-zinc-300">{formatDuration(t.durationMs)}</p>
									</td>
									<td className="py-3 px-4 text-right tabular-nums">
										<p className="text-sm text-zinc-500">{t.spanCount}</p>
									</td>
									<td className="py-3 px-4 text-right tabular-nums">
										{t.errorCount > 0 ? (
											<p className="text-sm text-red-400">{t.errorCount}</p>
										) : (
											<p className="text-sm text-zinc-600">&mdash;</p>
										)}
									</td>
									<td className="py-3 pl-4 pr-6 text-right">
										<p className="text-sm text-zinc-500">{formatRelativeTime(t.startedAt)}</p>
									</td>
								</tr>
							)
						})}
						{items.length > 0 && items[items.length - 1]!.end < totalHeight && (
							<tr><td colSpan={6} style={{ height: totalHeight - items[items.length - 1]!.end }} /></tr>
						)}
					</tbody>
				</table>
			</div>
		</div>
	)
}
