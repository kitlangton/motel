const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) return defaultValue
	return !["0", "false", "no", "off"].includes(normalized)
}

export const parsePositiveInt = (
	value: string | undefined,
	defaultValue: number,
) => {
	const parsed = Number.parseInt(value ?? "", 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

const baseUrl =
	process.env.MOTEL_OTEL_BASE_URL?.trim() ||
	process.env.MOTEL_OTEL_QUERY_URL?.trim() ||
	process.env.MOTEL_OTEL_COLLECTOR_URL?.trim() ||
	"http://127.0.0.1:27686"

const parsedBaseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
export const resolveOtelUrl = (path: string) =>
	new URL(path.startsWith("/") ? path.slice(1) : path, parsedBaseUrl).toString()
const serverPort = parsePositiveInt(
	process.env.MOTEL_OTEL_PORT,
	Number.parseInt(parsedBaseUrl.port || "80", 10),
)

export const config = {
	otel: {
		enabled: parseBoolean(process.env.MOTEL_OTEL_ENABLED, false),
		serviceName:
			process.env.MOTEL_OTEL_SERVICE_NAME?.trim() || "motel-otel-tui",
		baseUrl,
		host: process.env.MOTEL_OTEL_HOST?.trim() || parsedBaseUrl.hostname,
		port: serverPort,
		queryUrl: baseUrl,
		exporterUrl:
			process.env.MOTEL_OTEL_EXPORTER_URL?.trim() ||
			resolveOtelUrl("/v1/traces"),
		logsExporterUrl:
			process.env.MOTEL_OTEL_LOGS_EXPORTER_URL?.trim() ||
			resolveOtelUrl("/v1/logs"),
		databasePath:
			process.env.MOTEL_OTEL_DB_PATH?.trim() ||
			`${import.meta.dir}/../.motel-data/telemetry.sqlite`,
		traceLookbackMinutes: parsePositiveInt(
			process.env.MOTEL_OTEL_TRACE_LOOKBACK_MINUTES,
			1440,
		),
		traceFetchLimit: parsePositiveInt(process.env.MOTEL_OTEL_TRACE_LIMIT, 100),
		logFetchLimit: parsePositiveInt(process.env.MOTEL_OTEL_LOG_LIMIT, 80),
		retentionHours: parsePositiveInt(
			process.env.MOTEL_OTEL_RETENTION_HOURS,
			168,
		),
		maxDbSizeMb: parsePositiveInt(process.env.MOTEL_OTEL_MAX_DB_SIZE_MB, 1024),
	},
} as const
