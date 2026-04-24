import root from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"

type ProtobufMessageType = {
	decode: (bytes: Uint8Array) => unknown
	toObject: (message: unknown, options: { readonly bytes: ArrayConstructor, readonly longs: StringConstructor }) => unknown
}

const otlpRoot = root as unknown as {
	readonly opentelemetry: {
		readonly proto: {
			readonly collector: {
				readonly trace: { readonly v1: { readonly ExportTraceServiceRequest: ProtobufMessageType } }
				readonly logs: { readonly v1: { readonly ExportLogsServiceRequest: ProtobufMessageType } }
			}
		}
	}
}

const TraceExportRequest = otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest
const LogExportRequest = otlpRoot.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest

const byteArrayToHex = (bytes: readonly number[]): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const byteArrayToBase64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString("base64")

const normalizeProtobufJson = (value: unknown, key?: string): unknown => {
	if (Array.isArray(value)) {
		if (key === "traceId" || key === "spanId" || key === "parentSpanId") return byteArrayToHex(value)
		if (key === "bytesValue") return byteArrayToBase64(value)
		return value.map((entry) => normalizeProtobufJson(entry))
	}

	if (value === null || typeof value !== "object") return value

	return Object.fromEntries(
		Object.entries(value).map(([entryKey, entryValue]) => [entryKey, normalizeProtobufJson(entryValue, entryKey)]),
	)
}

export const decodeTraceProtobuf = (bytes: Uint8Array): unknown =>
	normalizeProtobufJson(TraceExportRequest.toObject(TraceExportRequest.decode(bytes), { bytes: Array, longs: String }))

export const decodeLogProtobuf = (bytes: Uint8Array): unknown =>
	normalizeProtobufJson(LogExportRequest.toObject(LogExportRequest.decode(bytes), { bytes: Array, longs: String }))
