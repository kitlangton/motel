import { Effect } from "effect"
import { config, parsePositiveInt, resolveOtelUrl } from "./config.js"
import { storeRuntime } from "./runtime.js"
import { TelemetryStore } from "./services/TelemetryStore.js"
import type { LogItem, TraceItem } from "./domain.js"

let server: ReturnType<typeof Bun.serve> | null = null

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	})

const text = (value: string, status = 200, contentType = "text/plain; charset=utf-8") =>
	new Response(value, { status, headers: { "content-type": contentType, "cache-control": "no-store" } })

const notFound = () => json({ error: "Not found" }, 404)

const buildStoreEffect = <A>(fn: (store: TelemetryStore["Service"]) => Effect.Effect<A, Error>) => Effect.flatMap(TelemetryStore.asEffect(), fn)

const parseLimit = (value: string | null, fallback: number) => parsePositiveInt(value ?? undefined, fallback)

const parseLookbackMinutes = (value: string | null, fallback: number) => {
	if (!value) return fallback
	const match = value.trim().match(/^(\d+)([mhd])$/i)
	if (!match) return fallback
	const amount = Number.parseInt(match[1] ?? "", 10)
	if (!Number.isFinite(amount) || amount <= 0) return fallback
	const unit = (match[2] ?? "m").toLowerCase()
	if (unit === "d") return amount * 1440
	if (unit === "h") return amount * 60
	return amount
}

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")

const renderTracePage = (trace: TraceItem, logs: readonly LogItem[]) => {
	const logCountsBySpan = new Map<string, number>()
	for (const log of logs) {
		if (!log.spanId) continue
		logCountsBySpan.set(log.spanId, (logCountsBySpan.get(log.spanId) ?? 0) + 1)
	}

	const spansHtml = trace.spans
		.map((span) => {
			const indent = Math.min(span.depth * 20, 120)
			const count = logCountsBySpan.get(span.spanId) ?? 0
			return `<tr>
<td style="padding-left:${indent}px">${escapeHtml(span.operationName)}</td>
<td>${escapeHtml(span.serviceName)}</td>
<td>${escapeHtml(span.status)}</td>
<td>${span.durationMs.toFixed(2)}ms</td>
<td>${count}</td>
</tr>`
		})
		.join("\n")

	const logsHtml = logs
		.slice(0, 80)
		.map(
			(log) => `<tr>
<td>${escapeHtml(log.timestamp.toISOString())}</td>
<td>${escapeHtml(log.severityText)}</td>
<td>${escapeHtml(log.scopeName ?? log.serviceName)}</td>
<td><pre>${escapeHtml(log.body)}</pre></td>
</tr>`,
		)
		.join("\n")

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(trace.rootOperationName)}</title>
<style>
body { background:#0b0b0b; color:#ede7da; font-family: ui-monospace, SFMono-Regular, monospace; margin:24px; }
h1,h2 { color:#f4a51c; }
.muted { color:#9f9788; }
table { width:100%; border-collapse: collapse; margin-top:16px; }
th, td { border-bottom:1px solid #2a2520; padding:8px; text-align:left; vertical-align:top; }
pre { white-space:pre-wrap; margin:0; color:#ede7da; }
</style>
</head>
<body>
<h1>${escapeHtml(trace.rootOperationName)}</h1>
<p class="muted">${escapeHtml(trace.serviceName)} · ${trace.durationMs.toFixed(2)}ms · ${trace.spanCount} spans · ${logs.length} logs</p>
<p class="muted">${escapeHtml(trace.traceId)}</p>
<h2>Spans</h2>
<table>
<thead><tr><th>Operation</th><th>Service</th><th>Status</th><th>Duration</th><th>Logs</th></tr></thead>
<tbody>${spansHtml}</tbody>
</table>
<h2>Logs</h2>
<table>
<thead><tr><th>Time</th><th>Level</th><th>Scope</th><th>Body</th></tr></thead>
<tbody>${logsHtml}</tbody>
</table>
</body>
</html>`
}

const handleRequest = async (request: Request) => {
	const url = new URL(request.url)
	const path = url.pathname

	try {
		if (request.method === "GET" && path === "/") {
			return text(`leto local telemetry server\n\nPOST /v1/traces\nPOST /v1/logs\nGET /api/services\nGET /api/traces\nGET /api/traces/search\nGET /api/traces/<trace-id>\nGET /api/logs\nGET /api/logs/search\nGET /api/traces/<trace-id>/logs\nGET /api/facets?type=logs&field=severity\nGET /trace/<trace-id>\n`)
		}

		if (request.method === "GET" && path === "/api/health") {
			return json({ ok: true, service: "leto-local-server", databasePath: config.otel.databasePath })
		}

		if (request.method === "POST" && path === "/v1/traces") {
			const payload = await request.json()
			const result = await storeRuntime.runPromise(buildStoreEffect((store) => store.ingestTraces(payload)))
			return json(result)
		}

		if (request.method === "POST" && path === "/v1/logs") {
			const payload = await request.json()
			const result = await storeRuntime.runPromise(buildStoreEffect((store) => store.ingestLogs(payload)))
			return json(result)
		}

		if (request.method === "GET" && path === "/api/services") {
			const data = await storeRuntime.runPromise(buildStoreEffect((store) => store.listServices))
			return json({ data })
		}

		if (request.method === "GET" && path === "/api/traces") {
			const service = url.searchParams.get("service")
			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.listRecentTraces(service, {
						limit: parseLimit(url.searchParams.get("limit"), config.otel.traceFetchLimit),
						lookbackMinutes: parseLookbackMinutes(url.searchParams.get("lookback"), config.otel.traceLookbackMinutes),
					}),
				),
			)
			return json({ data })
		}

		if (request.method === "GET" && path === "/api/traces/search") {
			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.searchTraces({
						serviceName: url.searchParams.get("service"),
						operation: url.searchParams.get("operation"),
						status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
						minDurationMs: url.searchParams.get("minDurationMs") ? Number.parseFloat(url.searchParams.get("minDurationMs") ?? "") : null,
						limit: parseLimit(url.searchParams.get("limit"), config.otel.traceFetchLimit),
						lookbackMinutes: parseLookbackMinutes(url.searchParams.get("lookback"), config.otel.traceLookbackMinutes),
					}),
				),
			)
			return json({ data })
		}

		if (request.method === "GET" && path.startsWith("/api/traces/") && path.endsWith("/logs")) {
			const traceId = decodeURIComponent(path.slice("/api/traces/".length, -"/logs".length))
			const data = await storeRuntime.runPromise(buildStoreEffect((store) => store.listTraceLogs(traceId)))
			return json({ data })
		}

		if (request.method === "GET" && path.startsWith("/api/traces/")) {
			const traceId = decodeURIComponent(path.slice("/api/traces/".length))
			const data = await storeRuntime.runPromise(buildStoreEffect((store) => store.getTrace(traceId)))
			return data ? json({ data }) : json({ error: "Trace not found" }, 404)
		}

		if (request.method === "GET" && path === "/api/logs") {
			const attributeFilters = Object.fromEntries(
				[...url.searchParams.entries()]
					.filter(([key]) => key.startsWith("attr."))
					.map(([key, value]) => [key.slice("attr.".length), value]),
			)

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.searchLogs({
						serviceName: url.searchParams.get("service"),
						traceId: url.searchParams.get("traceId"),
						spanId: url.searchParams.get("spanId"),
						body: url.searchParams.get("body"),
						limit: parseLimit(url.searchParams.get("limit"), config.otel.logFetchLimit),
						attributeFilters,
					}),
				),
			)

			return json({ data })
		}

		if (request.method === "GET" && path === "/api/logs/search") {
			const attributeFilters = Object.fromEntries(
				[...url.searchParams.entries()]
					.filter(([key]) => key.startsWith("attr."))
					.map(([key, value]) => [key.slice("attr.".length), value]),
			)

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.searchLogs({
						serviceName: url.searchParams.get("service"),
						traceId: url.searchParams.get("traceId"),
						spanId: url.searchParams.get("spanId"),
						body: url.searchParams.get("body"),
						limit: parseLimit(url.searchParams.get("limit"), config.otel.logFetchLimit),
						attributeFilters,
					}),
				),
			)

			return json({ data })
		}

		if (request.method === "GET" && path === "/api/facets") {
			const type = url.searchParams.get("type")
			const field = url.searchParams.get("field")
			if ((type !== "traces" && type !== "logs") || !field) {
				return json({ error: "Expected type=traces|logs and field=<name>" }, 400)
			}

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.listFacets({
						type,
						field,
						serviceName: url.searchParams.get("service"),
						lookbackMinutes: parseLookbackMinutes(url.searchParams.get("lookback"), config.otel.traceLookbackMinutes),
						limit: parseLimit(url.searchParams.get("limit"), 20),
					}),
				),
			)

			return json({ data })
		}

		if (request.method === "GET" && path.startsWith("/trace/")) {
			const traceId = decodeURIComponent(path.slice("/trace/".length))
			const trace = await storeRuntime.runPromise(buildStoreEffect((store) => store.getTrace(traceId)))
			if (!trace) return notFound()
			const logs = await storeRuntime.runPromise(buildStoreEffect((store) => store.listTraceLogs(traceId)))
			return text(renderTracePage(trace, logs), 200, "text/html; charset=utf-8")
		}

		return notFound()
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : String(error) }, 500)
	}
}

export const startLocalServer = async () => {
	if (server) return server
	server = Bun.serve({
		hostname: config.otel.host,
		port: config.otel.port,
		fetch: handleRequest,
	})
	return server
}

export const ensureLocalServer = async () => {
	if (server) return server
	try {
		const response = await fetch(resolveOtelUrl("/api/health"), { signal: AbortSignal.timeout(250) })
		if (response.ok) return null
	} catch {
		// Start local server below.
	}
	return await startLocalServer()
}
