import { Effect } from "effect"
import * as Atom from "effect/reactivity/Atom"
import type { AiCallDetail } from "../domain.ts"
import { queryRuntime } from "../runtime.ts"
import { TelemetryStoreReadonly } from "../services/TelemetryStore.ts"
import type { LoadStatus } from "./atoms.ts"
import { makeCachedLoader } from "./cachedLoader.ts"

// AI chat view (full-screen when drilled into an `isAiSpan` span).
// ---------------------------------------------------------------------
// The main pane is a normal selectable list of semantic chunks (one row
// per chunk, with stable list scrolling). Opening a chunk shows its full
// content in a modal overlay that owns its own line scroll offset. This
// feels much closer to the rest of motel than the previous in-line
// expansion experiment.
// ---------------------------------------------------------------------
/** Chunk id currently selected in the list (null = first chunk). */
export const selectedChatChunkIdAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)
/** Chunk id whose detail modal is currently open. */
export const chatDetailChunkIdAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)
/** Line scroll offset inside the open detail modal. */
export const chatDetailScrollOffsetAtom = Atom.make(0).pipe(Atom.keepAlive)

export interface AiCallDetailState {
	readonly status: LoadStatus
	readonly spanId: string | null
	readonly data: AiCallDetail | null
	readonly error: string | null
}

export const initialAiCallDetailState: AiCallDetailState = {
	status: "ready",
	spanId: null,
	data: null,
	error: null,
}

export const aiCallDetailStateAtom = Atom.make(initialAiCallDetailState).pipe(Atom.keepAlive)

export const loadAiCallDetail = (spanId: string) =>
	queryRuntime.runPromise(Effect.flatMap(TelemetryStoreReadonly, (service) => service.getAiCall(spanId)))

// AI call detail cache: the `ai.prompt` payload can easily be 50KB+ and
// we don't want to re-hit SQLite every time j/k moves the selection
// between adjacent AI spans. Cleared alongside the other per-refresh
// caches in `useTraceScreenData`.
const aiCallDetailLoader = makeCachedLoader<string, AiCallDetail | null>({
	load: loadAiCallDetail,
})

export const getCachedAiCallDetail = (spanId: string): AiCallDetail | null | undefined =>
	aiCallDetailLoader.get(spanId)

export const ensureAiCallDetail = (spanId: string): Promise<AiCallDetail | null> =>
	aiCallDetailLoader.ensure(spanId)

export const invalidateAiCallDetailCache = () => {
	aiCallDetailLoader.invalidate()
}
