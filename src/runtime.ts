import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Layer, ManagedRuntime } from "effect"
import { config } from "./config.js"
import { LogQueryServiceLive } from "./services/LogQueryService.js"
import {
	TelemetryStoreLive,
	TelemetryStoreReadonlyLive,
} from "./services/TelemetryStore.js"
import { TraceQueryServiceLive } from "./services/TraceQueryService.js"

const telemetryLayer = NodeSdk.layer(() => ({
	spanProcessor: new SimpleSpanProcessor(
		new OTLPTraceExporter({
			url: config.otel.exporterUrl,
		}),
	),
	logRecordProcessor: new SimpleLogRecordProcessor(
		new OTLPLogExporter({
			url: config.otel.logsExporterUrl,
		}),
	),
	loggerMergeWithExisting: false,
	resource: {
		serviceName: config.otel.serviceName,
		attributes: {
			"deployment.environment.name": "local",
			"service.instance.id": "motel.local",
		},
	},
}))

// TUI-side services are readonly — a daemon/worker writer owns the DB
// lock while ingests are in flight, and trying to grab the write lock
// for schema init on startup causes "database is locked" on bun dev.
const QueryServicesLive = Layer.mergeAll(
	TraceQueryServiceLive,
	LogQueryServiceLive,
).pipe(Layer.provideMerge(TelemetryStoreReadonlyLive))

const QueryRuntimeLive = config.otel.enabled
	? Layer.mergeAll(QueryServicesLive, telemetryLayer)
	: QueryServicesLive

export const queryRuntime = ManagedRuntime.make(QueryRuntimeLive)
// `storeRuntime` is the full writer runtime, exposed for the telemetry
// test suite (and any future tooling that needs the ingest side). The
// TUI itself only consumes `queryRuntime`, which is readonly.
export const storeRuntime = ManagedRuntime.make(TelemetryStoreLive)
