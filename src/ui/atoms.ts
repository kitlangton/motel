import * as Atom from "effect/unstable/reactivity/Atom"
import { config } from "../config.ts"
import type { LogItem, TraceItem, TraceSummaryItem } from "../domain.ts"
import type { ThemeName } from "./theme.ts"
import { readLastService, readLastTheme } from "./persistence.ts"

export type LoadStatus = "loading" | "ready" | "error"
export type DetailView = "waterfall" | "span-detail" | "service-logs"

export interface TraceState {
	readonly status: LoadStatus
	readonly services: readonly string[]
	readonly data: readonly TraceSummaryItem[]
	readonly error: string | null
	readonly fetchedAt: Date | null
}

export interface TraceDetailState {
	readonly status: LoadStatus
	readonly traceId: string | null
	readonly data: TraceItem | null
	readonly error: string | null
	readonly fetchedAt: Date | null
}

export interface LogState {
	readonly status: LoadStatus
	readonly traceId: string | null
	readonly data: readonly LogItem[]
	readonly error: string | null
	readonly fetchedAt: Date | null
}

export interface ServiceLogState {
	readonly status: LoadStatus
	readonly serviceName: string | null
	readonly data: readonly LogItem[]
	readonly error: string | null
	readonly fetchedAt: Date | null
}

export const initialTraceState: TraceState = {
	status: "loading",
	services: [],
	data: [],
	error: null,
	fetchedAt: null,
}

export const initialLogState: LogState = {
	status: "ready",
	traceId: null,
	data: [],
	error: null,
	fetchedAt: null,
}

export const initialTraceDetailState: TraceDetailState = {
	status: "ready",
	traceId: null,
	data: null,
	error: null,
	fetchedAt: null,
}

export const initialServiceLogState: ServiceLogState = {
	status: "ready",
	serviceName: null,
	data: [],
	error: null,
	fetchedAt: null,
}

export const traceStateAtom = Atom.make(initialTraceState).pipe(Atom.keepAlive)
export const traceDetailStateAtom = Atom.make(initialTraceDetailState).pipe(
	Atom.keepAlive,
)
export const logStateAtom = Atom.make(initialLogState).pipe(Atom.keepAlive)
export const serviceLogStateAtom = Atom.make(initialServiceLogState).pipe(
	Atom.keepAlive,
)
export const selectedServiceLogIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
export const selectedTraceIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
export const selectedTraceServiceAtom = Atom.make<string | null>(
	readLastService() ?? config.otel.serviceName,
).pipe(Atom.keepAlive)
export const refreshNonceAtom = Atom.make(0).pipe(Atom.keepAlive)
export const noticeAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)
export const selectedSpanIndexAtom = Atom.make<number | null>(null).pipe(
	Atom.keepAlive,
)
// Cursor inside the full-screen span content view (detailView === "span-detail").
// Tracks which span tag is currently selected for copy / drill-in. Reset to 0
// on each new span so the cursor doesn't point past a shorter tag list.
export const selectedAttrIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
export const detailViewAtom = Atom.make<DetailView>("waterfall").pipe(
	Atom.keepAlive,
)
export const showHelpAtom = Atom.make(false).pipe(Atom.keepAlive)
export const autoRefreshAtom = Atom.make(true).pipe(Atom.keepAlive)
export const filterModeAtom = Atom.make(false).pipe(Atom.keepAlive)
export const filterTextAtom = Atom.make("").pipe(Atom.keepAlive)

// Waterfall-scoped filter: the `/` key while drilled into a trace
// (viewLevel >= 1) opens this filter instead of the trace-list one.
// Purely client-side — dims spans whose operation name and attribute
// values don't contain the needle.
export const waterfallFilterModeAtom = Atom.make(false).pipe(Atom.keepAlive)
export const waterfallFilterTextAtom = Atom.make("").pipe(Atom.keepAlive)

// Attribute filter (F key): pick a span-attribute key + exact value to restrict the trace list.
export type AttrPickerMode = "off" | "keys" | "values"
export const attrPickerModeAtom = Atom.make<AttrPickerMode>("off").pipe(
	Atom.keepAlive,
)
export const attrPickerInputAtom = Atom.make("").pipe(Atom.keepAlive)
export const attrPickerIndexAtom = Atom.make(0).pipe(Atom.keepAlive)

export interface AttrFacetState {
	readonly status: LoadStatus
	readonly key: string | null
	readonly data: readonly { readonly value: string; readonly count: number }[]
	readonly error: string | null
}

export const initialAttrFacetState: AttrFacetState = {
	status: "ready",
	key: null,
	data: [],
	error: null,
}

export const attrFacetStateAtom = Atom.make(initialAttrFacetState).pipe(
	Atom.keepAlive,
)

// Applied filter (drives trace list query)
export const activeAttrKeyAtom = Atom.make<string | null>(null).pipe(
	Atom.keepAlive,
)
export const activeAttrValueAtom = Atom.make<string | null>(null).pipe(
	Atom.keepAlive,
)

export const selectedThemeAtom = Atom.make<ThemeName>(readLastTheme()).pipe(
	Atom.keepAlive,
)

export type TraceSortMode = "recent" | "slowest" | "errors"
export const traceSortAtom = Atom.make<TraceSortMode>("recent").pipe(
	Atom.keepAlive,
)
export const collapsedSpanIdsAtom = Atom.make(
	new Set<string>() as ReadonlySet<string>,
).pipe(Atom.keepAlive)
