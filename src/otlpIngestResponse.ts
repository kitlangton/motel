/**
 * Response pipeline for OTLP ingest endpoints with typed error surfaces.
 *
 * OTLP over HTTP is defined for two encodings — `application/json` and
 * `application/x-protobuf`. motel only implements the JSON path; there
 * is no protobuf codec bundled. Without explicit handling, a caller
 * that defaults to protobuf (the common case for SDKs that follow the
 * OTel spec's default) gets a generic `500 Internal Server Error` with
 * an empty body, which is indistinguishable from a motel-side crash.
 *
 * This module classifies the predictable ingest failure modes and
 * returns HTTP statuses that actually tell the caller what's wrong:
 *
 * | Condition                                      | Status | Body hint |
 * | ---------------------------------------------- | ------ | --------- |
 * | `Content-Type` isn't `application/json`        | 415    | names the content-type, points at `protocol=http/json` |
 * | Body is JSON-claimed but unparseable           | 400    | surfaces the parser error |
 * | Genuine downstream failure (SQLite, worker…)   | 500    | error message (unchanged pre-refactor) |
 *
 * Every HTTP status is represented as a typed outcome in
 * {@link classifyIngestError} and {@link classifyContentType} so unit
 * tests don't need to stand up an HTTP server to cover the behaviour.
 */

import { Effect } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"

/**
 * Shape of a single ingest-error response the server will emit. Kept
 * pure so the mapping from parse-error → status is unit-testable
 * without the http runtime.
 */
export interface IngestErrorResponse {
	readonly status: number
	readonly body: { readonly error: string; readonly hint?: string }
}

/** Pure classification: `Content-Type` header → accepted / rejected-with-hint. */
export type ContentTypeClassification =
	| { readonly kind: "ok" }
	| { readonly kind: "unsupported"; readonly response: IngestErrorResponse }

/**
 * OTLP/HTTP spec allows `application/json` (optionally with charset
 * parameters). Anything else — most commonly `application/x-protobuf`
 * — is rejected with a hint pointing at the exporter knob that fixes
 * it.
 */
export const classifyContentType = (rawContentType: string | undefined): ContentTypeClassification => {
	const contentType = (rawContentType ?? "").toLowerCase().trim()
	if (contentType.startsWith("application/json")) {
		return { kind: "ok" }
	}
	const hint = contentType.includes("protobuf")
		? "motel only implements OTLP/HTTP+JSON; re-run your exporter with protocol=http/json (OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json for the standard SDKs)."
		: `Expected Content-Type: application/json, got ${contentType || "(none)"}.`
	return {
		kind: "unsupported",
		response: {
			status: 415,
			body: { error: "Unsupported Media Type", hint },
		},
	}
}

/**
 * Predicate for JSON-parse-ish errors surfaced by `HttpIncomingMessage#json`.
 *
 * The Effect platform wraps body-parse failures as `RequestParseError`
 * with messages like `"RequestParseError (POST /v1/traces)"`; other
 * runtimes surface them as `SyntaxError: Unexpected token …` or
 * `Failed to parse JSON`. We deliberately use substring matches (no
 * word boundaries) so `RequestParseError` and `JsonParseError` both
 * register as parse failures. The set of non-parse errors that happen
 * to contain these substrings is effectively empty in this domain.
 */
export const isJsonParseError = (message: string): boolean =>
	/json|parse|syntax|malformed|unexpected token/i.test(message)

/**
 * Classify any ingest pipeline failure into an HTTP response. Public
 * for unit tests; the runtime consumer is {@link respondOtlpIngest}.
 */
export const classifyIngestError = (error: unknown): IngestErrorResponse => {
	const message = error instanceof Error ? error.message : String(error)
	if (isJsonParseError(message)) {
		return {
			status: 400,
			body: { error: message, hint: "Request body could not be parsed as OTLP JSON." },
		}
	}
	return { status: 500, body: { error: message } }
}

const errorResponse = (response: IngestErrorResponse) =>
	HttpServerResponse.jsonUnsafe(response.body, { status: response.status })

/**
 * Wrap an ingest effect with the response pipeline described in this
 * module's docstring. On the happy path the handler runs exactly like
 * before; it's the error surfaces that change shape.
 *
 * @param request  the inbound HTTP request (provides `headers` + `json`).
 * @param ingest   function that consumes the parsed OTLP payload and
 *                 returns an effect yielding the ingest result
 *                 (typically `{insertedSpans: N}` or similar).
 */
export const respondOtlpIngest = <A, R>(
	request: HttpServerRequest,
	ingest: (payload: unknown) => Effect.Effect<A, unknown, R>,
) => {
	const ct = classifyContentType(request.headers["content-type"])
	if (ct.kind === "unsupported") {
		return Effect.succeed(errorResponse(ct.response))
	}
	return Effect.match(Effect.flatMap(request.json, ingest), {
		onFailure: (error) => errorResponse(classifyIngestError(error)),
		onSuccess: (result) => HttpServerResponse.jsonUnsafe(result),
	})
}
