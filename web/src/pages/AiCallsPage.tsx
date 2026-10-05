import { Fragment, useMemo, Suspense, useState } from "react"
import { useSearchParams, Link } from "react-router-dom"
import { useAtomValue } from "@effect/atom-react"
import type { AsyncResult } from "effect/reactivity"
import { MotelClient } from "../api"
import { PageHeader, RefreshButton, LoadingState, ErrorState, EmptyState } from "../components/shared"
import { formatDuration, formatRelativeTime } from "../format"

export function AiCallsPage() {
	const [searchParams] = useSearchParams()
	const service = searchParams.get("service") || undefined
	const model = searchParams.get("model") || undefined
	const provider = searchParams.get("provider") || undefined

	const atom = useMemo(
		() => MotelClient.query("telemetry", "aiCalls", {
			query: {
				...(service ? { service } : {}),
				...(model ? { model } : {}),
				...(provider ? { provider } : {}),
				limit: 100,
			},
		}),
		[service, model, provider],
	)

	return (
		<div className="flex flex-col h-full">
			<PageHeader title="AI Calls">
				<Suspense fallback={null}><RefreshButton atom={atom} /></Suspense>
			</PageHeader>
			<div className="flex-1 overflow-auto">
				<div className="mx-auto max-w-7xl">
					<Suspense fallback={<LoadingState message="Loading AI calls..." />}>
						<AiTable atom={atom} />
					</Suspense>
				</div>
			</div>
		</div>
	)
}

function AiTable({ atom }: { atom: any }) {
	const [expandedId, setExpandedId] = useState<string | null>(null)
	const result = useAtomValue(atom) as AsyncResult.AsyncResult<{
		data: Array<{
			traceId: string; spanId: string; operation: string; service: string; functionId: string | null
			provider: string | null; model: string | null; status: "ok" | "error"; startedAt: string; durationMs: number
			promptPreview: string | null; responsePreview: string | null; finishReason: string | null; toolCallCount: number
			usage: { inputTokens: number | null; outputTokens: number | null } | null
		}>
	}>

	if (result._tag !== "Success") {
		if (result._tag === "Failure") return <ErrorState message="Failed to load AI calls" />
		return <LoadingState message="Loading AI calls..." />
	}

	const calls = result.value.data
	if (!calls.length) {
		return <EmptyState title="No AI calls found" description="AI SDK calls (streamText, generateText, etc.) will appear here." />
	}

	return (
		<table className="w-full">
			<thead>
				<tr className="text-left text-sm text-zinc-500">
					<th className="whitespace-nowrap pb-3 pl-6 pr-4 font-medium">Operation</th>
					<th className="whitespace-nowrap pb-3 px-4 font-medium">Model</th>
					<th className="whitespace-nowrap pb-3 px-4 font-medium">Provider</th>
					<th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Duration</th>
					<th className="whitespace-nowrap pb-3 px-4 font-medium text-right">In tokens</th>
					<th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Out tokens</th>
					<th className="whitespace-nowrap pb-3 pl-4 pr-6 font-medium text-right">Time</th>
				</tr>
			</thead>
			<tbody>
				{calls.map((c) => (
					<Fragment key={c.spanId}>
						<tr
							className="border-t border-white/5 cursor-pointer hover:bg-white/[0.03]"
							onClick={() => setExpandedId(expandedId === c.spanId ? null : c.spanId)}
						>
							<td className="py-3 pl-6 pr-4">
								<p className="text-sm text-zinc-200 font-medium">
									{c.status === "error" && (
										<span className="inline-block mr-2 px-1.5 py-0.5 rounded text-sm font-medium bg-red-400/10 text-red-400">ERR</span>
									)}
									{c.operation}
								</p>
								{c.functionId && <p className="text-sm text-zinc-500 mt-0.5">{c.functionId}</p>}
							</td>
							<td className="py-3 px-4 text-sm text-zinc-400">{c.model ?? "\u2014"}</td>
							<td className="py-3 px-4 text-sm text-zinc-500">{c.provider ?? "\u2014"}</td>
							<td className="py-3 px-4 text-right text-sm tabular-nums text-zinc-300">{formatDuration(c.durationMs)}</td>
							<td className="py-3 px-4 text-right text-sm tabular-nums text-zinc-500">{c.usage?.inputTokens?.toLocaleString() ?? "\u2014"}</td>
							<td className="py-3 px-4 text-right text-sm tabular-nums text-zinc-500">{c.usage?.outputTokens?.toLocaleString() ?? "\u2014"}</td>
							<td className="py-3 pl-4 pr-6 text-right text-sm text-zinc-500">{formatRelativeTime(c.startedAt)}</td>
						</tr>
						{expandedId === c.spanId && (
							<tr key={`${c.spanId}-detail`} className="border-t border-white/5">
								<td colSpan={7} className="py-4 pl-6 pr-6 bg-zinc-900/50">
									<div className="space-y-3 max-w-3xl">
										{c.promptPreview && (
											<div>
												<p className="text-sm text-zinc-500 mb-1">Prompt preview</p>
												<p className="text-sm text-zinc-400 whitespace-pre-wrap">{c.promptPreview}</p>
											</div>
										)}
										{c.responsePreview && (
											<div>
												<p className="text-sm text-zinc-500 mb-1">Response preview</p>
												<p className="text-sm text-zinc-200 whitespace-pre-wrap">{c.responsePreview}</p>
											</div>
										)}
										<div className="flex gap-4 text-sm text-zinc-500">
											{c.finishReason && <span>Finish: {c.finishReason}</span>}
											{c.toolCallCount > 0 && <span>Tools: {c.toolCallCount}</span>}
											<Link to={`/trace/${c.traceId}`} className="text-accent no-underline hover:underline">View trace</Link>
										</div>
									</div>
								</td>
							</tr>
						)}
					</Fragment>
				))}
			</tbody>
		</table>
	)
}
