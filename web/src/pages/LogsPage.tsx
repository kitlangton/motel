import { useMemo, useState, Suspense } from "react"
import { useSearchParams } from "react-router-dom"
import { useAtomValue } from "@effect/atom-react"
import type { AsyncResult } from "effect/unstable/reactivity"
import { MotelClient } from "../api"
import {
	PageContainer,
	RefreshButton,
	SearchInput,
	FilterPill,
	LoadingState,
	ErrorState,
	EmptyState,
} from "../components/shared"
import { LogTable, type LogRecord } from "../components/LogTable"

const SEVERITIES = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const

export function LogsPage() {
	const [searchParams, setSearchParams] = useSearchParams()
	const service = searchParams.get("service") || undefined
	const severity = searchParams.get("severity") || undefined
	const [bodySearch, setBodySearch] = useState(searchParams.get("body") || "")

	const logsAtom = useMemo(
		() => MotelClient.query("telemetry", "logs", {
			query: {
				...(service ? { service } : {}),
				...(severity ? { severity } : {}),
				...(bodySearch ? { body: bodySearch } : {}),
				limit: 200,
			},
		}),
		[service, severity, bodySearch],
	)

	const toggleSeverity = (sev: string) => {
		const p = new URLSearchParams(searchParams)
		severity === sev ? p.delete("severity") : p.set("severity", sev)
		setSearchParams(p)
	}

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault()
		const p = new URLSearchParams(searchParams)
		bodySearch ? p.set("body", bodySearch) : p.delete("body")
		setSearchParams(p)
	}

	return (
		<div className="flex flex-col h-full">
			{/* Toolbar */}
			<div className="border-b border-white/5 shrink-0">
				<PageContainer className="flex items-center gap-3 py-3">
					<form onSubmit={handleSearch} className="contents">
						<SearchInput value={bodySearch} onChange={setBodySearch} placeholder="Search log body..." />
					</form>
					<div className="flex gap-1">
						{SEVERITIES.map((sev) => (
							<FilterPill key={sev} active={severity === sev} onClick={() => toggleSeverity(sev)}>
								{sev}
							</FilterPill>
						))}
					</div>
					<div className="ml-auto">
						<Suspense fallback={null}>
							<RefreshButton atom={logsAtom} />
						</Suspense>
					</div>
				</PageContainer>
			</div>

			{/* Table */}
			<div className="flex-1 overflow-hidden">
				<div className="mx-auto max-w-7xl h-full">
					<Suspense fallback={<LoadingState message="Loading logs..." />}>
						<LogsResult atom={logsAtom} />
					</Suspense>
				</div>
			</div>
		</div>
	)
}

function LogsResult({ atom }: { atom: any }) {
	const result = useAtomValue(atom) as AsyncResult.AsyncResult<{
		data: LogRecord[]
	}>

	if (result._tag !== "Success") {
		if (result._tag === "Failure") return <ErrorState message="Failed to load logs" />
		return <LoadingState message="Loading logs..." />
	}

	const logs = result.value.data
	if (!logs.length) return <EmptyState title="No logs found" />

	return <LogTable logs={logs} className="h-full" />
}
