# Storage Engine Architecture: Day-Split SQLite

Open design choices specify the default implementation and the benchmark (§8) that decides whether an alternative variant wins.

## 1. The engine in five sentences

1. One Rust daemon writes every event into one SQLite file per arrival day, holding a lean, wide `events` table with binary IDs, JSONB attributes, interned resources and six indexes, and no full-text, per-attribute or fingerprint index.
2. A single writer thread drains a byte-budgeted queue (429 when full), commits in groups every 50 ms or at 2,048 rows or 1 MiB, commits tailer cursors in the same transaction as their rows, and acknowledges a request only after its commit.
3. Hot files run in WAL mode with `fullfsync` on SQLite ≥ 3.51.3; by default the WAL is made durable at least once a second on the writer thread, full sync on every commit is the alternative that B4 decides, and neither mode can corrupt the store.
4. At midnight a day is sealed in place (checkpoint, `quick_check`, `ANALYZE`, rollback mode, rename), after which retention is `unlink`, `forget` is a resumable rewrite, and crashes, profiles and runs live in a separate 180-day `evidence.sqlite`.
5. Queries pick files by recorded event-time range, run indexed SQL per file and merge newest first with a rule that stays correct for late events, while capped caches, `mmap` off and byte budgets keep the daemon under 50 MB, and the CLI reads the same files read-only when the daemon is down.

## 2. Files and schema

```
~/.local/state/motel/
  motel.lock                  flock, held by the daemon
  days/D.hot.sqlite           arrival day D, WAL mode (+ -wal, -shm)
  days/D.sqlite               sealed, rollback mode, read-only
  days/D.sqlz                 phase 2: sealed and compressed (§2.6)
  evidence.sqlite             180-day evidence, its cursors, purge log
  artifacts/D/<id>.zst        copies made by `motel add --copy` (1 GiB cap)
  trash/                      files being deleted
```

### 2.1 DDL (every day file and `evidence.sqlite`)

```sql
create table events (
  id          integer primary key,        -- rowid = arrival order; API id "<D>:<id>"
  ts          integer not null,           -- event time, unix ns
  ingest_ts   integer not null,           -- arrival time, unix ns
  dur         integer,                    -- ns
  kind        text not null,              -- span|log|metric|crash|profile|inspect|run|test
  service     text not null,
  severity    integer,                    -- OTLP severity number
  status      text,                       -- ok|error|pass|fail|null
  err         integer not null default 0, -- span error, severity>=17, crash, failed run/test
  name        text,
  trace_id    blob, span_id blob, parent_id blob,  -- 16/8/8 raw bytes
  session_id  text,
  request_id  text,
  res         integer references resources(id),
  src         integer,                    -- 0 otlp, 1 file, 2 ips, 3 unified, 4 run, 5 evidence
  artifact    text,                       -- path to the original file
  body        text,                       -- UTF-8, capped at 16 KiB
  attrs       blob                        -- SQLite JSONB
);
create index ix_ts      on events(ts);
create index ix_svc_ts  on events(service, ts);
create index ix_err     on events(service, ts) where err = 1;
create index ix_trace   on events(trace_id, ts) where trace_id is not null;
create index ix_session on events(session_id, ts) where session_id is not null;
create index ix_req     on events(request_id, ts) where request_id is not null;

create table resources (
  id integer primary key, hash blob not null unique,   -- xxh3-128 of canonical attrs
  host text, service text, version text, pid integer, attrs blob
);
create table cursors (
  source text primary key, dev integer, ino integer, head_hash blob,
  offset integer not null, updated_ingest_ts integer not null
) without rowid;
create table _meta (k text primary key, v) without rowid;
  -- format_version, machine, day, state (hot|sealed), min_ts, max_ts,
  -- min_ingest_ts, max_ingest_ts, rows, durable_ingest_ts, sealed_at, sqlite_version
create table block_bloom (                  -- optional; only if B2 says so
  block integer primary key,                -- id >> 12, 4,096 rows per block
  first_id integer not null, last_id integer not null,
  k integer not null, bits blob not null
);
```

`evidence.sqlite` adds `purges(id integer primary key, created_ts, predicate text, since_ts, until_ts, state text, done text)` and an `artifacts` table.

Only `ix_trace` and `ix_req` insert at random. Deduplication for file tailers comes from `cursors` (§3.4) rather than a unique fingerprint index.

### 2.2 PRAGMAs and version floor

The floor is **SQLite ≥ 3.51.3**: earlier versions have a WAL-reset corruption race between a checkpoint and a writer on separate connections. `rusqlite` 0.41 bundles SQLite 3.54.x. The daemon refuses to start if `sqlite3_libversion_number() < 3051003`. Build with `-DSQLITE_MAX_ATTACHED=32 -DSQLITE_DQS=0 -DSQLITE_OMIT_LOAD_EXTENSION`.

| | Hot writer | Checkpointer | Readers |
|---|---|---|---|
| `page_size` | 4096 (8192 is a B1 variant) | | |
| `journal_mode` | WAL | WAL | |
| `synchronous` | NORMAL; FULL in Mode F (§3.3) | | |
| `fullfsync`, `checkpoint_fullfsync` | ON, ON | ON, ON | |
| `wal_autocheckpoint` | 0 | | |
| `journal_size_limit` | 16 MiB | 16 MiB | |
| `cache_size` | 8 MiB | 512 KiB | 2 MiB, +256 KiB per attached file |
| `mmap_size` | 0 | 0 | 0 |
| `temp_store` | FILE | | FILE |
| `secure_delete` | FAST (ON during `forget`) | | |
| other | | | `query_only=1`; sealed files `?immutable=1` |

Process-wide: soft heap limit 18 MiB, hard 28 MiB. On `SQLITE_NOMEM` the writer closes every reader and retries the batch once.

### 2.3 Attributes

- OTLP `AnyValue` maps to JSON as-is; int64 stays an integer, bytes become base64, dotted keys stay flat (`{"http.route": "/x"}`).
- Rust encodes canonical JSON directly into SQLite's binary JSONB format with strict RFC 8259 validation (`direct_jsonb = true` by default), falling back to SQLite's `jsonb(?)` if the fast-path encoder declines an input.
- The redactor runs first. `session_id`, `request_id`, trace IDs and error state are extracted in Rust at decode time, not by generated columns.
- A field promoted later is a generated virtual column plus index, added when the next day file is created; the union view gives older files `NULL`.
- A scalar function `attr(attrs, 'http.route')` hides JSON-path quoting from callers.
- Resources are stored once per file, behind a 4,096-entry hash-to-id LRU.

### 2.4 Arrival day and event time

A row goes into the file for the UTC day it **arrives**, so late events never reopen a sealed file. Day transitions roll forward monotonically. Each commit updates `_meta` `min_ts`, `max_ts` and `max_ingest_ts` in the same transaction. Queries select every file whose `[min_ts, max_ts]` overlaps the window. Retention age is arrival age.

### 2.5 Sealing

At UTC midnight the writer opens `D+1.hot.sqlite`, and a background-QoS sealer works on `D`:

1. Mark `D` as sealing, wait for the daemon's readers on it, and retry on `SQLITE_BUSY` from external readers.
2. `wal_checkpoint(TRUNCATE)`, then `quick_check` (a corruption failure quarantines the file as `D.corrupt.sqlite` along with its `-wal` and `-shm`), `ANALYZE`, set `_meta.state = sealed`, then `journal_mode=DELETE`.
3. `F_FULLFSYNC` the file, atomically rename to `D.sqlite` without overwriting an existing sealed file, and fsync `days/`. The rename is the durable marker.

No `VACUUM INTO` by default: an insert-only file has no freelist. A file left by `forget` with over 10% free pages is rewritten. B2 evaluates whether `VACUUM INTO` at seal time is worthwhile.

### 2.6 Phase 2 compression (`.sqlz`)

Ships only if B2 passes it and real volume pushes disk past the cap. Sealed days older than 2 days are cut into 64 KiB chunks, each an independent zstd frame (level 6), followed by a frame table of offset, length and xxh3 per frame, and a checksummed trailer. A read-only VFS serves them with a 4 MiB frame LRU. The sealer reads back every frame, fsyncs, renames `D.sqlz.tmp` to `D.sqlz`, then unlinks `D.sqlite`. `motel export` gives back a plain file.

### 2.7 Evidence file

`evidence.sqlite` uses the same DDL in WAL mode with `synchronous=FULL` (writes are rare). It holds crash, profile, inspect, run and failed-test rows, their sources' cursors, the purge log and artifacts. Expiry deletes rows past 180 days in batches of 1,000, then `incremental_vacuum`.

## 3. Write path

### 3.1 Admission and queue

| Limit | Value | Over it |
|---|---|---|
| Request wire size | 2 MiB | 413 |
| Decompressed size | 6 MiB, checked while streaming | 413 |
| Records per request | 20,000 | 413 |
| Attributes per record, depth | 128, 8 | truncated, `motel.truncated=true` |
| Concurrent decoders | 1 (6 MiB reserved) | waits ≤ 100 ms, then 503 |
| Queue | 4 MiB of normalized rows, reserved before enqueue | 429 + `Retry-After: 1` |

Decode, normalize, redact and intern, then reserve queue bytes and `try_send((rows, ack_tx))`. Tailers wait instead of failing; their cursors don't advance, so nothing is lost.

### 3.2 Writer and group commit

One OS thread owns the only write connection to the hot file and to `evidence.sqlite`. It commits when the oldest row in the transaction is **50 ms** old, or at **2,048 rows** or **1 MiB** (100 ms is an alternative evaluated by B4). Each transaction is `BEGIN IMMEDIATE`, insert rows, upsert resources, update cursors and `_meta`, `COMMIT`, with no network waits inside.

A separate **checkpointer connection** runs `PASSIVE` every second once the WAL passes 4 MiB (or immediately per 8 MiB of burst growth) and `TRUNCATE` under the writer's transaction lock at 32 MiB. No timer runs at idle. To enforce the **64 MiB hard WAL cap** (`wal_hard_cap_bytes`) under sustained bursts or long-lived readers, the writer checks `.hot.sqlite-wal` between transactions: if the WAL reaches the hard trigger threshold (52 MiB for a 64 MiB cap), the writer stops draining the 4 MiB ingest queue (causing queue backpressure → 429s for HTTP callers and blocking for tailers) and runs `PASSIVE` + `TRUNCATE` between transactions, waiting up to the reader progress-handler deadline (`query_deadline`) if an active reader holds an older WAL snapshot.

### 3.3 Acknowledgement and durability

A request gets its 200 only after all its rows commit. A retry after a partial commit can duplicate rows; OTLP is at-least-once, and `trace` drops duplicates by `span_id`.

| | **Mode T (default)** | **Mode F** |
|---|---|---|
| Per commit | `synchronous=NORMAL`: WAL written, not synced | `synchronous=FULL`: WAL `F_FULLFSYNC` |
| Durability tick | On the **writer thread**: the first commit ≥ 1 s after the last durable one runs FULL; if the file is dirty and idle, a heartbeat commit (`_meta.durable_ingest_ts`) runs FULL. No side file descriptor, so no race with WAL resets | none |
| A 200 means | survives `kill -9`; durable within about 1 s | durable on media |
| Panic or power loss | loses rows after `durable_ingest_ts`, about 1 s, shown in `status` | loses nothing acknowledged |
| Cost | ≤ 1 full flush per second | one per commit (≤ 20/s) |

Both are consistent after power loss: WAL frames are checksummed and chained, and `checkpoint_fullfsync` orders the database writes. **B4 decides** (§8).

### 3.4 Cursors, dedupe and recovery

- **Cursors live in the file their rows go to**, because a transaction across attached WAL files is not atomic. At startup a tailer takes the cursor with the newest `updated_ingest_ts` across today's and yesterday's files. That gives exactly-once tailing with no fingerprint index.
- Unified-log backfill dedupes against a 64k-entry xxh3 ring in memory.
- **Startup:** take `motel.lock`; delete `*.tmp` and empty `trash/`; resume the seal of any hot file older than today (every step is idempotent); if both `D.sqlite` and `D.sqlz` exist keep `D.sqlz`, which was renamed only after verification; open today's hot file, which replays the WAL; resume pending purges; start ingest.
- A file that fails `quick_check` with corruption is quarantined and reported; ingest never waits on it.

## 4. Read path

A catalog holds `(file, state, min_ts, max_ts, max_ingest_ts)`. Reads use a pool of **2 connections**, closed after 60 s idle, with a progress handler (2 s default deadline, 10 s max), a 1,000-row and 1 MiB output cap, and an authorizer that denies writes, `ATTACH`, `PRAGMA` writes and unlisted functions.

**Merge rule:** visit files in descending `max_ts`; stop once K rows are collected and the next file's `max_ts` is older than the K-th row's `ts`.

```sql
-- why: recent errors for a service (24 h, walks back to 14 d until K)
select id, ts, kind, service, name, substr(body,1,300) body, trace_id, artifact
from events where err = 1 and service = ?svc and ts between ?w0 and ?w1
order by ts desc limit ?k;                                  -- ix_err

-- trace (14 d plus evidence; merge by ts, dedupe by span_id)
select * from events where trace_id = ?tid order by ts;     -- ix_trace

-- around a timestamp (±2 min), optionally by service
select ... from events where ts between ?t0 and ?t1 [and service = ?svc]
order by ts limit 1000;                                     -- ix_ts / ix_svc_ts

-- substring (24 h), newest arrival first; with block_bloom, add id ranges
select ... from events where ts between ?w0 and ?w1 [and service = ?svc]
  and instr(body, ?needle) > 0 order by id desc limit 50;

-- session or request (14 d)
select ... from events where session_id = ?sid order by ts desc limit ?k;  -- ix_session

-- unpromoted attribute (24 h)
select ... from events where ts between ?w0 and ?w1 and attr(attrs, ?key) = ?val;
```

Indexed calls are sub-millisecond to a few milliseconds p95 per 1M-row file, so ≤ 10 ms over 14 files. An absent substring reads every body (150 to 300 ms per million rows); an unpromoted attribute is 100 to 200 ms per day.

**Ad-hoc SQL** attaches the files in the window (24 h default, at most 30 days, plus `evidence`) under a `temp view events` that is a `UNION ALL` with the window inside each branch.

**`forget`:** write a `purges` row; pause readers on the affected files; in the hot file `DELETE` with `secure_delete=ON` and checkpoint `TRUNCATE`; in each sealed file `DELETE`, `VACUUM INTO` a tmp, fsync and rename over the original (a `.sqlz` is rebuilt the same way); delete owned artifacts, clear caches and mark the purge done. It resumes at startup. It can't reach SSD remnants, snapshots or apps' own logs.

**CLI with no daemon:** the same query code in-process. Sealed files open `immutable=1`; hot files `mode=ro`, which works when `-shm` and `-wal` exist or the directory is writable. It retries `SQLITE_BUSY` three times, never writes or checkpoints, and reports staleness from `max_ingest_ts`.

## 5. Memory budget

The ceiling is 50,000,000 bytes of `phys_footprint`.

| Item | Idle | Worst | Basis |
|---|---|---|---|
| Code, runtime, 4 thread stacks | 8 MiB | 8 MiB | est. |
| Writer page cache (`shrink_memory` at 30 s idle) | ≤ 1 MiB | 8 MiB | est., cap |
| Readers: 2 × 2 MiB + 0.25 MiB per attached file | 0 | 8 MiB | est., cap |
| Other SQLite (schemas, statements, sorter) | 1 MiB | 2 MiB | est. |
| Decoder reservation | 0 | 6 MiB | cap |
| Queue | 0 | 4 MiB | cap |
| Active batch | 0 | 2 MiB | cap |
| Response buffers | 0 | 2 MiB | cap |
| Catalog, resource LRU, dedupe ring | 1 MiB | 1 MiB | est. |
| Phase 2 frame LRU | 0 | 4 MiB | cap |
| **Total** | **≈ 11 MiB** | **≈ 41 to 45 MiB** | est. |

## 6. Crates and modules

- Storage and HTTP: `rusqlite` 0.41 (`bundled`, `functions`, `hooks`, `limits`), `libsqlite3-sys` for the VFS, `tokio` (current-thread), `hyper` 1.
- OTLP: `prost` with `opentelemetry-proto` messages, or vendored `.proto` files.
- Utilities: `serde_json`, `zstd`, `xxhash-rust`, `rustix`, `crossbeam-channel`, `notify`, `memchr`, `clap`.

No DuckDB, DataFusion, Arrow, tantivy or external KV store.

## 7. Alternatives not selected

| Option | Why not | Revisit if |
|---|---|---|
| Custom PAX segments | Requires owning atomic publication across three files, three read paths, permanent format versions and an index-less virtual table; 2 KB trigram filters saturate, and trickle traffic makes small blocks | SQLite fails a B1 or B2 gate that a PAX prototype passes under the same oracle and B3 |
| DuckDB | Exceeds memory cap (219 to 731 MiB) and locks out other readers | Holds a cap under 40 MB in a measured run; until then only `motel export --parquet` |
| LSM (fjall, RocksDB), redb | No SQL; requires custom secondary indexes, compaction and tombstones; redb has the same random-write cost | B1's slope fails after ablations and hourly hot files |
| tantivy | Token search, not substring; resident memory and background merges | Ranked full-text search is needed beyond 14 days |
| FTS5 | High ingest CPU overhead (237 CPU-s per 100k with attribute fan-out); a trigram index is 2 to 3× the text | 7-day absent substring must be < 100 ms and `block_bloom` fails B2; then trigram FTS5 on sealed days only |

## 8. Benchmark suite

All Rust release builds run on dedicated benchmark hardware with five runs alternating variants and raw JSON retained. The **fixture** uses a deterministic linear congruential generator (`s = (s * 1664525 + 1013904223) mod 2^32`, seed `12345`): half spans and half logs in 500-row batches, 5 services (`api`, `worker`, `web`, `db-proxy`, `scheduler`), 10 spans per trace, 2,000 sessions, request IDs on 20% of rows, 4 to 9 attributes, ~200 B average bodies (1% at 16 KiB), 4% errors (3% error spans, 5% ERROR logs), 5% of timestamps a day late, and the substring needle `display link` in 0.05% of bodies.

**B1: ingest slope and bursts.**
- **Workload:** 5M rows into one hot file through the real admission and writer path: 60/s steady, then bursts at 50k/s. Variants: Mode T/F, wide vs `payloads` split, with and without `ix_req`, 4 vs 8 KiB pages.
- **Metrics:** CPU-s per 100k for the first and last 500k (decode, insert, checkpoint split out), steady CPU, ack p99, 429s, queue and WAL peaks, bytes per million, footprint at peak and after idle.
- **Pass:** ≤ 1.0 CPU-s per 100k; last/first ≤ 1.5; steady < 1% of a core; zero 429s; ack p99 ≤ 250 ms; footprint ≤ 40 MB peak, ≤ 20 MB idle; ≤ 380 MiB per million.
- **Fail:** ratio > 2.0, > 1.5 CPU-s per 100k, or footprint > 50 MB.
- **Switch to:** hourly hot files merged at seal (slope); drop `ix_req` or write JSONB directly (CPU); LSM or PAX only if every variant fails.

**B2: 14-day replay with an oracle.**
- **Workload:** 13 sealed days of 1M rows, each built in place, with `VACUUM INTO`, and as `.sqlz`, each with and without `block_bloom`, plus a hot day ingesting with B1's bursts. Ten queries a second across errors, trace (half absent), around, session, request, and present and absent substring; plus 7-day substring, a 7-day `group by`, an unpromoted attribute and an unbounded sort. Every result is checked against an in-memory oracle, late events included. Cold and warm.
- **Pass:** zero wrong results; indexed p95 ≤ 10 ms warm, ≤ 150 ms cold; 24 h substring ≤ 50 ms present, ≤ 300 ms absent; 7-day absent ≤ 2 s; the unbounded sort stops within 50 ms of its deadline and the writer never sees NOMEM; ingest drops ≤ 20% and commit p99 ≤ 50 ms under queries; footprint ≤ 50 MB peak, ≤ 25 MB idle. `.sqlz` ships at ≤ 40% of plain size with trace p95 ≤ 10 ms; `block_bloom` at ≥ 3× faster absent substring for ≤ 5% disk; `VACUUM INTO` at ≥ 10% disk or ≥ 20% scan saved.
- **Fail:** any wrong result, indexed p95 > 50 ms, or footprint > 50 MB.
- **Switch to:** more promoted columns, then `block_bloom`, then trigram FTS5 on sealed days; PAX only if SQLite fails a gate.

**B3: crash and durability.**
- **Workload:** (a) a VFS shim records every write, truncate, sync and rename, and replays 10,000 seeded schedules that drop or reorder unsynced writes and tear sector writes during commit, checkpoint, WAL reset, each seal step, `.sqlz` publication, `forget` and expiry; the CLI reopens read-only first, then the daemon. (b) 200 `kill -9` runs at 20k rows/s: 100 random, 50 at seal steps through a test hook, 50 during `forget`. (c) 50 forced VM stops, 25 per mode; if a VM can't be force-stopped, (a) stands in and the report says so.
- **Pass:** zero `integrity_check` failures; `kill -9` loses no acknowledged row; VM stop loses none in Mode F, and in Mode T ≤ 1.0 s p95, ≤ 1.5 s worst, never past `durable_ingest_ts`; no day lost or duplicated by a seal; no finished purge returns; ready in ≤ 500 ms with a WAL ≤ 64 MiB.
- **Switch to:** any integrity failure stops the project until fixed. Mode T over its bound makes Mode F the default. A failure inside SQLite with correct pragmas means rollback-journal hot files and a bug report.

**B4: the cost of durability.**
- **Workload:** Mode T vs F at 50 ms and 100 ms commits, 60/s for 10 minutes then ten 50k/s bursts, beside a victim process that writes 4 KiB and fsyncs every 10 ms (baselined alone first).
- **Metrics:** `F_FULLFSYNC` p50 and p99, commits per second, ack p99, burst throughput, writer CPU, the victim's p99 against baseline.
- **Decision:** Mode F becomes the default if it sustains 50k/s with zero 429s, ack p99 ≤ 250 ms, full-sync p99 ≤ 15 ms and the victim ≤ 20% slower; otherwise Mode T. Take the shortest commit interval that passes.

## 9. Open design choices

| Choice | Default | Decided by |
|---|---|---|
| Full sync per commit vs NORMAL plus a 1 s durable commit on the writer thread | Mode T | B4; B3(c) checks the loss bound |
| 50 ms vs 100 ms group commit window | 50 ms | B4 |
| Wide `events` vs a `payloads(id, body, attrs)` split | wide | B1 and B2: split if narrow scans are ≥ 2× faster for ≤ 10% ingest cost |
| `block_bloom`: 2 KB per 2,048 rows from the writer vs ~10 bits per distinct trigram built at seal | not built | B2 |
| Seal in place vs `VACUUM INTO` | in place | B2 |
| Hard SQLite heap limit covering the writer vs soft only | soft 18, hard 28 MiB, writer retries after closing readers | B2's unbounded sort: the writer must never fail a batch |
| Phase 2 `.sqlz` compression | off | B2, then real volume against the 2 GiB cap |
