# leto

OpenTUI local OTEL viewer for development, with a local SQLite-backed telemetry server, correlated traces, and logs.

## Commands

- `bun install`
- `bun run server`
- `bun run dev`
- `bun run cli services`
- `bun run cli traces <service>`
- `bun run cli search-traces <service> [operation]`
- `bun run cli logs <service>`
- `bun run cli search-logs <service> [body]`
- `bun run cli trace-logs <trace-id>`
- `bun run cli facets <traces|logs> <field>`
- `bun run instructions`
- `bun run typecheck`

## Local ports

This repo uses one local Bun server with SQLite storage. No Docker is required.

- leto local API / UI base: `http://127.0.0.1:27686`
- OTLP HTTP traces: `http://127.0.0.1:27686/v1/traces`
- OTLP HTTP logs: `http://127.0.0.1:27686/v1/logs`
- health: `http://127.0.0.1:27686/api/health`

Other local apps can send telemetry to:

```bash
http://127.0.0.1:27686/v1/traces
http://127.0.0.1:27686/v1/logs
```

Agents and scripts can query traces and logs from the local API:

```bash
http://127.0.0.1:27686/api/services
http://127.0.0.1:27686/api/traces?service=<service>&limit=20&lookback=1h
http://127.0.0.1:27686/api/traces/search?service=<service>&operation=proxy&status=error
http://127.0.0.1:27686/api/logs?service=<service>&body=proxy_request
http://127.0.0.1:27686/api/logs?service=<service>&attr.service.name=<service>
http://127.0.0.1:27686/api/facets?type=logs&field=severity
```

## TUI keys

- `?`: show or hide keyboard shortcut help
- `j` / `k` or `up` / `down`: move selection
- `ctrl-n` / `ctrl-p`: switch traces even while in trace details
- `gg` or `home`: jump to the first trace or first span
- `G` or `end`: jump to the last trace or last span
- `ctrl-u` / `pageup`: move up by one page
- `ctrl-d` / `pagedown`: move down by one page
- `l`: toggle service logs mode
- `[` / `]`: switch service
- `enter`: enter span navigation or open selected span detail
- `esc`: leave span detail or span navigation
- `r`: refresh
- `c`: copy a paste-ready Effect setup prompt for another app
- `o`: open selected trace in browser
- `q`: quit

## How It Works

`leto` now has one local service process:

- the local Bun server receives OTLP traces and logs on `http://127.0.0.1:27686`
- it stores telemetry in SQLite at `.leto-data/telemetry.sqlite`
- it exposes query endpoints on the same base URL

So yes: another service has to point its OTEL exporters at this local leto instance.

The easiest flow is:

1. Run `bun run dev` here. That starts the local server if needed and then launches the TUI.
2. In `leto`, press `c`.
3. Paste the copied instructions into an agent working in the other service.
4. Have that service export OTEL traces to `http://127.0.0.1:27686/v1/traces` and OTEL logs to `http://127.0.0.1:27686/v1/logs`.
5. Refresh `leto`, switch to that service with `[` / `]`, and use `l` or `enter` to inspect logs under a trace or span.

## For Agents

An agent does not need to talk to the TUI.

Use one of these:

1. leto HTTP API directly

```bash
curl http://127.0.0.1:27686/api/services
curl "http://127.0.0.1:27686/api/traces?service=my-service&limit=20&lookback=1h"
curl http://127.0.0.1:27686/api/traces/<trace-id>
```

2. The local CLI wrapper in this repo

```bash
bun run cli services
bun run cli traces my-service 20
bun run cli search-traces my-service proxy
bun run cli trace <trace-id>
bun run cli logs my-service
bun run cli search-logs my-service timeout
bun run cli trace-logs <trace-id>
bun run cli facets logs severity
bun run instructions
```

Recommended shape going forward:

1. Keep leto as the single ingest point for apps.
2. Keep SQLite as the local source of truth.
3. Keep `leto` as the interactive viewer.
4. Keep the CLI and HTTP API as the agent/script interfaces.
