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
import { Context, Duration, Effect, Exit, Layer, Scope } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import type { WorkerError } from "effect/workers/WorkerError"
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
// speaks over structured-clone messages. `size: 1` matches
// SQLite's single-writer constraint.
const WorkerProtocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
	Layer.provide(
		BunWorker.layer(() => new Worker(new URL("./telemetryWorker.ts", import.meta.url))),
	),
)

export const AsyncIngestLive = Layer.effect(
	AsyncIngest,
	Effect.gen(function*() {
		const scope = yield* Scope.Scope
		// Keep daemon startup cheap: creating the RPC client here would eagerly
		// spawn the worker and make /api/health wait on the worker's SQLite
		// bootstrap. Cache a lazy initializer instead so the worker only starts
		// on the first ingest request, but is still shared thereafter.
		const [getClient, invalidateClient] = yield* Effect.cachedInvalidateWithTTL(Effect.gen(function*() {
			const clientScope = yield* Scope.fork(scope, "sequential")
			const protocolContext = yield* Layer.buildWithScope(WorkerProtocol, clientScope)
			const client = yield* RpcClient.make(IngestRpcs).pipe(
				Effect.provide(protocolContext),
				Effect.provideService(Scope.Scope, clientScope),
			)
			return { client, clientScope }
		}), Duration.infinity)
		// Start the sole writer/maintenance worker immediately, but do not make
		// HTTP health wait for SQLite bootstrap. Managed readiness still verifies
		// the worker through explicit ingest probes.
		yield* Effect.forkScoped(getClient.pipe(Effect.ignore))
		return {
			ingestTraces: (input, options) =>
				Effect.flatMap(getClient, ({ client, clientScope }) => client.ingestTraces(input, options).pipe(
					Effect.onError(() => Effect.andThen(Scope.close(clientScope, Exit.void), invalidateClient)),
				)),
			ingestLogs: (input, options) =>
				Effect.flatMap(getClient, ({ client, clientScope }) => client.ingestLogs(input, options).pipe(
					Effect.onError(() => Effect.andThen(Scope.close(clientScope, Exit.void), invalidateClient)),
				)),
		}
	}),
)
