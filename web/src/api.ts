import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { AtomHttpApi } from "effect/reactivity"
import { MotelHttpApi } from "@motel/httpApi"

export const MotelClient = AtomHttpApi.Service()("MotelClient", {
	api: MotelHttpApi,
	httpClient: FetchHttpClient.layer,
	baseUrl: window.location.origin,
})
