/**
 * OTLP/HTTP+protobuf body decoders.
 *
 * The OTLP spec defines two wire formats for `/v1/traces` and `/v1/logs`:
 *  - `application/json`   — OTLP/JSON, deviations from proto3 JSON (hex IDs)
 *  - `application/x-protobuf` — OTLP/HTTP+protobuf
 *
 * Motel's storage code only cares about the *shape* of the request (see
 * `OtlpTraceExportRequest` / `OtlpLogExportRequest` in `./otlp.ts`), so the
 * easiest way to support protobuf is to decode it into the same plain-object
 * shape JSON ingest produces.
 *
 * We reuse the protobufjs root that ships with `@opentelemetry/otlp-transformer`
 * (a dep already pulled in by the OTLP HTTP exporter). `Type.decode(bytes)`
 * gives back a typed Message; `Type.toObject(msg, { bytes: String, longs: String })`
 * flattens it to a plain object where:
 *   - `bytes` fields (traceId, spanId, parentSpanId) come out as **base64 strings**
 *   - `uint64` fields (timeUnixNano, etc.) come out as **strings**
 *
 * That matches what motel's existing `normalizeOtlpBinaryId` (base64 → hex) and
 * `nanosToMilliseconds` (string → BigInt → number) already handle, so the
 * downstream pipeline is unchanged.
 */

import rootModule from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"
import type { OtlpLogExportRequest, OtlpTraceExportRequest } from "./otlp.js"

// The generated module re-exports the protobufjs root as the default export.
// Its TypeScript type is `protobuf.Root`, which doesn't surface the nested
// generated namespaces — they live on the runtime object. Cast through `any`
// to reach `.opentelemetry.proto.collector...`.
interface ProtobufType {
	readonly decode: (buf: Uint8Array) => unknown
	readonly toObject: (msg: unknown, opts: Record<string, unknown>) => unknown
}

const root = rootModule as unknown as {
	readonly opentelemetry: {
		readonly proto: {
			readonly collector: {
				readonly trace: { readonly v1: { readonly ExportTraceServiceRequest: ProtobufType } }
				readonly logs: { readonly v1: { readonly ExportLogsServiceRequest: ProtobufType } }
			}
		}
	}
}

const ExportTraceServiceRequest = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest
const ExportLogsServiceRequest = root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest

const decodeOptions = {
	bytes: String, // bytes → base64 string (normalised to hex on ingest)
	longs: String, // uint64 → string (parsed via BigInt on ingest)
	defaults: false,
	enums: Number,
	arrays: true,
	objects: true,
}

export const decodeProtobufTraces = (bytes: Uint8Array): OtlpTraceExportRequest => {
	const msg = ExportTraceServiceRequest.decode(bytes)
	return ExportTraceServiceRequest.toObject(msg, decodeOptions) as OtlpTraceExportRequest
}

export const decodeProtobufLogs = (bytes: Uint8Array): OtlpLogExportRequest => {
	const msg = ExportLogsServiceRequest.decode(bytes)
	return ExportLogsServiceRequest.toObject(msg, decodeOptions) as OtlpLogExportRequest
}
