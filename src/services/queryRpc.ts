import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import { StructuredClone } from "./rpcSchema.js"

export class QueryError extends Schema.TaggedError<QueryError>()("QueryError", {
	message: Schema.String,
}) {}

export const QueryRpcs = RpcGroup.make(
	Rpc.make("query", {
		payload: { method: Schema.String, args: Schema.Array(StructuredClone) },
		success: StructuredClone,
		error: QueryError,
	}),
)
