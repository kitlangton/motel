import { Fragment } from "react"
import { formatDuration, formatTimestamp, serviceColor } from "../format"
import { Section, SeverityBadge, StatusBadge, ServiceBadge } from "./shared"
import type { TraceSpanItem } from "@motel/domain"

interface Props {
	span: TraceSpanItem
	logs: Array<{ id: string; timestamp: Date; severityText: string; body: string; spanId?: string | null }>
	onClose: () => void
	onOpenLog?: (log: { id: string; spanId?: string | null }) => void
}

export function SpanDetailPanel({ span, logs, onClose, onOpenLog }: Props) {
	const tags = Object.entries(span.tags)

	return (
		<div className="shrink-0 max-h-[46vh] min-h-64 border-t border-white/10 overflow-auto bg-zinc-950/95 shadow-[0_-24px_80px_rgba(0,0,0,0.45)]">
			{/* Header */}
			<div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-semibold text-zinc-100 truncate" title={span.operationName}>
						<span className="text-accent mr-1.5">&bull;</span>{span.operationName}
					</p>
					<div className="flex flex-wrap items-center gap-1.5 mt-2">
						<ServiceBadge name={span.serviceName} color={serviceColor(span.serviceName)} />
						<StatusBadge status={span.status} isRunning={span.isRunning} />
						<span className="text-sm px-1.5 py-0.5 rounded bg-white/10 text-zinc-200 tabular-nums">{formatDuration(span.durationMs)}</span>
						{span.kind && <span className="text-sm px-1.5 py-0.5 rounded bg-white/5 text-zinc-400">{span.kind}</span>}
						{logs.length > 0 && <span className="text-sm px-1.5 py-0.5 rounded bg-sky-400/10 text-sky-300">{logs.length} logs</span>}
						{span.events.length > 0 && <span className="text-sm px-1.5 py-0.5 rounded bg-violet-400/10 text-violet-300">{span.events.length} events</span>}
					</div>
				</div>
				<button
					className="bg-transparent border border-white/10 text-zinc-500 cursor-pointer text-sm px-2 py-1 rounded hover:text-zinc-300 hover:bg-white/5 shrink-0"
					onClick={onClose}
				>
					&times;
				</button>
			</div>

			<div className="grid grid-cols-1 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(24rem,1.05fr)_minmax(22rem,0.85fr)]">
				<Section title="Overview">
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
						<dt className="text-zinc-500 font-medium">Started</dt>
						<dd className="tabular-nums text-zinc-300">{formatTimestamp(span.startTime)}</dd>
						{span.scopeName && <>
							<dt className="text-zinc-500 font-medium">Scope</dt>
							<dd className="text-zinc-300 break-all">{span.scopeName}</dd>
						</>}
						<dt className="text-zinc-500 font-medium">Span ID</dt>
						<dd className="text-zinc-400 text-sm tabular-nums break-all">{span.spanId}</dd>
						{span.parentSpanId && <>
							<dt className="text-zinc-500 font-medium">Parent</dt>
							<dd className="text-zinc-400 text-sm tabular-nums break-all">{span.parentSpanId}</dd>
						</>}
					</dl>
					{span.warnings.length > 0 && (
						<div className="mt-4 space-y-1">
							{span.warnings.map((w) => <p key={w} className="text-amber-400 text-sm">{w}</p>)}
						</div>
					)}
				</Section>

				<Section title={`Attributes (${tags.length})`}>
					{tags.length > 0 ? (
						<dl className="grid grid-cols-1 md:grid-cols-[minmax(10rem,18rem)_1fr] gap-x-6 gap-y-1.5 text-sm">
							{tags.map(([k, v]) => (
								<Fragment key={k}>
									<dt className="text-zinc-500 break-all">{k}</dt>
									<dd className="text-zinc-300 whitespace-pre-wrap break-words">{v}</dd>
								</Fragment>
							))}
						</dl>
					) : (
						<p className="text-sm text-zinc-600">No attributes</p>
					)}
				</Section>

				<div className="border-b border-white/5">
					{span.events.length > 0 && (
						<Section title={`Events (${span.events.length})`}>
							{span.events.map((evt) => (
								<div key={`${evt.timestamp.getTime()}-${evt.name}`} className="py-2 border-b border-white/5 last:border-0">
									<p className="text-sm font-medium text-zinc-200">{evt.name}</p>
									<p className="text-sm text-zinc-500 tabular-nums">{formatTimestamp(evt.timestamp)}</p>
									{Object.entries(evt.attributes).length > 0 && (
										<dl className="grid grid-cols-1 md:grid-cols-[minmax(8rem,14rem)_1fr] gap-x-4 gap-y-1 text-sm mt-2">
											{Object.entries(evt.attributes).map(([k, v]) => (
												<Fragment key={k}>
													<dt className="text-zinc-500 break-all">{k}</dt>
													<dd className="text-zinc-300 whitespace-pre-wrap break-words">{v}</dd>
												</Fragment>
											))}
										</dl>
									)}
								</div>
							))}
						</Section>
					)}
					{logs.length > 0 && (
						<Section title={`Logs (${logs.length})`}>
							<div className="space-y-2">
								{logs.map((log) => (
									<button
										key={log.id}
										type="button"
										className="block w-full rounded border border-sky-400/30 bg-sky-950/20 p-2 text-left cursor-pointer hover:border-sky-300/60 hover:bg-sky-950/30"
										onClick={() => onOpenLog?.(log)}
									>
										<div className="flex items-center gap-2">
											<span className="text-sm tabular-nums text-zinc-500">{formatTimestamp(log.timestamp)}</span>
											<SeverityBadge severity={log.severityText} />
										</div>
										<p className="text-sm whitespace-pre-wrap break-words text-zinc-300 mt-1">{log.body}</p>
									</button>
								))}
							</div>
						</Section>
					)}
				</div>
			</div>
		</div>
	)
}
