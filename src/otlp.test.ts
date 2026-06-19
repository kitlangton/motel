import { describe, expect, test } from "bun:test"
import { normalizeOtlpBinaryId } from "./otlp.ts"
import { decodeProtobufLogs, decodeProtobufTraces } from "./otlpProtobuf.ts"
import rootModule from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"

describe("normalizeOtlpBinaryId", () => {
	test("returns null for absent/empty values", () => {
		expect(normalizeOtlpBinaryId(null, 16)).toBeNull()
		expect(normalizeOtlpBinaryId(undefined, 8)).toBeNull()
		expect(normalizeOtlpBinaryId("", 16)).toBeNull()
	})

	test("passes through valid lowercase hex of the expected length", () => {
		const traceId = "0123456789abcdef0123456789abcdef"
		const spanId = "0123456789abcdef"
		expect(normalizeOtlpBinaryId(traceId, 16)).toBe(traceId)
		expect(normalizeOtlpBinaryId(spanId, 8)).toBe(spanId)
	})

	test("lowercases mixed-case hex", () => {
		expect(normalizeOtlpBinaryId("0123456789ABCDEF", 8)).toBe("0123456789abcdef")
	})

	test("decodes canonical base64 (proto3-JSON default) to hex", () => {
		const spanBase64 = Buffer.from("0123456789abcdef", "hex").toString("base64")
		const traceBase64 = Buffer.from("0123456789abcdef0123456789abcdef", "hex").toString("base64")
		expect(normalizeOtlpBinaryId(spanBase64, 8)).toBe("0123456789abcdef")
		expect(normalizeOtlpBinaryId(traceBase64, 16)).toBe("0123456789abcdef0123456789abcdef")
	})

	test("does NOT mangle human-readable IDs that happen to base64-decode to the expected length", () => {
		// "ai-stream-1" and "ai-stream-2" both base64-decode to 8 bytes, and to
		// the SAME bytes — naive decoding would silently rewrite and collide them.
		expect(normalizeOtlpBinaryId("ai-stream-1", 8)).toBe("ai-stream-1")
		expect(normalizeOtlpBinaryId("ai-stream-2", 8)).toBe("ai-stream-2")
		expect(normalizeOtlpBinaryId("trace-ai", 16)).toBe("trace-ai")
	})

	test("preserves unknown shapes verbatim rather than dropping the row", () => {
		expect(normalizeOtlpBinaryId("not-an-id", 8)).toBe("not-an-id")
	})
})

const root = rootModule as unknown as {
	readonly opentelemetry: {
		readonly proto: {
			readonly collector: {
				readonly trace: { readonly v1: { readonly ExportTraceServiceRequest: { encode: (m: unknown) => { finish: () => Uint8Array } } } }
				readonly logs: { readonly v1: { readonly ExportLogsServiceRequest: { encode: (m: unknown) => { finish: () => Uint8Array } } } }
			}
		}
	}
}

describe("protobuf OTLP decoders", () => {
	test("decodeProtobufTraces round-trips a span and yields base64 IDs", () => {
		const traceId = Buffer.from("0123456789abcdef0123456789abcdef", "hex")
		const spanId = Buffer.from("0123456789abcdef", "hex")
		const encoded = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.encode({
			resourceSpans: [{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "proto-svc" } }] },
				scopeSpans: [{ spans: [{ traceId, spanId, name: "op", startTimeUnixNano: 1, endTimeUnixNano: 2 }] }],
			}],
		}).finish()

		const decoded = decodeProtobufTraces(encoded)
		const span = decoded.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
		expect(span?.name).toBe("op")
		// bytes come out as base64 strings, normalised to hex downstream on ingest.
		expect(normalizeOtlpBinaryId(span?.traceId as string, 16)).toBe("0123456789abcdef0123456789abcdef")
		expect(normalizeOtlpBinaryId(span?.spanId as string, 8)).toBe("0123456789abcdef")
	})

	test("decodeProtobufLogs round-trips a log record", () => {
		const encoded = root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest.encode({
			resourceLogs: [{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "proto-svc" } }] },
				scopeLogs: [{ logRecords: [{ timeUnixNano: 5, severityText: "INFO", body: { stringValue: "hello" } }] }],
			}],
		}).finish()

		const decoded = decodeProtobufLogs(encoded)
		const record = decoded.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]
		expect(record?.severityText).toBe("INFO")
		expect(record?.body?.stringValue).toBe("hello")
	})
})
