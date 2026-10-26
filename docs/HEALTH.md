# Antigravity V3 persistent quota engine

V3 keeps V2's stream parser, request signing, model routing, deadlines, no-replay rule, and
shared account-change budget. The default account source now creates a private per-request
`PersistentCredentialSource`; legacy `current()`/`rotate()` sources and explicit single-key
sources retain their interfaces.

## State and identity

`antigravity-account-health.json` is created on the first selection/update, beside the account
store in the resolved agent directory. `PI_CODING_AGENT_DIR` remains an explicit override;
otherwise settings, accounts, and health use the host SDK's `getAgentDir()`, including OmO's
configured directory. Reading a V3 `antigravity-accounts.json` store does not migrate or
rewrite it. The first explicit account or tool-setting update copies its version 1 accounts
into private `pi-antigravity.json` alongside tool preferences, retaining stable IDs and
leaving the original file intact. The unified copy is authoritative on subsequent reads;
the health database stays separate and unchanged by this migration.

Schema version 1 records are keyed by SHA-256 of the existing stable account ID, exact resolved
request project, and normalized runtime model. Refreshing access or refresh tokens does not
change the existing account ID. Records contain only closed classification codes, timestamps,
HTTP status, fairness metadata, and explicit project-sharing evidence. They contain no tokens,
full emails, or raw provider responses.

Each normal request reads current state, filters cooldowns and in-flight reservations, and
reserves the least-recently-attempted eligible identity in one locked transaction. Active-account
preference breaks an initial tie; it cannot bypass a cooldown. Runtime-model fallback repeats
selection for the actual fallback model and counts identity changes against V2's existing budget.
No quota preflight or startup sweep is added.

Failures commit before selecting a different account. Success updates only its own scope and
cannot shorten a restriction learned by another request. Normal health changes do not activate
accounts or rewrite `auth.json` or `antigravity-accounts.json`; ordinary credential refresh still
uses the existing account persistence functions.

## Classification

| Observation                                       | State without a valid hint          | Handling                                                             |
| ------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Hard HTTP 429 quota wall                          | `hard_quota`, 15 minutes            | Persist reset/Retry-After when supplied                              |
| Transient HTTP 429                                | `transient_429`, 60 seconds         | Respect valid provider retry/reset hints                             |
| Header/first-content/stall timeout                | `temporary_unavailable`, 30 seconds | Preserve V2's no-replay and budget rules                             |
| HTTP 401/403                                      | `auth_error`, 5 minutes             | Stop the current request without cycling identities                  |
| HTTP 404 or 5xx                                   | Provider/endpoint unavailable       | Preserve bounded V2 endpoint/model fallback; no account-pool cycling |
| Explicit structured global model/endpoint failure | Provider/endpoint unavailable       | Stop without penalizing every account                                |

Valid retry/reset hints receive a one-second guard. The latest valid hint wins. Supported
formats include protobuf `RetryInfo` durations, explicit reset metadata, Retry-After seconds
or HTTP dates, ISO reset dates, and `Resets in`/`Please wait` days/hours/minutes/seconds.
Malformed, negative, ambiguous, overflowing, or more-than-366-day hints are rejected in favor
of finite conservative defaults. A 66-hour hint is preserved rather than truncated.

Project sharing requires a structured `QuotaFailure` subject exactly naming the current
request project. Mentioning a project in prose, a different project subject, or a generic
`RESOURCE_EXHAUSTED` message is not sufficient. There is no guessed cross-model quota grouping.

## Durability and concurrency

Updates acquire an exclusive cross-process lock, re-read and validate current state, write a
unique private temporary file, fsync it, and atomically rename it. A failed transaction or
pre-commit write leaves the previous committed state intact and stops recovery safely.

Windows files have a protected ACL allowing only the current owner, SYSTEM, and Administrators;
the ACL is verified before reading. Unix files require owner-only `0600`, with a user-owned,
non-shared-writable parent. Links, unsafe access, malformed state, future schemas, invalid
timestamps, and oversized state fail closed with actionable errors.

Live lock owners are never displaced just because the lock timestamp expired. A proven-dead
owner can be recovered. An orphaned acquisition/recovery gate or an unreadable partial lock
fails closed: stop all users of that exact store before removing only its orphan lock/gate.
This conservative case requires manual cleanup rather than risking two writers.

Normal credential operations are serialized in FIFO order per canonical store path within
one process. Different stores remain independent. Across processes they retry only transient
`busy` locks and acquisition gates, with a monotonic deadline and 25–75 ms jitter. Required
selection and failure persistence wait up to 60 seconds by default, including time queued
locally; set `ANTIGRAVITY_HEALTH_LOCK_WAIT_MS` to an integer from 0 to 60000 to override it.
Cancellation stops waiting before any transaction callback runs. A successful retry re-reads
the committed state under the lock; callbacks are never replayed after they start. Invalid
or unsafe state is never retried, and a persistent orphan gate remains untouched. Deadline
exhaustion reports `ANTIGRAVITY_HEALTH_BUSY`, a local health error, not an HTTP or quota
response. Direct synchronous store updates still report contention immediately.
On Windows, cross-process contention has also produced `EPERM` at exclusive gate creation.
Only this gate-open error is retried; the gate is never bypassed, and persistent permission
denial exhausts the same bound with guidance to check its directory ACL.

Quota failures must commit their restriction before another account is attempted. A
successful provider response remains successful when only success metadata or reservation
cleanup exhausts a shared 25-second contention deadline (or a shorter configured wait):
release never starts a second full wait after success. An already-started secure transaction
may take longer, so this bounds lock waiting, not total response latency. The omission is
visible in `/antigravity doctor`, and any remaining reservation expires after 30 minutes.
Security, corruption, and I/O errors still surface; no provider retry is triggered by local cleanup.
The host may separately display a generic provider-failure summary because its structured
provider diagnostics do not classify local health errors; the local code remains in the
request error and doctor detail. Set `ANTIGRAVITY_HEALTH_METRICS=1` during isolated
benchmarks to collect in-process timing counters without file paths or state content.

On Windows with synthetic credentials and a private OS-temp store (October 25, 2026),
three rounds per process count passed with zero network attempts:

| Processes | Successful operations | Expected busy probes | Successful wait p95 | Successful wait max |
| --------- | --------------------: | -------------------: | ------------------: | ------------------: |
| 2         |                    22 |                    2 |              1.76 s |              1.76 s |
| 4         |                    40 |                    2 |              3.87 s |              4.07 s |
| 8         |                    76 |                    2 |              8.19 s |              8.55 s |
| 16        |                   148 |                    2 |             16.70 s |             17.55 s |

At 16 processes, cumulative ACL subprocess time was 319.95 s across 1,600 calls
(including intentionally held-lock probes); state reading and validation took 29.45 s,
while serialization, JSON writes, and fsync totaled less than 1 s. Cumulative subprocess
times across workers are not wall-clock elapsed time. The 60-second required wait retains
headroom over the measured successful wait; the shorter optional completion budget may omit
metadata under heavier contention without invalidating delivered provider output.

Reservations expire after 30 minutes and are removed on ordinary completion/failure. A crash
does not permanently reserve an account; a request running longer than the lease may eventually
share its candidate with another request. Store limits are 8 MiB, 10,000 records, and 4,096
reservations. Only expired records unused for more than 90 days are pruned; active cooldowns
are never discarded to make room. Absent/deleted accounts are not inferred from a partial list.

## Read-only visibility

- `/antigravity health [runtime-model]`
- `/antigravity doctor`

These read persisted state without quota requests, credential refresh, account activation, or
health writes. They report `linked`, `known_cooldown`, `unknown`, `recently_successful`,
`auth_error`, `in_flight`, and `next_reset`. Doctor also reports an opaque selected identity,
rotation count, skip reasons, last failure class, and `unknown`/`recent_success` selection basis.
Without an explicit runtime argument, the last actually resolved runtime model is preferred
only when it belongs to the currently selected public model. After a model switch and before
its next request, the selected public model is mapped using the default effort.

Unknown quota is never reported as available. Expired restrictions become unknown/recheck
eligible, not healthy. Recent success means an observed scoped success within 24 hours without
a subsequent failure; it is not a guarantee that another request will have quota. Pool exhaustion
returns the requested runtime model, skip counts, and earliest recorded reset when known.

## Validation and operating limits

Run `bun run typecheck`, `bun run test:recovery`, `bun run test:health`, and
`bun scripts/check-v3-load.mjs` in a clean clone. The tests use simulated
credentials and mocked responses; the load check models 302 linked accounts without
making a provider request or rewriting credentials.

Windows ACL operations use synchronous PowerShell subprocesses; Unix mode enforcement
still needs validation on Unix. A crashed acquisition can leave an ambiguous
`.lock-recovery` gate: stop every writer to that store and inspect the orphan
before removing it. No startup quota preflight or account-store migration is performed.

On Windows, the repository-wide `bun run test` stops at the unchanged
`scripts/test-accounts.ts` POSIX-mode assertion: `statSync` reports `0o666`
for a private file created with `0o600`. Run the targeted suites above
separately; the health-store tests check Windows ACLs directly. With
`core.autocrlf=true`, `bun run format:check` also flags untouched upstream
files, including `.prettierrc.json`, because the checkout uses CRLF endings.
