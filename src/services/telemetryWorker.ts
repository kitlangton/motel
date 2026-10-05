/**
 * Worker-thread entry point for OTLP ingest.
 *
 * Spawned by the main process via `new Worker(new URL("./telemetryWorker.ts", import.meta.url))`.
 * This file runs inside a Bun Worker, so anything it imports is
 * evaluated in a FRESH module graph on the worker side. In particular
 * `TelemetryStoreWorkerLive` opens its own SQLite connection here — the main
 * thread's store connection is unrelated. SQLite's WAL journal mode
 * lets writer and query-worker connections coexist against the same
 * `.sqlite` file without blocking the HTTP event loop.
 *
 * The worker exposes only `ingestTraces` / `ingestLogs` (see ingestRpc.ts)
 * and owns writer maintenance. Read queries run in telemetryQueryWorker.ts;
 * neither path can block the HTTP event loop.
 */

import { BunRuntime } from "@effect/platform-bun"
import * as BunWorkerRunner from "@effect/platform-bun/BunWorkerRunner"
import { Effect, Layer } from "effect"
import * as RpcServer from "effect/rpc/RpcServer"
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
	Effect.gen(function*() {
		const store = yield* TelemetryStore
		return {
			ingestTraces: ({ payload }) =>
				store.ingestTraces(payload as OtlpTraceExportRequest).pipe(
					Effect.mapError((cause) => new IngestError({ message: String(cause) })),
				),
			ingestLogs: ({ payload }) =>
				store.ingestLogs(payload as OtlpLogExportRequest).pipe(
					Effect.mapError((cause) => new IngestError({ message: String(cause) })),
				),
		}
	}),
)

const WorkerLive = RpcServer.layer(IngestRpcs).pipe(
	Layer.provide(IngestHandlers),
	Layer.provide(TelemetryStoreWorkerLive),
	Layer.provide(RpcServer.layerProtocolWorkerRunner),
	Layer.provide(BunWorkerRunner.layer),
)

// BunRuntime.runMain installs signal handlers so the scope closes
// cleanly on termination; the BunHttpServer layer pattern from the
// main server carries over here.
Layer.launch(WorkerLive).pipe(BunRuntime.runMain)
