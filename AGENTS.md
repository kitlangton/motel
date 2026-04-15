# AGENTS.md

## Commands
- Install deps: `bun install`
- Run the TUI: `bun run dev` or `bun run start`
- Run the local server only: `bun run server`
- Run tests: `bun run test`
- Query services via CLI: `bun run cli services`
- Query traces via CLI: `bun run cli traces <service> [limit]`
- Query a span via CLI: `bun run cli span <span-id>`
- Query spans for one trace: `bun run cli trace-spans <trace-id>`
- Search spans via CLI: `bun run cli search-spans [service] [operation] [parent=<operation>] [attr.key=value ...]`
- Search traces via CLI: `bun run cli search-traces <service> [operation] [attr.key=value ...]`
- Query trace stats via CLI: `bun run cli trace-stats <groupBy> <agg> [service] [attr.key=value ...]`
- Query logs via CLI: `bun run cli logs <service>`
- Search logs via CLI: `bun run cli search-logs <service> [body] [attr.key=value ...]`
- Query log stats via CLI: `bun run cli log-stats <groupBy> [service] [attr.key=value ...]`
- Query logs for one trace: `bun run cli trace-logs <trace-id>`
- Query logs for one span: `bun run cli span-logs <span-id>`
- Query facets via CLI: `bun run cli facets <traces|logs> <field>`
- Print Effect setup instructions: `bun run instructions`
- Typecheck: `bun run typecheck`

## Verification
- The built-in verification step is `bun run typecheck`.
- For runtime verification, start the TUI or server once, then query `http://127.0.0.1:27686/api/services`, `http://127.0.0.1:27686/api/spans/<span-id>`, `http://127.0.0.1:27686/openapi.json`, and `bun run cli logs motel-otel-tui`.
- For span-centric debugging, use `http://127.0.0.1:27686/api/spans/search?...`, `http://127.0.0.1:27686/api/spans/<span-id>/logs`, and `http://127.0.0.1:27686/api/traces/<trace-id>/spans`.

## API Notes
- List and search endpoints return a `meta` object with `limit`, `lookback`, `returned`, `truncated`, and `nextCursor`.
- `/api/traces` and `/api/traces/search` return summaries by default. Use `/api/traces/<trace-id>` for the full trace tree.
- `/api/logs` and `/api/logs/search` support `severity` (e.g. `?severity=ERROR`), case-insensitive body search, and `attrContains.<key>=<substring>` for substring search inside attribute values.
- `/api/spans/search` supports `traceId` to scope to one trace, `attr.<key>=<value>` for exact match, and `attrContains.<key>=<substring>` for case-insensitive substring search inside attribute values.
- `/api/ai/calls` searches AI SDK calls (streamText, generateText, etc.) with first-class filters for `model`, `provider`, `sessionId`, `functionId`, `operation`, `status`, `text` (cross-field search), and returns compact summaries with previews and token usage.
- `/api/ai/calls/<span-id>` returns the full detail of a single AI call including complete prompt messages, response text, tool calls, timing, and correlated logs.
- `/api/ai/stats` aggregates AI call statistics by `provider`, `model`, `functionId`, `sessionId`, or `status` with aggregations: `count`, `avg_duration`, `p95_duration`, `total_input_tokens`, `total_output_tokens`.
- `/api/docs` lists available documentation; `/api/docs/debug` and `/api/docs/effect` return the full skill content.

## Architecture
- `src/index.tsx` creates the OpenTUI renderer and mounts the app.
- `src/App.tsx` contains the main UI, keyboard bindings, trace view, and correlated log view.
- `src/cli.ts` exposes trace and log queries through a small local CLI wrapper.
- `src/runtime.ts` wires the Effect beta runtime and OTEL trace + log exporters.
- `src/localServer.ts` starts the local Bun OTLP/query server.
- `src/httpApi.ts` defines the typed Effect HttpApi surface and OpenAPI spec for the local server.
- `src/server.ts` runs the local server without the TUI.
- `src/instructions.ts` contains the copied setup instructions for other Effect apps.
- `src/services/TelemetryStore.ts` persists traces and logs in SQLite and exposes indexed queries.
- `src/services/TraceQueryService.ts` reads traces from the local store.
- `src/services/LogQueryService.ts` reads logs from the local store.
- `src/config.ts` is the source of truth for ports and env-driven OTEL settings.

## Effect Observability Guidance
- Inspect the target repo’s existing Effect runtime and observability wiring before adding anything new.
- Prefer the repo’s existing Effect-native observability APIs if available.
- If `effect/unstable/observability` is already the best fit, prefer it over adding `@effect/opentelemetry`.
- Only add new OpenTelemetry SDK packages when the repo already uses them or they are clearly required.
- Merge telemetry into the main runtime once, not per-feature.
- Prefer structured log annotations so fields like `sessionID`, `modelID`, `providerID`, and `tool` are queryable.

## Local OTEL Ports
- Local API / UI base: `http://127.0.0.1:27686`
- OTLP HTTP traces: `http://127.0.0.1:27686/v1/traces`
- OTLP HTTP logs: `http://127.0.0.1:27686/v1/logs`
- Health: `http://127.0.0.1:27686/api/health`

## Env Vars
- `MOTEL_OTEL_ENABLED`: defaults to `true`
- `MOTEL_OTEL_SERVICE_NAME`: defaults to `motel-otel-tui`
- `MOTEL_OTEL_BASE_URL`: defaults to `http://127.0.0.1:27686`
- `MOTEL_OTEL_HOST`: defaults to `127.0.0.1`
- `MOTEL_OTEL_PORT`: defaults to `27686`
- `MOTEL_OTEL_EXPORTER_URL`: defaults to `http://127.0.0.1:27686/v1/traces`
- `MOTEL_OTEL_LOGS_EXPORTER_URL`: defaults to `http://127.0.0.1:27686/v1/logs`
- `MOTEL_OTEL_QUERY_URL`: defaults to `http://127.0.0.1:27686`
- `MOTEL_OTEL_DB_PATH`: defaults to `.motel-data/telemetry.sqlite`
- `MOTEL_OTEL_TRACE_LOOKBACK_MINUTES`: defaults to `90`
- `MOTEL_OTEL_TRACE_LIMIT`: defaults to `40`
- `MOTEL_OTEL_LOG_LIMIT`: defaults to `80`
- `MOTEL_OTEL_RETENTION_HOURS`: defaults to `12`

## TUI Keys
- `?`: toggle shortcut help
- `j` / `k` or `up` / `down`: move trace or span selection
- `ctrl-n` / `ctrl-p`: switch traces while staying in the details area
- `gg` / `home`: jump to the first trace or span
- `G` / `end`: jump to the last trace or span
- `ctrl-u` / `pageup`: page up
- `ctrl-d` / `pagedown`: page down
- `l`: toggle service logs
- `[` / `]`: switch services
- `enter`: enter spans or open span detail
- `esc`: back out of span detail or span selection
- `r`: refresh traces
- `c`: copy setup instructions for another Effect app
- `o`: open selected trace in the browser
- `q`: quit
