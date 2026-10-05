import { Schema } from "effect"

// Worker RPC encodes with the JSON codec, which walks the whole value and
// rejects `Date`, `undefined`, non-finite numbers, etc. Worker messages travel
// via structured clone, so pass values through untouched.
export const StructuredClone = Schema.declare((_: unknown): _ is unknown => true, { toCodecJson: () => undefined })
