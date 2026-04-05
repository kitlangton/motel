import { Effect } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import { config } from "../config.ts"
import type { LogItem, TraceItem } from "../domain.ts"
import { queryRuntime } from "../runtime.ts"
import { LogQueryService } from "../services/LogQueryService.ts"
import { TraceQueryService } from "../services/TraceQueryService.ts"

export type LoadStatus = "loading" | "ready" | "error"
export type DetailView = "waterfall" | "span-detail" | "service-logs"

export interface TraceState {
	readonly status: LoadStatus
	readonly services: readonly string[]
	readonly data: readonly TraceItem[]
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

export const initialServiceLogState: ServiceLogState = {
	status: "ready",
	serviceName: null,
	data: [],
	error: null,
	fetchedAt: null,
}

export const traceStateAtom = Atom.make(initialTraceState).pipe(Atom.keepAlive)
export const logStateAtom = Atom.make(initialLogState).pipe(Atom.keepAlive)
export const serviceLogStateAtom = Atom.make(initialServiceLogState).pipe(Atom.keepAlive)
export const selectedServiceLogIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
export const selectedTraceIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
export const selectedTraceServiceAtom = Atom.make<string | null>(config.otel.serviceName).pipe(Atom.keepAlive)
export const refreshNonceAtom = Atom.make(0).pipe(Atom.keepAlive)
export const noticeAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)
export const selectedSpanIndexAtom = Atom.make<number | null>(null).pipe(Atom.keepAlive)
export const detailViewAtom = Atom.make<DetailView>("waterfall").pipe(Atom.keepAlive)
export const showHelpAtom = Atom.make(false).pipe(Atom.keepAlive)

export const loadTraceServices = () => queryRuntime.runPromise(Effect.flatMap(TraceQueryService.asEffect(), (service) => service.listServices))
export const loadRecentTraces = (serviceName: string) => queryRuntime.runPromise(Effect.flatMap(TraceQueryService.asEffect(), (service) => service.listRecentTraces(serviceName)))
export const loadTraceLogs = (traceId: string) => queryRuntime.runPromise(Effect.flatMap(LogQueryService.asEffect(), (service) => service.listTraceLogs(traceId)))
export const loadServiceLogs = (serviceName: string) => queryRuntime.runPromise(Effect.flatMap(LogQueryService.asEffect(), (service) => service.listRecentLogs(serviceName)))
