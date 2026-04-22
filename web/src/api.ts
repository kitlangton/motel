import { FetchHttpClient } from "effect/unstable/http"
import { AtomHttpApi } from "effect/unstable/reactivity"
import { MotelHttpApi } from "@motel/httpApi"

export const MotelClient = AtomHttpApi.Service()("MotelClient", {
	api: MotelHttpApi,
	httpClient: FetchHttpClient.layer,
	baseUrl: window.location.origin,
})
