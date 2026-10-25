# Issue: decouple the stream layer and make retry policy explicit

> **Status: implemented.** Landed in `05a5bf6` (`refactor(stream)`) and
> `5acf493` (`refactor(retry)`); the SSE transport was then reworked again in
> 1.0.0 with `streamGenerateContent` as the single Cloud Code transport. Kept as a
> design record — the `src/` line references and metrics below predate both.

> Local issue draft. Follows the structure of `UPSTREAM_DYNAMIC_MODEL_DISCOVERY.md`.
> All line references and metrics below were measured against `src/` at `v0.7.3` and
> can be re-derived with the commands in [Reproducing the measurements](#reproducing-the-measurements).

## Goal

Make the request/transport layer testable in isolation and make quota-429 retry behavior
a first-class, unit-tested decision instead of an 8-level-deep control-flow nest.

After this refactor, adding a new credential strategy (single API key, CI token, proxy-auth)
must not require touching `src/stream/stream.ts`, and "what counts as a hard quota wall"
must be a pure function covered by tests rather than a branch buried at nesting depth 8.

## Problem statement

The layering is sound in direction but overgrown in three specific places. The module
graph has **no circular dependencies** (29 modules, verified), so nothing here requires
overturning the structure. These are local fixes.

### 1. The transport layer knows about accounts (boundary inversion)

```
src/stream/stream.ts:80
  import { failoverToNextAccount } from "../auth/accounts.js";
```

`stream/` is responsible for turning messages into an assistant event stream. It should
not know that Google accounts exist, that a quota wall is account-scoped, or that
credentials rotate. Today that concept leaks one level too deep.

Consequences:

- Supporting a non-OAuth credential mode (API key, CI token) means editing a
  1,653-line transport module.
- `streamAntigravity` is effectively untestable. `scripts/test-stream-sse.ts` imports
  only the pure `streamResponse`; `streamAntigravity` itself is referenced by just two
  files (`src/stream/stream.ts`, `src/index.ts`) and by **zero** tests.

### 2. `streamAntigravity` is a god function

```
src/stream/stream.ts:1429-1653   = 225 lines
  maximum nesting depth            = 8
  if / for / catch                = 25 / 5 / 3
  optional chains + ternaries     = 27
  await                           = 11
```

The shape is three nested loops that encode **three unrelated retry semantics**:

```
for (emptyAttempt 0..2)        // semantic: retry an empty response
  for (candIdx runtimeModels)  // semantic: downgrade the model
    for (endpoint endpoints)   // semantic: drift to another endpoint
      fetch(...)
      if (429) { if (A) break; if (B) break; if (!C && !D && E) break; }   // depth 8
```

Because the three semantics are interleaved, the question "should this failure advance
the endpoint, the model, the account, or retry in place?" is answered by ~25 scattered
`if` statements. The most business-critical of these — the hard-quota-wall classifier at
`stream.ts:1043-1057` and `stream.ts:1510-1520` — is unreachable from a test without
executing the whole request path.

### 3. Request state is scattered across 11 module-level singletons

```
src/client/client.ts:26        projectCache
src/client/client.ts:29        modelCache
src/client/client.ts:36        inFlightModelLookups
src/models/models.ts:332       currentModels
src/models/models.ts:333       currentRouting
src/models/models.ts:452       modelEnumCache
src/diagnostics/diagnostics.ts:21  lastSnapshot
src/utils/http.ts:25           dispatcherPromise
src/utils/http.ts:26           prewarmStarted
src/utils/util.ts:57           sessionTrajectoryMap
src/stream/stream.ts:92        toolCallCounter
```

No module can answer "which state did this request observe?". `/antigravity.doctor`
prints only the **last** diagnostics snapshot, so an inconsistency between caches is
invisible until a user reports a symptom.

### 4. Related: two sources of truth for the active account

```
pi-antigravity.json  <- source of truth (all accounts)
        <->  syncCurrentAuth()   (src/auth/accounts.ts:210)
auth.json                  <- projection Pi reads
```

The projection is written by `writeActiveCredential()` (defined at `accounts.ts:179`) at
four call sites (`:320 :337 :356 :382`) and reconciled by `syncCurrentAuth()` (defined at
`accounts.ts:210`) at six more (`:222 :249 :278 :326 :342 :369`). Two-way reconciliation
always has a drift window, and nothing surfaces drift when it happens. See
[P1-④](#p1--make-authjson-a-one-way-projection) — this is tracked here only because it is
the same class of defect, and it is explicitly **not** in scope for the first stages.

## Scope

Implement, in this order. Each stage is independently reviewable and behavior-preserving.

1. **[P0-①] Introduce a `CredentialSource` interface and invert the dependency.**
   `src/stream/` must no longer import from `src/auth/`. The binding happens in the
   composition root (`src/index.ts`).
2. **[P0-②] Extract the hard-quota-wall classifier and the retry plan as pure,
   testable units.** Replace the three nested loops with a declarative attempt plan
   plus one `shouldTryNextCredential` predicate.
3. **[P2-⑤] Slim the composition root.** Move the TUI component and command handlers
   out of `src/index.ts` so it only describes wiring.
4. **[P1-③] Collect the 11 singletons into one injected state container.**
5. **[P1-④] Make `auth.json` a one-way projection of `pi-antigravity.json`.**

## Non-goals / constraints

- **No user-visible behavior change.** Every stage must ship with `bun run check` green
  and identical observable behavior: same retry counts, same endpoint order, same
  account rotation, same error messages, same `/antigravity.doctor` output shape.
- **Do not change the wire protocol.** Request bodies, SSE parsing, tool schema
  normalization, and `thoughtSignature` handling stay as they are.
- **Do not change the public command surface.** `/antigravity.usage`, `.models`,
  `.refresh`, `.doctor`, `.image`, `.search` and the three tools keep their names,
  descriptions, and argument completion behavior.
- **Do not add a build step.** This package ships TypeScript source and is loaded by
  Pi's `jiti`. The refactor must keep `"main": "./src/index.ts"` and the existing
  `files` whitelist working.
- **Do not touch the `jiti` alias / single-instance contract.** Pi aliases
  `@earendil-works/pi-*` to its own `dist`, so module-level state here is already
  process-scoped to one Pi runtime. This refactor improves reasoning about that state;
  it does not attempt to make the extension reload-safe across `/reload`.
- **Do not introduce a DI container or framework.** The interface is a plain TypeScript
  type with two methods. Construction stays explicit in `src/index.ts`.
- **Do not combine stages in one PR.** Stage 1 and 2 should be separate pull requests
  so the retry-semantics preservation can be reviewed on its own.

## Suggested shape

### P0-① Credential source

```
src/runtime/credentials.ts
  export interface CredentialSource {
    current(): Promise<AntigravityApiKey>;
    /** Call only on a hard quota wall. Returns undefined when exhausted. */
    rotate(excluded: ReadonlySet<string>): Promise<AntigravityApiKey | undefined>;
  }

src/runtime/account-credential-source.ts   // implements it over auth/accounts.ts
src/runtime/single-key-source.ts           // optional: non-OAuth mode, same interface

src/index.ts                                // constructs and injects
```

`src/stream/stream.ts` depends on the interface only. The single existing call site is
`stream.ts:1583` (`failoverToNextAccount(triedAccessTokens)`).

### P0-② Retry plan

```
src/runtime/retry.ts
  export interface Attempt { endpoint: string; runtimeModel: string }

  export function planAttempts(endpoints, models, fallback?): Attempt[]
  export function isHardQuotaWall(status: number, body: string): boolean
  export async function executeWithPolicy<T>(
    attempts: Attempt[],
    policy: {
      attemptsPerKey: number;                       // replaces emptyAttempt 0..2
      backoff: (n: number) => number;              // 500 * 2 ** (n - 1)
      shouldRotate: (r: Outcome) => boolean;       // isHardQuotaWall, pure
    },
    send: (a: Attempt) => Promise<Response>,
  ): Promise<Outcome>
```

Target shape inside `streamAntigravity`:

```ts
const outcome = await executeWithPolicy(
  planAttempts(endpointCandidates(), runtimeCandidates),
  {
    attemptsPerKey: 3,
    backoff: (n) => 500 * 2 ** (n - 1),
    shouldRotate: (r) => isHardQuotaWall(r.status, r.body),
  },
  (attempt) => sendOnce(attempt, ctx),
);
// then the existing SSE consumption path, unchanged
```

Nesting drops from 8 to 2, and the classifier becomes directly testable.

### P2-⑤ Composition root

```
src/index.ts                  ~200 lines: registerProvider + registerCommand + registerTool
src/commands/usage.ts         handleUsageCommand + argument completions
src/commands/models.ts
src/commands/refresh.ts
src/commands/doctor.ts
src/commands/image.ts
src/commands/search.ts
src/ui/dashboard.ts           AntigravityDashboardComponent (currently index.ts:191-354, 164 lines)
```

### P1-③ State container

```
src/runtime/state.ts
  export interface AntigravityState {
    project:    { cache: Map<...> }         // client/projectCache
    models:     { catalog; routing; enums } // models currentModels/currentRouting/modelEnumCache
    diagnostics:{ last: DiagnosticsSnapshot }
    http:       { dispatcher?: unknown; prewarmed: boolean }
  }
```

One instance, created in `src/index.ts`, passed down. Side benefit: `/antigravity.doctor`
can report a consistency view instead of only the last snapshot — specifically whether
the active account in `pi-antigravity.json` matches the projected `auth.json`
entry, which is exactly the drift that problem 4 hides today.

## Acceptance criteria

- **Required:** `src/stream/` contains no `import` from `src/auth/`. Verifiable with
  `grep -rn "from \"../auth" src/stream/` returning nothing.
- **Required:** `streamAntigravity` passes a `CredentialSource`, and at least one test
  exercises account rotation with a fake source returning a scripted sequence such as
  `429 quota` → `200`. Rotation must occur without touching real credential storage.
- **Required:** `isHardQuotaWall` is covered by table-driven tests asserting that
  per-minute/RPM/TPM/QPS rate-limit text is **not** treated as a hard quota wall, while
  `Individual quota reached`, `Resets in …`, and standalone `quota exceeded` /
  `exceeded your` / `daily limit` **are**. This preserves the current semantics at
  `stream.ts:1052-1057` and `stream.ts:1510-1519` exactly.
- **Required:** retry counts are unchanged — 2 empty-response retries with 500ms then
  1s backoff, endpoint candidate order unchanged, runtime model fallback order unchanged.
- **Required:** existing tests still pass unmodified where they do not target moved code:
  `test-stream-sse`, `test-stream-header-deadline`, `test-http-proxy`, `test-accounts`,
  `test-model-routing`, `test-model-discovery`, `test-usage-formatter`, `test-image-gen`,
  `test-search`, `test-transcript-context`. Update only the import paths of tests that
  must follow moved code.
- **Required:** `bun run check` passes (typecheck, lint, format:check, security-check, test).
- **Required:** `/antigravity.doctor` output remains field-for-field compatible; if the
  consistency view is added, it is appended, never substituted.
- **Required:** no new runtime dependency. `undici` stays the only entry in
  `dependencies`; the `peerDependencies` ranges on `@earendil-works/pi-*` are unchanged.
- **Conditional (P1-④ only):** after making `auth.json` a one-way projection, a startup
  where `pi-antigravity.json` names a different active account than `auth.json`
  converges to the accounts file, and this is observable in `/antigravity.doctor`.
  Migration must not discard an account that exists only in `auth.json`.

## Rollout plan

| Stage | Change                  | Risk   | Est. blast radius                                                 |
| ----- | ----------------------- | ------ | ----------------------------------------------------------------- |
| 1     | P0-① CredentialSource   | low    | 1 call site (`stream.ts:1583`) + `src/index.ts` binding           |
| 2     | P0-② Retry plan         | medium | `streamAntigravity` body; guarded by the 10 existing test scripts |
| 3     | P2-⑤ Composition root   | none   | file moves only, no logic edits                                   |
| 4     | P1-③ State container    | medium | 11 singleton sites across 5 modules                               |
| 5     | P1-④ One-way projection | medium | `auth/accounts.ts` + existing-user migration                      |

Stages 1-3 remove the fragility without changing behavior and should land first.
Stage 4 requires `/reload` to be re-verified, since it changes when module state is
constructed. Stage 5 is the only one that touches persisted user data.

## Implementation notes

- Stage 1 and 2 are separable on purpose. The value of stage 1 is that stage 2's
  `shouldRotate` can be tested with a fake credential source rather than real account
  storage, which is what makes stage 2 safe to review.
- The `shouldRotate` predicate must keep the current short-circuit order. Today
  `stream.ts:1510-1520` checks rate-limit text _before_ deciding, and that ordering is
  what keeps a 429 caused by RPM from burning through every linked account.
- `scripts/test-stream-sse.ts` covers `streamResponse` only. Extending coverage to
  `streamAntigravity` requires stage 1 first; do not attempt it before then.
- Module-level state is safe today because Pi loads one extension instance per process
  and aliases `@earendil-works/pi-*` to a single `dist`. Stage 4 should preserve that
  property and must not introduce a per-request global.
- `src/index.ts` currently owns `AntigravityDashboardComponent` (164 lines) plus eight
  handler functions. Stage 3 is a move, not a rewrite; resist reformatting the TUI
  render logic while relocating it.

## Reproducing the measurements

```bash
# problem 1 — transport layer importing the account layer
grep -rn "from \"\.\./auth" src/stream/

# problem 2 — god function size and nesting
sed -n '1429,1653p' src/stream/stream.ts | wc -l          # 225
for k in if for catch; do
  printf '%s: ' "$k"; sed -n '1429,1653p' src/stream/stream.ts | grep -cw "$k"
done

# problem 3 — module-level mutable singletons
grep -rnE "^let [a-zA-Z]|^const [a-zA-Z_]+ *= *new (Map|Set)" src --include='*.ts' \
  | grep -vE "SCHEMA_|META_SCHEMA|CUSTOM_TOOL_SCHEMA|LOOPBACK_HOSTS"

# problem 4 — projection write and reconciliation sites
grep -n "syncCurrentAuth\|writeActiveCredential" src/auth/accounts.ts

# baseline: no circular dependencies
# (import graph walk over src/**/*.ts, 29 modules, 0 cycles)
```

## Open questions

1. Should `CredentialSource.rotate` receive the `Outcome` instead of
   `ReadonlySet<string>`, so a future strategy can distinguish "quota" from
   "revoked/403" rotation? Adding a third mode later is cheaper if the signature is
   right now, but it widens the interface before a second implementation exists.
2. Is stage 5 worth doing at all, or is surfacing drift through a doctor consistency
   view (stage 4) sufficient mitigation for the double source of truth?
3. Should the retry plan become a general `src/runtime/retry.ts` that other private-API
   providers can copy, or stay provider-local? Keeping it local avoids implying a shared
   runtime contract that does not yet exist.
