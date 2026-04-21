/**
 * Worker-thread entry point for OTLP ingest.
 *
 * Spawned by the main process via `new Worker(new URL("./telemetryWorker.ts", import.meta.url))`.
 * This file runs inside a Bun Worker, so anything it imports is
 * evaluated in a FRESH module graph on the worker side. In particular
 * `TelemetryStoreWorkerLive` opens its own SQLite connection here — the main
 * thread's store connection is unrelated. SQLite's WAL journal mode
 * lets both connections coexist against the same `.sqlite` file: the
 * worker writes, the main thread reads, and neither blocks the other.
 *
 * The worker only exposes `ingestTraces` / `ingestLogs` (see
 * ingestRpc.ts). Query methods stay on the main thread because they're
 * already fast (1-14ms) and round-tripping them through structured-
 * clone would add more overhead than it saves. This is a deliberately
 * narrow interface — the payoff is that main-thread HTTP queries
 * never queue behind a heavy OTLP batch again.
 */

import { BunRuntime } from "@effect/platform-bun"
import * as BunWorkerRunner from "@effect/platform-bun/BunWorkerRunner"
import { Effect, Layer } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import type { OtlpLogExportRequest, OtlpTraceExportRequest } from "../otlp.ts"
import { IngestError, IngestRpcs } from "./ingestRpc.ts"
import { TelemetryStore, TelemetryStoreWorkerLive } from "./TelemetryStore.ts"

// Wire the two RPC methods to the existing TelemetryStore service.
// The store's ingest methods already carry their own Effect.fn spans,
// so the worker-side traces show up correctly attributed — the RPC
// framework also auto-spans each incoming request with method +
// payload-size attributes, giving us visibility into how ingest is
// splitting its time across the queue / wire / SQL stages.
const IngestHandlers = IngestRpcs.toLayer(
	Effect.gen(function* () {
		const store = yield* TelemetryStore
		return {
			ingestTraces: ({ payload }) =>
				store
					.ingestTraces(payload as OtlpTraceExportRequest)
					.pipe(
						Effect.mapError(
							(cause) => new IngestError({ message: String(cause) }),
						),
					),
			ingestLogs: ({ payload }) =>
				store
					.ingestLogs(payload as OtlpLogExportRequest)
					.pipe(
						Effect.mapError(
							(cause) => new IngestError({ message: String(cause) }),
						),
					),
		}
	}),
)

const WorkerLive = RpcServer.layer(IngestRpcs).pipe(
	Layer.provide(IngestHandlers),
	Layer.provide(TelemetryStoreWorkerLive),
	Layer.provide(RpcServer.layerProtocolWorkerRunner),
	Layer.provide(RpcSerialization.layerMsgPack),
	Layer.provide(BunWorkerRunner.layer),
)

// BunRuntime.runMain installs signal handlers so the scope closes
// cleanly on termination; the BunHttpServer layer pattern from the
// main server carries over here.
Layer.launch(WorkerLive).pipe(BunRuntime.runMain)
