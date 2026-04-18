import { BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { ServerLive } from "./localServer.js"

// `BunRuntime.runMain` installs signal handlers that interrupt the root
// fiber on SIGINT/SIGTERM; `Layer.launch` holds the scope open until
// then. On interruption the scope closes top-down: RegistryLayer's
// release removes the daemon's registry entry, BunHttpServer's release
// calls server.stop(), SQLite connections close — all through layer
// finalizers instead of ad-hoc process.exit handlers.
Layer.launch(ServerLive).pipe(BunRuntime.runMain)
