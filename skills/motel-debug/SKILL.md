---
name: motel-debug
description: Debug applications with motel, a local OpenTelemetry ingest and query server. Use when the user wants runtime-evidence debugging with traces or logs, wants temporary debug instrumentation that can be removed later, or needs a repo wired to send OTLP/HTTP telemetry to a local motel server. If the target repo uses Effect or @effect/*, also read references/effect.md.
---

# Motel Debug

You are in **debug mode**. Debug with runtime evidence, not guesswork.

Agents guess based on code alone. You need actual runtime data. Motel is the local OpenTelemetry server that collects traces and logs — use it as your evidence loop.

Default local server details:

- Base URL: `http://127.0.0.1:27686`
- OTLP traces: `POST /v1/traces`
- OTLP logs: `POST /v1/logs`
- Query API: `GET /api/*`
- OpenAPI: `GET /openapi.json`
- Header: `Content-Type: application/json` or `Content-Type: application/x-protobuf`
- Auth: none by default

If the user provides a different motel URL, use that instead of the default.

## Workflow

### 1. Verify motel is running — and start it if not

Check `GET /api/health`. If it returns 200, continue.

If it fails (connection refused, timeout, non-200), motel isn't running.
Start it as a background daemon — **do not** launch the TUI, which is
interactive and will block your shell:

```bash
motel start
```

`motel start` ensures a managed daemon process is running, writes a
lockfile under `.motel-data/`, and returns a JSON status blob. It's
idempotent — safe to call repeatedly. If motel isn't on `PATH`, fall
back to `bunx @kitlangton/motel start`.

After starting, re-check `GET /api/health` (may take 1–2s to become
ready). If it still fails, read `.motel-data/daemon.log` for the error
and surface it to the user.

Other lifecycle commands, for reference:

```bash
motel status   # JSON status (running? pid? workdir?)
motel stop     # stop the managed daemon for this workdir
```

Discover reporting services with `GET /api/services` when needed.

### 2. Generate hypotheses

Before touching any code, generate **3-5 specific hypotheses** about why the bug occurs. Be precise — "the cache key doesn't include the user ID" is better than "something is wrong with caching."

### 3. Instrument with tagged debug blocks

Add the minimum instrumentation needed to confirm or reject **all** hypotheses in parallel. Every debug block must:

- Be wrapped in `#region motel debug` / `#endregion motel debug` markers
- Include a `debug.hypothesis` attribute linking it to a specific hypothesis
- Use whatever tracing/logging mechanism the codebase already has (spans, structured logs, annotations — not raw `fetch` calls)

Tag every piece of debug instrumentation with structured attributes so you can query it later. Reuse these keys:

| Key | Purpose |
|-----|---------|
| `debug.session` | Groups all instrumentation for this debug session |
| `debug.hypothesis` | Links to a specific hypothesis (e.g. `"cache-miss"`, `"A"`) |
| `debug.step` | Position in the flow (e.g. `"entry"`, `"before-write"`, `"after-read"`) |
| `debug.label` | Human-readable description of what this point captures |

Choose log placements based on your hypotheses:

- Function entry with parameters
- Function exit with return values
- Values before and after critical operations
- Branch execution paths (which if/else ran)
- State mutations and intermediate values
- Suspected error or edge-case values

Guidelines:

- At least 1 instrumentation point is required; never skip instrumentation
- Do not exceed 10 — if you think you need more, narrow your hypotheses
- Typical range is 2-6

### 4. Reproduce the issue

- If a failing test exists, run it directly
- If reproduction is straightforward (CLI command, curl, simple script), write and run it yourself
- Otherwise, ask the user to reproduce — provide clear numbered steps and remind them to restart if needed
- Once a reproduction pathway is established, reuse it for all subsequent iterations

### 5. Analyze evidence

Query motel for the debug instrumentation:

```bash
curl "http://127.0.0.1:27686/api/spans/search?service=<service>&attr.debug.hypothesis=<id>"
curl "http://127.0.0.1:27686/api/logs/search?service=<service>&attr.debug.session=<session>"
curl "http://127.0.0.1:27686/api/traces/search?service=<service>&attr.debug.hypothesis=<id>"
```

For each hypothesis, evaluate: **CONFIRMED**, **REJECTED**, or **INCONCLUSIVE** — cite specific spans, logs, or attribute values as evidence.

### 6. Fix only with evidence

Do **not** fix without runtime evidence. When you fix:

- Keep all debug instrumentation in place — do not remove it yet
- Make the fix as small and targeted as possible
- Reuse existing architecture and patterns; do not overengineer

### 7. Verify the fix

Reproduce the issue again with instrumentation still active. Compare before/after evidence:

- Cite specific log lines or span attributes that prove the fix works
- If the fix failed: **revert code changes from rejected hypotheses** (do not let speculative fixes accumulate), generate new hypotheses from different subsystems, add more instrumentation, and iterate
- Iteration is expected. Taking longer with more data yields better fixes.

### 8. Clean up

Only after the fix is verified **and** the user confirms there are no remaining issues:

- Run the cleanup script or remove blocks manually (see Cleanup section below)
- Run `git diff` to confirm only the intentional fix remains

## Instrumentation Rules

Wrap every temporary debug block in these exact markers:

```ts
// #region motel debug
// temporary debug instrumentation
// #endregion motel debug
```

Use whatever the codebase already provides for tracing and logging. The markers are language-comment wrappers — adapt the comment syntax for non-JS/TS files (e.g. `# #region motel debug` for Python).

**Do not:**
- Log secrets, tokens, passwords, or raw PII
- Remove instrumentation before post-fix verification succeeds
- Use `setTimeout`, `sleep`, or artificial delays as a "fix"
- Let code changes from rejected hypotheses accumulate — revert them

## Query Patterns

Two filter prefixes for attribute search:

| Prefix | Match type | Example |
|--------|-----------|---------|
| `attr.<key>=<value>` | Exact match | `attr.debug.hypothesis=cache-miss` |
| `attrContains.<key>=<substring>` | Case-insensitive substring | `attrContains.ai.prompt.messages=hello world` |

```bash
curl http://127.0.0.1:27686/api/health
curl http://127.0.0.1:27686/api/services

# Trace search
curl "http://127.0.0.1:27686/api/traces/search?service=<service>&operation=<text>&attr.debug.session=<session>"

# Span search (supports traceId to scope to one trace)
curl "http://127.0.0.1:27686/api/spans/search?service=<service>&traceId=<trace-id>&attr.debug.hypothesis=<id>"
curl "http://127.0.0.1:27686/api/spans/search?service=<service>&attrContains.ai.prompt.messages=<phrase>"

# Log search (supports severity filter, case-insensitive body search)
curl "http://127.0.0.1:27686/api/logs/search?service=<service>&severity=ERROR&body=<text>"
curl "http://127.0.0.1:27686/api/logs/search?service=<service>&attrContains.debug.label=<substring>"

# AI call search (compact summaries with previews)
curl "http://127.0.0.1:27686/api/ai/calls?model=gpt-5.4&sessionId=<session>"
curl "http://127.0.0.1:27686/api/ai/calls?text=<phrase>&status=error"

# AI call detail (full prompt/response payloads)
curl "http://127.0.0.1:27686/api/ai/calls/<span-id>"

# AI stats
curl "http://127.0.0.1:27686/api/ai/stats?groupBy=model&agg=total_input_tokens"

curl http://127.0.0.1:27686/openapi.json
```

List and search responses include `meta.nextCursor` when more data is available.

Motel gives you trace-correlated data — you can see which span a debug log belongs to, the parent operation, timing, and the full trace tree. Use `GET /api/traces/<trace-id>/spans` and `GET /api/spans/<span-id>/logs` to navigate the correlation.

For AI/LLM calls, use `/api/ai/calls` for compact searchable summaries (with prompt/response previews and token usage), and `/api/ai/calls/<span-id>` for full payloads.

## Effect

If the target repo uses Effect, read `references/effect.md` before changing runtime wiring or adding instrumentation.

## Cleanup

Use the bundled script at `scripts/clear-motel-debug.ts` when you want deterministic cleanup. It removes every block between `#region motel debug` and `#endregion motel debug` in JS/TS files and fails on unmatched markers.

If you cannot run the script, delete every marked block manually and then grep for `#region motel debug` to confirm none remain.
