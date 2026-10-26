# motel agent API

Two calls answer most questions an agent has about a running app: `why` lists what went wrong, and `show` explains one thing in depth. `sql` and `schema` are the escape hatch. Every answer ends with `next:`, the commands an agent is most likely to run after it.

The query layer lives in `crates/motel-query`. Storage details are in `docs/engine.md`.

## The call sites

```sh
motel why                                   # every service on this machine, last 24 h
motel why api                               # one service
motel why api --since HEAD~1                # "since my change": NEW = not seen before that commit
motel show e:20261025.8812                  # one event, in context
motel show e:ev.2                           # a crash, run or failed test (long-lived evidence)
motel show 4bf92f3577b34da6a3ce929d0e0e4736 # trace
motel show ses_8f2a91c4                     # session (any session_id value)
motel show g:7f3a19c2                       # an error group from `why`
motel show run:last                         # the last recorded run
motel show run:3                            # a run by id
motel sql "select name, count(*) n from events where service = 'api' and err group by 1 order by n desc"
motel schema
```

Every command takes `--json` (the same data, plus `searched` and `next`). `why` and `sql` take `--since` / `--until`; `why` takes `--limit` (default 10 findings, at most 200).

| Surface | why | show | sql | schema |
|---|---|---|---|---|
| CLI | `motel why [service]` | `motel show <id>` | `motel sql "<select>"` | `motel schema` |
| HTTP | `GET /api/why?service=&since=&until=&limit=` | `GET /api/show/<id>` | `POST /api/sql {query, since, until}` | `GET /api/schema` |
| MCP | `motel_why` | `motel_show` | `motel_sql` (schema in its description) | resource `motel://schema` |

## §1 `why`: ranked findings

`why` returns findings in this order: crashes, then NEW error groups, then failed runs, then recurring error groups. Crashes and runs are newest first; groups are ordered by count, then recency. Each finding has a kind, service, count, first and last time, a one-line summary, and one id to pass to `show`.

- **Crashes** use their event id (`e:ev.<n>`) and **failed runs** their run id (`run:<n>`). Both come from the evidence store, so a flood of ordinary errors can't push them out. Failed tests are listed under their run, not as findings.
- **Error groups** are the other error events, grouped by service, kind, name and normalized message (§8). Their ids look like `g:7f3a19c2`.
- **NEW** means the group did not appear in the baseline: the 7 days before the window start. If the baseline scan runs out of budget before every group is accounted for, the answer sets `baseline_complete: false`, text marks those groups `NEW?`, and a `note:` says so.
- Without a service, `why` covers every service. With a service, it covers that one. An unknown service gets near names and the list of services seen in 14 days.
- The default window is 24 h. With no findings it widens to 3, 7 and then 14 days before saying "nothing".
- `--since` later than `--until` is an error.
- Work per window is bounded: 200,000 error rows, 5,000 distinct groups (further groups are counted but not listed), 2,000 crashes or failed runs, and 400,000 baseline rows. Hitting any bound adds a `note:`.

## §2 `show`: any id, the view picked from its shape

| Id | View |
|---|---|
| 32 hex | Trace: span tree with durations and error marks, logs interleaved, crashes and runs tied to it. At most 5,000 events. |
| 16 hex | The span's trace, focused on that span. A span with no trace id, or whose trace can't be read in time, is shown alone. |
| `e:<YYYYMMDD>.<n>` | One event from the day file of its UTC arrival day, in full: resource (host, version, pid), fields, its group, its trace, and same-service context: the 30 nearest events before it and the 30 after, within ±30 s. |
| `e:ev.<n>` | One event from the evidence store (crash, run, failed test, profile). A crash shows its top frames, breadcrumbs (the same service's events, and pid's when known, in the 2 minutes before) and the 30 s after. |
| `g:<8 hex>` | An error group: count, first and last seen, up to 3 distinct sample messages and up to 5 traces, newest first. Searched in every file on disk. |
| `run:last`, `run:<n>` | Command, exit code, duration, failed tests, and the 10 slowest spans compared with their 7-day p50. Spans come from the run's trace, else its session during the run, else every span during the run. A root span that mirrors the run itself is left out. |
| anything else | A session id, then a request id. Matches show a timeline grouped by trace (newest 1,000 events in 14 days). |

No match says which kinds were looked for and suggests `motel why`. Only error kinds that are grouped get a `g:` id; crashes, runs and failed tests never do.

## §3 `--since` and `--until`

Accepted forms:

- Durations: `2h`, `30m`, `1h30m`, `7d`, `1w`, `500ms`, up to 3,650 days.
- Clock times: `14:02` or `14:02:30`, local. A time later than now means yesterday.
- Dates: `2026-10-25` (local midnight) or any RFC 3339 time.
- `run:last`: the start of the newest run.
- Git refs: resolved to the commit time in the caller's repository. Only the CLI and stdio MCP resolve them; HTTP rejects them and asks for a time. Refs are checked against a conservative character set before git is run.

A value that is both a duration and a plausible abbreviated commit hash (7 or more hex digits, such as `0000100d`) is resolved as a git ref when it resolves, and as a duration otherwise. Longer all-hex values like `123456d` are past the duration cap and are git refs only.

## §4 What every answer says it searched

Text answers end with one line:

```
searched: last 24h (since Oct 24 15:00) · day 2026-10-25 + evidence · host devbox · via daemon · last write 2m ago
```

It names the window, the day files read (or `N days first → last`), whether evidence was read, the host, `via daemon` or `read files directly`, and the age of the newest write. `note:` lines follow: a widened window, a scan bound, an incomplete baseline. Each call has a 5 s time budget. When it stops a file read, the answer sets `truncated: true` and adds `note: hit the time budget before reading every file; the answer may be incomplete`. Probes for a service's last event are not counted as searched.

An empty answer says why: the store is empty, the service is unknown (with near names), or the service is quiet (with its last event time).

## §5 `next`

Every answer ends with 1 to 3 exact commands. Values that need quoting are single-quoted with `'\''` escaping. A `motel sql` suggestion is double-quoted when nothing in it is special inside double quotes, and single-quoted otherwise.

## §6 `sql` and `schema`

`sql` is read-only over a view `events`: a 24 h default window, at most 30 days, 1,000 rows or 1 MiB, and a 2 s deadline. Errors echo the schema. `attr(attrs, 'http.route')` reads one attribute.

`events` carries the resource fields `host`, `version` and `pid` as columns. Resource ids are per file, so there is no `resources` table to join; reading one fails with a pointer to those columns.

`schema` lists the columns with their meanings, the event kinds, the services seen in 7 days, and example queries.

## §7 Output size

Output is plain text sized for an agent's context: bodies and messages are cut to 300 characters in lists, and a `show` is capped at 200 lines, footer included, unless `--full`.

## §8 Error groups

A group's fingerprint is `xxh3_64` of `service`, `kind`, `name` and the normalized message, joined with `\x1f`. Its id is `g:` plus the top 32 bits in hex.

The message is the first 512 characters of the body; if those are blank (spaces, tabs, newlines, carriage returns, form feeds), it is the first of `exception.message`, `error.message`, `exception.type`, `otel.status_description` and `status.message` that is present, with non-string values written as JSON. Every surface computes the message the same way, so an id from `show <trace>` or `show <event>` matches the one from `why`.

Normalization masks quoted values (`<str>`), UUIDs (`<uuid>`), paths (`<path>`, dropping any `:line:col` suffix), hex runs (`<hex>`) and numbers (`<n>`), collapses whitespace, and keeps the first 200 characters.

## What stays hidden

Day files, sealing, the evidence file, the merge rule, how ranking weighs findings, and whether the daemon or the CLI answered beyond the one-line note.

## Not part of this API

- Reporting a running app that has sent no events needs a process list; that belongs to a diagnostics command. For now `why` reports "no events" and the last time any were seen.
- Fan-out across machines comes after packaging.
- Narrower views (`show run:last --slow`, `show <session> --errors`) wait until agents ask for them.
- `motel run`, `motel status`, `motel doctor`, `motel forget` and service installation are separate, non-query commands.
