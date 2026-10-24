# Antigravity V3 persistent quota engine

V3 keeps V2's stream parser, request signing, model routing, deadlines, no-replay rule, and
shared account-change budget. The default account source now creates a private per-request
`PersistentCredentialSource`; legacy `current()`/`rotate()` sources and explicit single-key
sources retain their interfaces.

## State and identity

`antigravity-account-health.json` is created on the first selection/update, beside the account
store in the resolved agent directory. `PI_CODING_AGENT_DIR` remains an explicit override;
otherwise both account and health stores use the host SDK's `getAgentDir()`, including OmO's
configured directory. No account-format migration is performed.

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
