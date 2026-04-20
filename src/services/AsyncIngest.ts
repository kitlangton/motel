/**
 * Main-thread client for the telemetry worker's ingest RPCs.
 *
 * The HTTP handlers for POST /v1/traces and POST /v1/logs call into
 * this service instead of `TelemetryStore.ingestTraces/Logs`. Each
 * method sends a typed message to the worker, awaits the reply, and
 * returns the worker's result as an Effect. While the worker is
 * serialising a big batch into SQLite, the main thread's event loop
 * is FREE to answer /api/* queries — that's the whole point of the
 * offload. Without this, /api/health and friends queued behind long
 * ingests and reported p95 latencies of 3-5 seconds; after, they
 * stay responsive regardless of ingest load.
 *
 * The worker is spawned as a scope'd resource inside the layer. The
 * protocol pool is sized at 1 because SQLite only supports a single
 * writer at a time anyway — running N concurrent workers would just
 * queue them on SQLite's lock. When the outer scope closes (server
 * shutdown), `BunWorker.layer`'s finalizer sends a close message and
 * terminates the worker if it doesn't exit gracefully in 5s.
 */

import * as BunWorker from "@effect/platform-bun/BunWorker"
import { Context, Effect, Fiber, Layer } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import type { WorkerError } from "effect/unstable/workers/WorkerError"
import { IngestRpcs } from "./ingestRpc.ts"

// RpcClient.make always surfaces RpcClientError in addition to the
// group's declared errors (transport failures, worker crashes, etc.),
// so the service shape has to mirror that. Without the explicit error
// type param, TS treats the declared and observed client types as
// unrelated structural mismatches.
export class AsyncIngest extends Context.Service<
	AsyncIngest,
	RpcClient.FromGroup<typeof IngestRpcs, RpcClientError | WorkerError>
>()("@motel/AsyncIngest") {}

// Protocol: RpcClient.layerProtocolWorker manages a worker pool and
// speaks msgpack over structured-clone messages. `size: 1` matches
// SQLite's single-writer constraint.
const WorkerProtocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
	Layer.provide(RpcSerialization.layerMsgPack),
	Layer.provide(
		BunWorker.layer(
			() => new Worker(new URL("./telemetryWorker.ts", import.meta.url)),
		),
	),
)

const makeClient = RpcClient.make(IngestRpcs)

export const AsyncIngestLive = Layer.effect(
	AsyncIngest,
	Effect.gen(function* () {
		const client = yield* Effect.gen(function* () {
			const protocol = yield* Layer.build(WorkerProtocol)
			return yield* makeClient.pipe(Effect.provideContext(protocol))
		}).pipe(Effect.forkScoped({ startImmediately: true }))

		const withClient = <A, E, R>(
			f: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E, R>,
		) => Fiber.join(client).pipe(Effect.flatMap(f))

		return {
			ingestTraces: (input, options) =>
				withClient((client) => client.ingestTraces(input, options)),
			ingestLogs: (input, options) =>
				withClient((client) => client.ingestLogs(input, options)),
		}
	}),
)
