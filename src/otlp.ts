export interface OtlpAnyValue {
	readonly stringValue?: string
	readonly boolValue?: boolean
	readonly intValue?: string | number
	readonly doubleValue?: number
	readonly bytesValue?: string
	readonly arrayValue?: {
		readonly values?: readonly OtlpAnyValue[]
	}
	readonly kvlistValue?: {
		readonly values?: readonly OtlpKeyValue[]
	}
}

export interface OtlpKeyValue {
	readonly key: string
	readonly value?: OtlpAnyValue
}

export interface OtlpSpanEvent {
	readonly timeUnixNano?: string
	readonly name?: string
	readonly attributes?: readonly OtlpKeyValue[]
}

export interface OtlpSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId?: string
	readonly name?: string
	readonly kind?: number
	readonly startTimeUnixNano?: string
	readonly endTimeUnixNano?: string
	readonly attributes?: readonly OtlpKeyValue[]
	readonly status?: {
		readonly code?: number
		readonly message?: string
	}
	readonly events?: readonly OtlpSpanEvent[]
}

export interface OtlpScopeSpans {
	readonly scope?: {
		readonly name?: string
	}
	readonly spans?: readonly OtlpSpan[]
}

export interface OtlpResourceSpans {
	readonly resource?: {
		readonly attributes?: readonly OtlpKeyValue[]
	}
	readonly scopeSpans?: readonly OtlpScopeSpans[]
}

export interface OtlpTraceExportRequest {
	readonly resourceSpans?: readonly OtlpResourceSpans[]
}

export interface OtlpLogRecord {
	readonly timeUnixNano?: string
	readonly observedTimeUnixNano?: string
	readonly severityText?: string
	readonly body?: OtlpAnyValue
	readonly attributes?: readonly OtlpKeyValue[]
	readonly traceId?: string
	readonly spanId?: string
}

export interface OtlpScopeLogs {
	readonly scope?: {
		readonly name?: string
	}
	readonly logRecords?: readonly OtlpLogRecord[]
}

export interface OtlpResourceLogs {
	readonly resource?: {
		readonly attributes?: readonly OtlpKeyValue[]
	}
	readonly scopeLogs?: readonly OtlpScopeLogs[]
}

export interface OtlpLogExportRequest {
	readonly resourceLogs?: readonly OtlpResourceLogs[]
}

export const parseAnyValue = (value: OtlpAnyValue | undefined): unknown => {
	if (!value) return null
	if (value.stringValue !== undefined) return value.stringValue
	if (value.boolValue !== undefined) return value.boolValue
	if (value.intValue !== undefined) return Number(value.intValue)
	if (value.doubleValue !== undefined) return value.doubleValue
	if (value.bytesValue !== undefined) return value.bytesValue
	if (value.arrayValue?.values) return value.arrayValue.values.map(parseAnyValue)
	if (value.kvlistValue?.values) {
		return Object.fromEntries(value.kvlistValue.values.map((entry) => [entry.key, parseAnyValue(entry.value)]))
	}
	return null
}

export const stringifyValue = (value: unknown): string => {
	if (value === null || value === undefined) return ""
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	if (Array.isArray(value)) {
		return value.map((entry) => stringifyValue(entry)).filter((entry) => entry.length > 0).join(" ")
	}
	return JSON.stringify(value)
}

export const attributeMap = (attributes: readonly OtlpKeyValue[] | undefined): Record<string, string> =>
	Object.fromEntries((attributes ?? []).map((attribute) => [attribute.key, stringifyValue(parseAnyValue(attribute.value))]))

export const nanosToMilliseconds = (value: string | undefined): number => {
	if (!value) return 0
	try {
		return Number(BigInt(value) / 1_000_000n)
	} catch {
		const parsed = Number.parseInt(value, 10)
		return Number.isFinite(parsed) ? Math.floor(parsed / 1_000_000) : 0
	}
}

export const spanKindLabel = (kind: number | undefined): string | null => {
	switch (kind) {
		case 1:
			return "internal"
		case 2:
			return "server"
		case 3:
			return "client"
		case 4:
			return "producer"
		case 5:
			return "consumer"
		default:
			return null
	}
}

export const spanStatusLabel = (code: number | undefined): "ok" | "error" => (code === 2 ? "error" : "ok")

/**
 * Normalize an OTLP `bytes` ID (traceId/spanId/parentSpanId/link IDs) to
 * lowercase hex of the expected byte length.
 *
 * OTLP/JSON spec mandates lowercase hex for these fields (a deviation from
 * proto3 JSON's default base64). Some clients — notably anything using
 * `google.protobuf.json_format.MessageToJson` on the wire — emit base64.
 * Accepting both keeps motel compatible with naive JSON exporters.
 *
 * Returns `null` for absent/empty IDs (lets us drop empty parent IDs).
 */
export const normalizeOtlpBinaryId = (
	value: string | null | undefined,
	expectedBytes: 8 | 16,
): string | null => {
	if (!value) return null
	const expectedHexLen = expectedBytes * 2
	// Already valid lowercase hex of the expected length — fast path.
	if (value.length === expectedHexLen && /^[0-9a-f]+$/.test(value)) return value
	// Hex but mixed-case — normalize.
	if (value.length === expectedHexLen && /^[0-9a-fA-F]+$/.test(value)) return value.toLowerCase()
	// Try base64 (proto3-JSON default for bytes). Validate by round-trip:
	// `Buffer.from` is lenient and will happily decode short human-readable
	// IDs (e.g. "ai-stream-1") that merely happen to yield the expected byte
	// length, which would silently rewrite — and even collide — distinct IDs.
	// Re-encoding and comparing rejects anything that isn't canonical base64.
	try {
		const bytes = Buffer.from(value, "base64")
		if (bytes.length === expectedBytes && bytes.toString("base64") === value) {
			return bytes.toString("hex")
		}
	} catch {
		// fall through
	}
	// Unknown shape — store as-is so we don't silently lose the row.
	return value
}
