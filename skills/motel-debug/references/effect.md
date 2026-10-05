# Effect Notes

Apply these only when the target repo already uses Effect or `@effect/*`.

## Runtime

- Inspect the existing runtime and observability wiring before adding anything new.
- Prefer the repo's existing Effect-native observability APIs if they already exist.
- If `effect/observability` is already the best fit, prefer it over adding new OTEL packages.
- Merge telemetry into the main runtime once, not per feature or per request path.

## Instrumentation

- Prefer `Effect.fn("...")` for meaningful workflow spans.
- Add a few child spans around boundaries that are likely to fail or add latency.
- Emit `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError` with structured fields.
- Put searchable values in annotations/attributes, not only in the free-form log body.
- Reuse stable debug keys such as `debug.session`, `debug.hypothesis`, `debug.step`, and `debug.label`.

## Debug Blocks

Wrap temporary debug-only Effect instrumentation in removable markers.

```ts
// #region motel debug
const program = Effect.fn("feature/doThing")(function*() {
	yield* Effect.logInfo("entered doThing", {
		debug: {
			session: "abc123",
			hypothesis: "cache-miss",
			step: "entry",
		},
	})
})
// #endregion motel debug
```

Keep those blocks until the fix is verified, then remove them with the cleanup script.
