import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, References } from "effect"
import {
	attributeFiltersFromArgs,
	attributeContainsFiltersFromArgs,
	isAttributeFilterToken,
	isAttributeContainsToken,
} from "./queryFilters.js"

describe("motel telemetry store", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-test-"))
	const dbPath = join(tempDir, "telemetry.sqlite")
	let storeRuntime: Awaited<typeof import("./runtime.ts")>["storeRuntime"]
	let TelemetryStore: Awaited<
		typeof import("./services/TelemetryStore.ts")
	>["TelemetryStore"]
	let motelOpenApiSpec: Awaited<
		typeof import("./httpApi.ts")
	>["motelOpenApiSpec"]

	beforeAll(async () => {
		process.env.MOTEL_OTEL_DB_PATH = dbPath
		process.env.MOTEL_OTEL_RETENTION_HOURS = "24"
		const suffix = `?test=${Date.now()}`
		;({ storeRuntime } = await import(`./runtime.ts${suffix}`))
		;({ TelemetryStore } = await import(
			`./services/TelemetryStore.ts${suffix}`
		))
		;({ motelOpenApiSpec } = await import(`./httpApi.ts${suffix}`))

		const nowNanos = BigInt(Date.now()) * 1_000_000n
		const oneSecond = 1_000_000_000n

		const ingest = Effect.flatMap(TelemetryStore.asEffect(), (store) =>
			Effect.flatMap(
				store.ingestTraces({
					resourceSpans: [
						{
							resource: {
								attributes: [
									{ key: "service.name", value: { stringValue: "test-api" } },
									{
										key: "deployment.environment.name",
										value: { stringValue: "local" },
									},
								],
							},
							scopeSpans: [
								{
									scope: { name: "test-scope" },
									spans: [
										{
											traceId: "trace-1",
											spanId: "root-1",
											name: "SessionProcessor.stream",
											kind: 2,
											startTimeUnixNano: String(nowNanos),
											endTimeUnixNano: String(nowNanos + 4n * oneSecond),
											attributes: [
												{
													key: "sessionID",
													value: { stringValue: "session-1" },
												},
												{ key: "modelID", value: { stringValue: "gpt-5.4" } },
											],
										},
										{
											traceId: "trace-1",
											spanId: "child-1",
											parentSpanId: "root-1",
											name: "tool.call",
											kind: 1,
											startTimeUnixNano: String(nowNanos + oneSecond),
											endTimeUnixNano: String(nowNanos + 2n * oneSecond),
											attributes: [
												{ key: "tool", value: { stringValue: "search" } },
											],
										},
									],
								},
							],
						},
						{
							resource: {
								attributes: [
									{ key: "service.name", value: { stringValue: "test-api" } },
									{
										key: "deployment.environment.name",
										value: { stringValue: "local" },
									},
								],
							},
							scopeSpans: [
								{
									scope: { name: "test-scope" },
									spans: [
										{
											traceId: "trace-2",
											spanId: "root-2",
											name: "SessionProcessor.stream",
											kind: 2,
											startTimeUnixNano: String(nowNanos + 10n * oneSecond),
											endTimeUnixNano: String(nowNanos + 12n * oneSecond),
											status: { code: 2 },
											attributes: [
												{
													key: "sessionID",
													value: { stringValue: "session-2" },
												},
												{ key: "modelID", value: { stringValue: "gpt-5.4" } },
											],
										},
									],
								},
							],
						},
					],
				}),
				() =>
					store.ingestLogs({
						resourceLogs: [
							{
								resource: {
									attributes: [
										{ key: "service.name", value: { stringValue: "test-api" } },
									],
								},
								scopeLogs: [
									{
										scope: { name: "app" },
										logRecords: [
											{
												timeUnixNano: String(nowNanos + 500_000_000n),
												severityText: "INFO",
												traceId: "trace-1",
												spanId: "child-1",
												body: { stringValue: "tool call started" },
												attributes: [
													{ key: "tool", value: { stringValue: "search" } },
												],
											},
											{
												timeUnixNano: String(nowNanos + 11n * oneSecond),
												severityText: "ERROR",
												traceId: "trace-2",
												spanId: "root-2",
												body: { stringValue: "stream failed" },
												attributes: [
													{ key: "tool", value: { stringValue: "none" } },
												],
											},
										],
									},
								],
							},
						],
					}),
			).pipe(
				Effect.flatMap(() =>
					Effect.flatMap(TelemetryStore.asEffect(), (store) =>
						store.ingestTraces({
							resourceSpans: [
								{
									resource: {
										attributes: [
											{
												key: "service.name",
												value: { stringValue: "test-api" },
											},
										],
									},
									scopeSpans: [
										{
											scope: { name: "ai" },
											spans: [
												{
													traceId: "trace-ai",
													spanId: "ai-stream-1",
													name: "ai.streamText",
													kind: 1,
													startTimeUnixNano: String(nowNanos + 20n * oneSecond),
													endTimeUnixNano: String(nowNanos + 40n * oneSecond),
													attributes: [
														{
															key: "ai.operationId",
															value: { stringValue: "ai.streamText" },
														},
														{
															key: "ai.telemetry.functionId",
															value: { stringValue: "session.llm" },
														},
														{
															key: "ai.model.provider",
															value: { stringValue: "openai.responses" },
														},
														{
															key: "ai.model.id",
															value: { stringValue: "gpt-5.4" },
														},
														{
															key: "ai.telemetry.metadata.sessionId",
															value: { stringValue: "ses_test123" },
														},
														{
															key: "ai.telemetry.metadata.userId",
															value: { stringValue: "kit" },
														},
														{
															key: "ai.prompt.messages",
															value: {
																stringValue:
																	'[{"role":"user","content":"Tell me a joke about programming"}]',
															},
														},
														{
															key: "ai.response.text",
															value: {
																stringValue:
																	"Why do programmers prefer dark mode? Because light attracts bugs!",
															},
														},
														{
															key: "ai.response.finishReason",
															value: { stringValue: "stop" },
														},
														{
															key: "ai.usage.inputTokens",
															value: { stringValue: "150" },
														},
														{
															key: "ai.usage.outputTokens",
															value: { stringValue: "42" },
														},
														{
															key: "ai.usage.totalTokens",
															value: { stringValue: "192" },
														},
														{
															key: "ai.usage.cachedInputTokens",
															value: { stringValue: "100" },
														},
														{
															key: "ai.response.msToFirstChunk",
															value: { stringValue: "500.5" },
														},
														{
															key: "ai.response.msToFinish",
															value: { stringValue: "20000" },
														},
													],
												},
												{
													traceId: "trace-ai",
													spanId: "ai-stream-1-do",
													parentSpanId: "ai-stream-1",
													name: "ai.streamText.doStream",
													kind: 1,
													startTimeUnixNano: String(nowNanos + 21n * oneSecond),
													endTimeUnixNano: String(nowNanos + 39n * oneSecond),
													attributes: [
														{
															key: "ai.operationId",
															value: { stringValue: "ai.streamText.doStream" },
														},
														{
															key: "ai.telemetry.functionId",
															value: { stringValue: "session.llm" },
														},
														{
															key: "ai.model.provider",
															value: { stringValue: "openai.responses" },
														},
														{
															key: "ai.model.id",
															value: { stringValue: "gpt-5.4" },
														},
														{
															key: "ai.telemetry.metadata.sessionId",
															value: { stringValue: "ses_test123" },
														},
														{
															key: "ai.prompt.messages",
															value: {
																stringValue:
																	'[{"role":"user","content":"Tell me a joke about programming"}]',
															},
														},
													],
												},
												{
													traceId: "trace-ai",
													spanId: "ai-tool-1",
													parentSpanId: "ai-stream-1",
													name: "ai.toolCall",
													kind: 1,
													startTimeUnixNano: String(nowNanos + 25n * oneSecond),
													endTimeUnixNano: String(nowNanos + 26n * oneSecond),
													attributes: [
														{
															key: "ai.toolCall.name",
															value: { stringValue: "bash" },
														},
													],
												},
												{
													traceId: "trace-ai",
													spanId: "ai-stream-2",
													name: "ai.generateText",
													kind: 1,
													startTimeUnixNano: String(nowNanos + 50n * oneSecond),
													endTimeUnixNano: String(nowNanos + 55n * oneSecond),
													status: { code: 2 },
													attributes: [
														{
															key: "ai.operationId",
															value: { stringValue: "ai.generateText" },
														},
														{
															key: "ai.telemetry.functionId",
															value: { stringValue: "session.llm" },
														},
														{
															key: "ai.model.provider",
															value: { stringValue: "anthropic" },
														},
														{
															key: "ai.model.id",
															value: { stringValue: "claude-opus-4" },
														},
														{
															key: "ai.telemetry.metadata.sessionId",
															value: { stringValue: "ses_test456" },
														},
														{
															key: "ai.prompt.messages",
															value: {
																stringValue:
																	'[{"role":"user","content":"Summarize this"}]',
															},
														},
														{
															key: "ai.response.text",
															value: { stringValue: "Error: rate limited" },
														},
														{
															key: "ai.response.finishReason",
															value: { stringValue: "error" },
														},
														{
															key: "ai.usage.inputTokens",
															value: { stringValue: "80" },
														},
														{
															key: "ai.usage.outputTokens",
															value: { stringValue: "10" },
														},
														{
															key: "ai.usage.totalTokens",
															value: { stringValue: "90" },
														},
													],
												},
											],
										},
									],
								},
							],
						}),
					),
				),
			),
		)

		await storeRuntime.runPromise(
			ingest.pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)
	})

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("filters traces by attr.* fields", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraces({
					serviceName: "test-api",
					attributeFilters: {
						sessionID: "session-1",
						"deployment.environment.name": "local",
					},
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("looks up a span directly by spanId", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.getSpan("child-1"),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result?.traceId).toBe("trace-1")
		expect(result?.rootOperationName).toBe("SessionProcessor.stream")
		expect(result?.span.operationName).toBe("tool.call")
		expect(result?.span.depth).toBe(1)
	})

	it("filters logs by spanId", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({
					spanId: "child-1",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("tool call started")
	})

	it("searches spans by operation, parent operation, and attr filters", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchSpans({
					serviceName: "test-api",
					operation: "tool.call",
					parentOperation: "SessionProcessor.stream",
					attributeFilters: {
						tool: "search",
					},
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
		expect(result[0]?.span.operationName).toBe("tool.call")
		expect(result[0]?.parentOperationName).toBe("SessionProcessor.stream")
	})

	it("lists spans for a trace", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.listTraceSpans("trace-1"),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("documents the span lookup route in OpenAPI", () => {
		expect(motelOpenApiSpec.paths["/api/spans/{spanId}"]).toBeDefined()
	})

	it("aggregates trace stats by operation", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.traceStats({
					groupBy: "operation",
					agg: "avg_duration",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result.length).toBeGreaterThanOrEqual(1)
		const sessionOp = result.find((r) => r.group === "SessionProcessor.stream")
		expect(sessionOp).toBeDefined()
		expect(sessionOp?.count).toBe(2)
		expect(sessionOp?.value).toBe(3000)
	})

	it("aggregates log stats by severity", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.logStats({
					groupBy: "severity",
					agg: "count",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		const errorGroup = result.find((r) => r.group === "ERROR")
		const infoGroup = result.find((r) => r.group === "INFO")
		expect(errorGroup?.value).toBe(1)
		expect(infoGroup?.value).toBe(1)
	})

	it("documents the stats routes in OpenAPI", () => {
		expect(motelOpenApiSpec.paths["/api/traces/stats"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/logs/stats"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/spans/{spanId}/logs"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/spans/search"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/traces/{traceId}/spans"]).toBeDefined()
	})

	it("lists trace summaries without loading spans", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.listTraceSummaries(null),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(3) // trace-1, trace-2, trace-ai
		// Ordered by start time descending — trace-ai is most recent
		expect(result[0]?.traceId).toBe("trace-ai")
		// Summary fields are correct for the original trace
		const trace1 = result.find((r) => r.traceId === "trace-1")
		expect(trace1?.serviceName).toBe("test-api")
		expect(trace1?.rootOperationName).toBe("SessionProcessor.stream")
		expect(trace1?.spanCount).toBe(2)
		expect(trace1?.durationMs).toBe(4000)
	})

	it("lists trace summaries filtered by service", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.listTraceSummaries("test-api"),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(3) // all traces are test-api
	})

	it("searches trace summaries with status filter", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraceSummaries({
					serviceName: "test-api",
					status: "error",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2) // trace-2 and trace-ai (ai.generateText has error status)
		expect(result.some((r) => r.traceId === "trace-2")).toBe(true)
	})

	it("searches trace summaries with attribute filters", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraceSummaries({
					serviceName: "test-api",
					attributeFilters: { sessionID: "session-1" },
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("searches trace summaries with operation filter", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraceSummaries({
					serviceName: "test-api",
					operation: "tool.call",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("filters logs by severity", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({ serviceName: "test-api", severity: "ERROR" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("stream failed")
		expect(result[0]?.severityText).toBe("ERROR")
	})

	it("filters logs by severity case-insensitively", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({ serviceName: "test-api", severity: "error" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.severityText).toBe("ERROR")
	})

	it("searches log body case-insensitively", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({ serviceName: "test-api", body: "STREAM FAILED" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("stream failed")
	})

	it("searches spans by traceId", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchSpans({ traceId: "trace-1" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		expect(result.every((s) => s.traceId === "trace-1")).toBe(true)
	})

	it("searches spans with attrContains substring filter", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchSpans({
					serviceName: "test-api",
					attributeContainsFilters: { sessionID: "session" },
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		// Both root spans have sessionID containing "session"
		expect(result.length).toBeGreaterThanOrEqual(2)
	})

	it("searches spans with attrContains case-insensitively", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchSpans({
					serviceName: "test-api",
					attributeContainsFilters: { modelID: "GPT" },
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		// modelID is "gpt-5.4", searching "GPT" should match case-insensitively
		expect(result.length).toBeGreaterThanOrEqual(2)
	})

	it("searches logs with attrContains substring filter", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({
					serviceName: "test-api",
					attributeContainsFilters: { tool: "sea" },
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("tool call started")
	})

	it("combines severity and body filters", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({
					serviceName: "test-api",
					severity: "INFO",
					body: "tool",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("tool call started")
	})

	it("computes facet status without N+1 queries", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.listFacets({
					type: "traces",
					field: "status",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		const errorFacet = result.find((r) => r.value === "error")
		const okFacet = result.find((r) => r.value === "ok")
		expect(errorFacet?.count).toBe(2) // trace-2 and trace-ai
		expect(okFacet?.count).toBe(1)
	})

	it("computes logStats with SQL aggregation", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.logStats({
					groupBy: "service",
					agg: "count",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.group).toBe("test-api")
		expect(result[0]?.value).toBe(2)
	})

	it("computes traceStats count via SQL", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.traceStats({
					groupBy: "status",
					agg: "count",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		const errorGroup = result.find((r) => r.group === "error")
		const okGroup = result.find((r) => r.group === "ok")
		expect(errorGroup?.count).toBe(2) // trace-2 and trace-ai
		expect(okGroup?.count).toBe(1)
	})

	it("computes traceStats error_rate via SQL", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.traceStats({
					groupBy: "service",
					agg: "error_rate",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.group).toBe("test-api")
		// 2 error traces out of 3 total
		expect(result[0]?.value).toBeCloseTo(2 / 3, 5)
	})

	it("documents the docs routes in OpenAPI", () => {
		expect(motelOpenApiSpec.paths["/api/docs"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/docs/{name}"]).toBeDefined()
	})

	it("parses attr filters consistently for CLI-style args", () => {
		expect(isAttributeFilterToken("attr.sessionID=sess_123")).toBe(true)
		expect(isAttributeFilterToken("sessionID=sess_123")).toBe(false)
		expect(
			attributeFiltersFromArgs(["attr.sessionID=sess_123", "attr.tool=search"]),
		).toEqual({
			sessionID: "sess_123",
			tool: "search",
		})
	})

	it("parses attrContains filters for CLI-style args", () => {
		expect(isAttributeContainsToken("attrContains.ai.prompt=hello world")).toBe(
			true,
		)
		expect(isAttributeContainsToken("attr.key=exact")).toBe(false)
		expect(
			attributeContainsFiltersFromArgs([
				"attrContains.ai.prompt=hello",
				"attr.exact=match",
			]),
		).toEqual({
			"ai.prompt": "hello",
		})
	})

	it("attr filters exclude attrContains tokens", () => {
		const mixed = ["attr.key=exact", "attrContains.key=substring"]
		expect(attributeFiltersFromArgs(mixed)).toEqual({ key: "exact" })
		expect(attributeContainsFiltersFromArgs(mixed)).toEqual({
			key: "substring",
		})
	})

	// AI Call tests

	it("searches AI calls and returns compact summaries", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(3) // ai.streamText, ai.toolCall, ai.generateText
		const streamCall = result.find((c) => c.spanId === "ai-stream-1")
		expect(streamCall).toBeDefined()
		expect(streamCall?.operation).toBe("streamText")
		expect(streamCall?.model).toBe("gpt-5.4")
		expect(streamCall?.provider).toBe("openai.responses")
		expect(streamCall?.sessionId).toBe("ses_test123")
		expect(streamCall?.userId).toBe("kit")
		expect(streamCall?.finishReason).toBe("stop")
		expect(streamCall?.promptPreview).toContain("Tell me a joke")
		expect(streamCall?.responsePreview).toContain("dark mode")
		expect(streamCall?.toolCallCount).toBe(1)
		expect(streamCall?.usage?.inputTokens).toBe(150)
		expect(streamCall?.usage?.outputTokens).toBe(42)
	})

	it("dedupes nested doStream spans from AI summaries", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ sessionId: "ses_test123" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result.map((call) => call.spanId)).toEqual(["ai-stream-1"])
		expect(result.map((call) => call.spanId)).not.toContain("ai-stream-1-do")
	})

	it("filters AI calls by model", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ model: "claude-opus-4" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.model).toBe("claude-opus-4")
		expect(result[0]?.status).toBe("error")
	})

	it("filters AI calls by sessionId", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ sessionId: "ses_test123" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.spanId).toBe("ai-stream-1")
	})

	it("searches AI calls by text content", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ text: "joke about programming" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.spanId).toBe("ai-stream-1")
	})

	it("matches AI calls via words in the response text", async () => {
		// Verifies FTS indexes ai.response.text, not just ai.prompt*. The
		// seeded ai-stream-2 has response "Error: rate limited".
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ text: "rate limited" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)
		expect(result.map((r) => r.spanId)).toContain("ai-stream-2")
	})

	it("matches AI calls case-insensitively and with partial words", async () => {
		// unicode61 tokenizer is case-insensitive by default; prefix `*`
		// handles partial terms like `"PROG"` matching `"programming"`.
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ text: "PROG" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)
		expect(result.map((r) => r.spanId)).toContain("ai-stream-1")
	})

	it("ignores FTS special characters without syntax errors", async () => {
		// FTS5 treats `"`, `*`, `-`, `:` as operators; toFtsQuery must
		// strip them so raw user input never crashes the query.
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ text: `"joke" - about:programming*` }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)
		expect(result.map((r) => r.spanId)).toContain("ai-stream-1")
	})

	it("filters AI calls by operation type", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchAiCalls({ operation: "generateText" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.operation).toBe("generateText")
	})

	it("gets AI call detail with full payloads", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.getAiCall("ai-stream-1"),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).not.toBeNull()
		expect(result?.model).toBe("gpt-5.4")
		expect(result?.promptMessages).toBeDefined()
		expect(result?.responseText).toContain("dark mode")
		expect(result?.toolCalls).toHaveLength(1)
		expect(result?.toolCalls[0]?.name).toBe("bash")
		expect(result?.usage?.inputTokens).toBe(150)
		expect(result?.timing.msToFirstChunk).toBe(500.5)
		expect(result?.timing.msToFinish).toBe(20000)
	})

	it("returns null for non-AI span in getAiCall", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.getAiCall("root-1"),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toBeNull()
	})

	it("aggregates AI call stats by model", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.aiCallStats({ groupBy: "model", agg: "count" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result.length).toBeGreaterThanOrEqual(2)
		const gpt = result.find((r) => r.group === "gpt-5.4")
		const claude = result.find((r) => r.group === "claude-opus-4")
		expect(gpt?.count).toBeGreaterThanOrEqual(1)
		expect(claude?.count).toBe(1)
	})

	it("aggregates AI call stats by status", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.aiCallStats({ groupBy: "status", agg: "count" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		const okGroup = result.find((r) => r.group === "ok")
		const errorGroup = result.find((r) => r.group === "error")
		expect(okGroup).toBeDefined()
		expect(errorGroup).toBeDefined()
		expect(errorGroup?.count).toBe(1)
	})

	it("documents the AI routes in OpenAPI", () => {
		expect(motelOpenApiSpec.paths["/api/ai/calls"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/ai/calls/{spanId}"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/ai/stats"]).toBeDefined()
	})
})
