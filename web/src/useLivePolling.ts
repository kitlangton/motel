import { useEffect, useRef, useState } from "react"
import { useAtomRefresh } from "@effect/atom-react"
import type { Atom } from "effect/unstable/reactivity"

// Live-polling policy.
//
// A CLI prints a /trace/<id> permalink at run start, so the page is usually
// opened before any spans have been exported and while the run keeps producing
// spans for minutes. We poll so the page fills in and grows without a manual
// reload.
//
// We can't lean on the trace's `isRunning` flag alone: OTLP only exports *ended*
// spans, so a trace whose root span is still open often looks "done" mid-run.
// Instead we watch a cheap `fingerprint` (e.g. the span count) and treat "did it
// just change?" as the real liveness signal, polling on a decaying schedule:
//
//   ACTIVE (1.5s) — not found yet, still running, or a new span arrived within
//                   the last ACTIVE_WINDOW. The "watching a live run" tier.
//   IDLE  (10s)   — quiet for a while but under STOP_AFTER; a slow heartbeat in
//                   case the run resumes.
//   STOPPED       — quiet for STOP_AFTER; assume the run is over and stop. A
//                   manual Refresh or revisiting the tab still fetches on demand.
//
// Polling pauses entirely while the tab is hidden and refetches immediately when
// it becomes visible again.
const ACTIVE_INTERVAL_MS = 1_500
const IDLE_INTERVAL_MS = 10_000
const ACTIVE_WINDOW_MS = 30_000
const STOP_AFTER_MS = 5 * 60_000

export interface LivePollingOptions {
	/** Atom refreshed on each tick. */
	readonly atom: Atom.Atom<unknown>
	/** Cheap fingerprint of the current data; a change marks the content active. */
	readonly fingerprint: number | string
	/** Keep polling fast while the resource is known to still be open. */
	readonly running?: boolean
	/** Keep polling fast while the resource hasn't appeared yet (404 / empty). */
	readonly pending?: boolean
	/** Refreshed alongside `atom` each tick (e.g. a correlated logs atom). */
	readonly onRefresh?: () => void
}

/**
 * Polls `atom` on a decaying schedule while the tab is visible. Returns whether
 * polling is currently in its ACTIVE tier, for rendering a live indicator.
 */
export function useLivePolling({
	atom,
	fingerprint,
	running = false,
	pending = false,
	onRefresh,
}: LivePollingOptions): boolean {
	const refresh = useAtomRefresh(atom)
	const [active, setActive] = useState(true)

	// Record when the fingerprint last changed without re-running the effect.
	const lastChangeAt = useRef(Date.now())
	const prevFingerprint = useRef(fingerprint)
	if (fingerprint !== prevFingerprint.current) {
		prevFingerprint.current = fingerprint
		lastChangeAt.current = Date.now()
	}

	// Latest inputs, read at schedule time so the loop need not restart on change.
	const signals = useRef({ running, pending, onRefresh })
	signals.current = { running, pending, onRefresh }

	// The timer and scheduler live in refs so the re-arm effect below can check
	// for a pending tick and restart a STOPPED loop without re-running (and thus
	// resetting) the main effect.
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const scheduleRef = useRef<(() => void) | undefined>(undefined)

	useEffect(() => {
		const stop = () => {
			if (timerRef.current !== undefined) clearTimeout(timerRef.current)
			timerRef.current = undefined
		}

		const schedule = () => {
			stop()
			if (document.visibilityState === "hidden") return
			const quietFor = Date.now() - lastChangeAt.current
			const { running, pending } = signals.current
			const isActive = pending || running || quietFor < ACTIVE_WINDOW_MS
			setActive(isActive)
			const delay = isActive ? ACTIVE_INTERVAL_MS : quietFor < STOP_AFTER_MS ? IDLE_INTERVAL_MS : null
			if (delay === null) return
			timerRef.current = setTimeout(() => {
				timerRef.current = undefined
				refresh()
				signals.current.onRefresh?.()
				schedule()
			}, delay)
		}
		scheduleRef.current = schedule

		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				refresh()
				signals.current.onRefresh?.()
				schedule()
			} else {
				stop()
			}
		}

		schedule()
		document.addEventListener("visibilitychange", onVisibilityChange)
		return () => {
			stop()
			scheduleRef.current = undefined
			document.removeEventListener("visibilitychange", onVisibilityChange)
		}
	}, [refresh])

	// Re-arm a STOPPED loop. Once schedule() decides to stop, nothing ticks — so
	// if the data changes anyway (a manual Refresh found new spans) or the
	// resource flips back to pending/running, restart the schedule. The timer
	// guard prevents double-scheduling while a tick is already pending.
	useEffect(() => {
		if (timerRef.current === undefined) scheduleRef.current?.()
	}, [fingerprint, running, pending])

	return active
}
