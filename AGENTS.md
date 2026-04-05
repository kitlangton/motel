# AGENTS.md

## Commands
- Install deps: `bun install`
- Run the TUI: `bun run dev` or `bun run start`
- Run the local server only: `bun run server`
- Query services via CLI: `bun run cli services`
- Query traces via CLI: `bun run cli traces <service> [limit]`
- Search traces via CLI: `bun run cli search-traces <service> [operation]`
- Query logs via CLI: `bun run cli logs <service>`
- Search logs via CLI: `bun run cli search-logs <service> [body]`
- Query logs for one trace: `bun run cli trace-logs <trace-id>`
- Query facets via CLI: `bun run cli facets <traces|logs> <field>`
- Print Effect setup instructions: `bun run instructions`
- Typecheck: `bun run typecheck`

## Verification
- The built-in verification step is `bun run typecheck`.
- For runtime verification, start the TUI or server once, then query `http://127.0.0.1:27686/api/services`, `http://127.0.0.1:27686/api/logs?service=leto-otel-tui`, and `bun run cli logs leto-otel-tui`.

## Architecture
- `src/index.tsx` creates the OpenTUI renderer and mounts the app.
- `src/App.tsx` contains the main UI, keyboard bindings, trace view, and correlated log view.
- `src/cli.ts` exposes trace and log queries through a small local CLI wrapper.
- `src/runtime.ts` wires the Effect beta runtime and OTEL trace + log exporters.
- `src/localServer.ts` starts the local Bun OTLP/query server.
- `src/server.ts` runs the local server without the TUI.
- `src/instructions.ts` contains the copied setup instructions for other Effect apps.
- `src/services/TelemetryStore.ts` persists traces and logs in SQLite and exposes indexed queries.
- `src/services/TraceQueryService.ts` reads traces from the local store.
- `src/services/LogQueryService.ts` reads logs from the local store.
- `src/config.ts` is the source of truth for ports and env-driven OTEL settings.

## Local OTEL Ports
- Local API / UI base: `http://127.0.0.1:27686`
- OTLP HTTP traces: `http://127.0.0.1:27686/v1/traces`
- OTLP HTTP logs: `http://127.0.0.1:27686/v1/logs`
- Health: `http://127.0.0.1:27686/api/health`

## Env Vars
- `LETO_OTEL_ENABLED`: defaults to `true`
- `LETO_OTEL_SERVICE_NAME`: defaults to `leto-otel-tui`
- `LETO_OTEL_BASE_URL`: defaults to `http://127.0.0.1:27686`
- `LETO_OTEL_HOST`: defaults to `127.0.0.1`
- `LETO_OTEL_PORT`: defaults to `27686`
- `LETO_OTEL_EXPORTER_URL`: defaults to `http://127.0.0.1:27686/v1/traces`
- `LETO_OTEL_LOGS_EXPORTER_URL`: defaults to `http://127.0.0.1:27686/v1/logs`
- `LETO_OTEL_QUERY_URL`: defaults to `http://127.0.0.1:27686`
- `LETO_OTEL_DB_PATH`: defaults to `.leto-data/telemetry.sqlite`
- `LETO_OTEL_TRACE_LOOKBACK_MINUTES`: defaults to `90`
- `LETO_OTEL_TRACE_LIMIT`: defaults to `40`
- `LETO_OTEL_LOG_LIMIT`: defaults to `80`
- `LETO_OTEL_RETENTION_HOURS`: defaults to `12`

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
