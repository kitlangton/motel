import { describe, expect, it } from "bun:test"
import root from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"
import { decodeLogProtobuf, decodeTraceProtobuf } from "./otlpProtobuf.js"

type ProtobufMessageType = {
	create: (message: unknown) => unknown
	encode: (message: unknown) => { finish: () => Uint8Array }
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

type DecodedTracePayload = {
	readonly resourceSpans: readonly [{
		readonly scopeSpans: readonly [{
			readonly spans: readonly [{
				readonly traceId: string
				readonly spanId: string
				readonly parentSpanId: string
				readonly startTimeUnixNano: string
				readonly attributes: readonly [{ readonly value: { readonly bytesValue: string } }]
			}]
		}]
	}]
}

type DecodedLogPayload = {
	readonly resourceLogs: readonly [{
		readonly scopeLogs: readonly [{
			readonly logRecords: readonly [{
				readonly traceId: string
				readonly spanId: string
				readonly timeUnixNano: string
				readonly body: { readonly stringValue: string }
			}]
		}]
	}]
}

describe("OTLP protobuf decoding", () => {
	it("decodes trace export requests into protobuf-JSON shaped payloads", () => {
		const encoded = TraceExportRequest.encode(TraceExportRequest.create({
			resourceSpans: [{
				resource: {
					attributes: [{ key: "service.name", value: { stringValue: "protobuf-api" } }],
				},
				scopeSpans: [{
					scope: { name: "protobuf-test" },
					spans: [{
						traceId: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
						spanId: new Uint8Array([16, 17, 18, 19, 20, 21, 22, 23]),
						parentSpanId: new Uint8Array([24, 25, 26, 27, 28, 29, 30, 31]),
						name: "GET /protobuf",
						kind: 2,
						startTimeUnixNano: "1000000000",
						endTimeUnixNano: "2000000000",
						attributes: [{ key: "payload", value: { bytesValue: new Uint8Array([1, 2, 3]) } }],
					}],
				}],
			}],
		})).finish()

		const decoded = decodeTraceProtobuf(encoded) as DecodedTracePayload
		const span = decoded.resourceSpans[0].scopeSpans[0].spans[0]

		expect(span.traceId).toBe("000102030405060708090a0b0c0d0e0f")
		expect(span.spanId).toBe("1011121314151617")
		expect(span.parentSpanId).toBe("18191a1b1c1d1e1f")
		expect(span.startTimeUnixNano).toBe("1000000000")
		expect(span.attributes[0].value.bytesValue).toBe("AQID")
	})

	it("decodes log export requests into protobuf-JSON shaped payloads", () => {
		const encoded = LogExportRequest.encode(LogExportRequest.create({
			resourceLogs: [{
				resource: {
					attributes: [{ key: "service.name", value: { stringValue: "protobuf-api" } }],
				},
				scopeLogs: [{
					scope: { name: "protobuf-test" },
					logRecords: [{
						traceId: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
						spanId: new Uint8Array([16, 17, 18, 19, 20, 21, 22, 23]),
						timeUnixNano: "3000000000",
						severityText: "INFO",
						body: { stringValue: "protobuf log" },
					}],
				}],
			}],
		})).finish()

		const decoded = decodeLogProtobuf(encoded) as DecodedLogPayload
		const record = decoded.resourceLogs[0].scopeLogs[0].logRecords[0]

		expect(record.traceId).toBe("000102030405060708090a0b0c0d0e0f")
		expect(record.spanId).toBe("1011121314151617")
		expect(record.timeUnixNano).toBe("3000000000")
		expect(record.body.stringValue).toBe("protobuf log")
	})
})
