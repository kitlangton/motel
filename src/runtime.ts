import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Layer, ManagedRuntime } from "effect"
import { config } from "./config.js"
import { LogQueryServiceLive } from "./services/LogQueryService.js"
import { TelemetryStoreLive } from "./services/TelemetryStore.js"
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
			"service.instance.id": "leto.local",
		},
	},
}))

const QueryServicesLive = Layer.mergeAll(TraceQueryServiceLive, LogQueryServiceLive).pipe(Layer.provideMerge(TelemetryStoreLive))

const QueryRuntimeLive = config.otel.enabled ? Layer.mergeAll(QueryServicesLive, telemetryLayer) : QueryServicesLive

export const queryRuntime = ManagedRuntime.make(QueryRuntimeLive)
export const storeRuntime = ManagedRuntime.make(TelemetryStoreLive)
