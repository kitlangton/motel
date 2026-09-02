import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

export class QueryError extends Schema.TaggedError<QueryError>()("QueryError", {
	message: Schema.String,
}) {}

export const QueryRpcs = RpcGroup.make(
	Rpc.make("query", {
		// Worker RPC uses structured clone. Schema.Any preserves values such as
		// Date and undefined that are valid clone inputs but not JSON values.
		payload: { method: Schema.String, args: Schema.Array(Schema.Any) },
		success: Schema.Any,
		error: QueryError,
	}),
)
