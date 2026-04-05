import { config } from "./config.js"

export const effectSetupInstructions = () => `Set this app up to export local OpenTelemetry traces and logs to my local leto dev server.

Target endpoints:
- OTLP HTTP traces: ${config.otel.exporterUrl}
- OTLP HTTP logs: ${config.otel.logsExporterUrl}
- leto local API / UI: ${config.otel.queryUrl}

If this codebase uses Effect beta, wire observability like this:

1. Install dependencies:
   bun add @effect/opentelemetry @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-logs-otlp-http @opentelemetry/sdk-trace-base @opentelemetry/sdk-logs

2. Add a telemetry layer:

import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"

const TelemetryLive = NodeSdk.layer(() => ({
  spanProcessor: new SimpleSpanProcessor(
    new OTLPTraceExporter({
      url: "${config.otel.exporterUrl}",
    }),
  ),
  logRecordProcessor: new SimpleLogRecordProcessor(
    new OTLPLogExporter({
      url: "${config.otel.logsExporterUrl}",
    }),
  ),
  loggerMergeWithExisting: false,
  resource: {
    serviceName: "<replace-service-name>",
    attributes: {
      "deployment.environment.name": "local",
    },
  },
}))

3. Merge that layer into the main runtime.

4. Wrap meaningful workflows with Effect.fn("...") and child spans.

5. Emit structured logs with Effect.logInfo / Effect.logWarning / Effect.logError inside those spans.

6. Add useful span events / annotations when a workflow has notable milestones.

7. Verify traces and logs:
   curl ${config.otel.queryUrl}/api/services
   curl "${config.otel.queryUrl}/api/traces?service=<service-name>&limit=20&lookback=1h"
   curl "${config.otel.queryUrl}/api/traces/search?service=<service-name>&operation=<text-fragment>&status=error"
   curl ${config.otel.queryUrl}/api/logs?service=<service-name>
   curl ${config.otel.queryUrl}/api/logs?service=<service-name>&body=<text-fragment>
   curl ${config.otel.queryUrl}/api/facets?type=logs&field=severity
   bun run cli logs <service-name>
   bun run cli search-logs <service-name> <text-fragment>

Keep the change minimal and idiomatic for the target repo.`
