/**
 * RPC contract for OTLP ingest. Lives in its own file so both the
 * main thread (client) and the telemetry worker (server) can import
 * the schema without pulling in each other's runtime code.
 *
 * Only ingestTraces and ingestLogs run through RPC — those are the
 * methods whose SQLite writes used to block the main event loop for
 * seconds at a time. Every other TelemetryStore method stays on the
 * main thread with its own direct DB connection; SQLite's WAL mode
 * lets the reader (main) and writer (worker) hold independent
 * connections to the same file concurrently without contention.
 *
 * Payloads are typed as Schema.Unknown because OTLP's protobuf-JSON
 * shape is enormous and nested — the store validates structurally
 * during the actual insert loop, and serialising a schema through
 * the worker boundary would add overhead that beats the purpose of
 * the offload. If a payload is malformed we surface it as an
 * IngestError rather than a RpcSchemaError, which keeps the failure
 * mode consistent with the old direct-call behaviour.
 */

import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

export class IngestError extends Schema.TaggedErrorClass<IngestError>()(
	"IngestError",
	{
		message: Schema.String,
	},
) {}

export const IngestRpcs = RpcGroup.make(
	Rpc.make("ingestTraces", {
		payload: { payload: Schema.Unknown },
		success: Schema.Struct({ insertedSpans: Schema.Number }),
		error: IngestError,
	}),
	Rpc.make("ingestLogs", {
		payload: { payload: Schema.Unknown },
		success: Schema.Struct({ insertedLogs: Schema.Number }),
		error: IngestError,
	}),
)
