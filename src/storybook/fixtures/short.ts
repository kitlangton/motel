import { type ChatFixture, makeDetail, makeSpan } from "./index.ts"

// Minimal 2-turn Q&A. Serves as the "baseline sanity check" — if this
// doesn't render cleanly, something's wrong with the headers/wrapping.
export const shortFixture: ChatFixture = {
	id: "short",
	label: "short",
	span: makeSpan(),
	detail: makeDetail({
		promptMessages: {
			messages: [
				{
					role: "system",
					content: "You are a helpful assistant. Keep replies concise.",
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Hey, can you explain what SQLite WAL mode means in one paragraph?",
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "WAL (write-ahead log) is a journaling mode in SQLite where writes are appended to a separate `.wal` file instead of rewriting the main database in place. Readers can keep reading the last committed snapshot from the main file while a writer is appending to the WAL, which means concurrent reads and writes don't block each other. Periodically SQLite checkpoints the WAL back into the main database. The upside: much higher concurrency than the default rollback journal. The downside: you get an extra file per database and slightly more complex crash recovery.",
						},
					],
				},
			],
		},
		responseText:
			"WAL (write-ahead log) is a journaling mode in SQLite where writes are appended to a separate `.wal` file instead of rewriting the main database in place. Readers can keep reading the last committed snapshot from the main file while a writer is appending to the WAL, which means concurrent reads and writes don't block each other.",
	}),
}
