import { useAtom } from "@effect/atom-react"
import { useEffect } from "react"
import {
	attrFacetStateAtom,
	attrPickerModeAtom,
	ensureTraceAttributeKeys,
	ensureTraceAttributeValues,
	getCachedFacetKeys,
	getCachedFacetValues,
	initialAttrFacetState,
	selectedTraceServiceAtom,
} from "./state.ts"

// Drive the picker's data state from (pickerMode, service, selectedKey).
//
// Strategy: stale-while-revalidate. On reopen we publish whatever the
// module-level cache has instantly (no "loading…" flash), then kick off a
// background revalidation. The first time we see a (service, key) tuple
// we still show `loading` so the UI has something to say. The module-level
// caches in `state.ts` mean a service-change pre-warm can fill the cache
// before the user ever presses `f`.
export const useAttrFilterPicker = (selectedKey: string | null) => {
	const [pickerMode] = useAtom(attrPickerModeAtom)
	const [service] = useAtom(selectedTraceServiceAtom)
	const [, setFacetState] = useAtom(attrFacetStateAtom)

	useEffect(() => {
		if (pickerMode === "off" || !service) {
			setFacetState(initialAttrFacetState)
			return
		}
		let cancelled = false
		const publishReady = (
			key: string | null,
			data: readonly { readonly value: string; readonly count: number }[],
		) => {
			setFacetState({ status: "ready", key, data, error: null })
		}
		const publishLoading = (
			key: string | null,
			previous: readonly {
				readonly value: string
				readonly count: number
			}[] = [],
		) => {
			setFacetState({ status: "loading", key, data: previous, error: null })
		}
		const publishError = (
			key: string | null,
			previous: readonly { readonly value: string; readonly count: number }[],
			err: unknown,
		) => {
			setFacetState({
				status: "error",
				key,
				data: previous,
				error: err instanceof Error ? err.message : String(err),
			})
		}

		if (pickerMode === "keys") {
			const cached = getCachedFacetKeys(service)
			if (cached) {
				publishReady(null, cached.data)
			} else {
				publishLoading(null)
			}
			ensureTraceAttributeKeys(service)
				.then((entry) => {
					if (cancelled) return
					publishReady(null, entry.data)
				})
				.catch((err) => {
					if (cancelled) return
					publishError(null, cached?.data ?? [], err)
				})
		} else if (selectedKey) {
			const cached = getCachedFacetValues(service, selectedKey)
			if (cached) {
				publishReady(selectedKey, cached.data)
			} else {
				publishLoading(selectedKey)
			}
			ensureTraceAttributeValues(service, selectedKey)
				.then((entry) => {
					if (cancelled) return
					publishReady(selectedKey, entry.data)
				})
				.catch((err) => {
					if (cancelled) return
					publishError(selectedKey, cached?.data ?? [], err)
				})
		} else {
			// values mode with no key yet — just show empty state.
			publishReady(null, [])
		}

		return () => {
			cancelled = true
		}
	}, [pickerMode, service, selectedKey, setFacetState])
}
