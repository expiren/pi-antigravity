# pi-antigravity

[![npm version](https://img.shields.io/npm/v/@gwylook/pi-antigravity.svg)](https://www.npmjs.com/package/@gwylook/pi-antigravity)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**pi-antigravity** is an enhanced [Pi Coding Agent](https://pi.dev) provider for Google Antigravity / Cloud Code Assist models (Gemini, Claude, and GPT-OSS) featuring native Google Grounding search tools, seamless multi-account auto-failover, and direct OAuth authentication.

> **Fork & Enhancements:** Maintained by [@hyperlook](https://github.com/hyperlook/pi-antigravity), upstream base by [Rahul Arya](https://github.com/Rahularya01/pi-antigravity). Includes provider-native `web_search` and `url_context` agent tools, automatic multi-account rotation on 429 quota limits, and compatibility with the latest Pi API.

> **Unofficial integration.** This project is not affiliated with or endorsed by Google. Use it only with an account and services you are authorized to access, and review its source before granting OAuth permissions.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Authentication and credential safety](#authentication-and-credential-safety)
- [Commands](#commands)
- [File attachments](#file-attachments)
- [Models and routing](#models-and-routing)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- Pi Coding Agent and Pi AI version **1.0.0 or later**
- A Google account that can use the relevant Cloud Code Assist / Antigravity services
- A browser to complete the Google sign-in. Same-machine is best (the browser hits the local callback automatically); on a remote/headless machine, complete sign-in anywhere and paste the resulting callback URL back into Pi (see [Troubleshooting](#troubleshooting)).

## Install

Install the package via npm (recommended):

```bash
pi install npm:@gwylook/pi-antigravity
```

To install or lock to a specific version (e.g. matching Pi 1.0.x):

```bash
pi install npm:@gwylook/pi-antigravity@^1.0.0
```

Restart Pi (or run `/reload`) after installation. To update later:

```bash
pi update npm:@gwylook/pi-antigravity
```

### Upgrading to 1.0

1.0 requires Pi **1.0.0 or later**. If you are still on Pi 0.87, stay on `@gwylook/pi-antigravity@^0.87.0` — the peer dependency floor makes 1.0 unresolvable on older Pi.

The extension API also changed in one place:

| Removed in 1.0                      | Use instead                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateAntigravityImage(options)` | `requestAntigravityImage` (one model, no file IO, returns a result) + `saveGeneratedImages`, or the Pi 1.0 `generateImages` provider operation |

No bundled command used the removed helper, so this only affects custom code that imported it from the extension API.

<details>
<summary>Alternative: Install from GitHub source</summary>

```bash
pi install git:github.com/hyperlook/pi-antigravity
```

</details>

## Quick start

1. Start Pi and run `/login antigravity`.
2. Complete Google sign-in in your browser.
3. Select a model, for example:

   ```text
   /model antigravity/gemini-3.8-flash
   ```

4. Start working. If a request fails, run `/antigravity doctor` for sanitized diagnostics.

To link another account without losing the existing one, run `/login antigravity`
again and complete Google sign-in with the other account. Manage and switch accounts with:

```text
/antigravity
```

`/antigravity` opens a multi-tab, zero-latency interactive Control Center (`Tab` / `Shift+Tab`, `←`/`→`, or `1`–`4` to switch tabs):

- **`[1 账号]` Accounts & Quotas:** Opens immediately with progressive quota loading. Shows two-row barcode sparklines (`▰▰▰▰▱`) per account for Gemini and Claude/GPT pools across 5h and weekly windows. Press `Enter` to switch account, `r` to refresh quotas, `d` then `y` to unlink.
- **`[2 模型]` Models & Catalog Sync:** Displays available runtime models with quota bars, reset countdowns, and capability tags. Models and their per-model quota appear as soon as the first endpoint responds; slower endpoints fill in additional models without waiting for subscription or aggregate-quota RPCs. Listing and Pi catalog refresh share concurrent requests. Press `r` or `Enter` to sync/refresh the dynamic model catalog into Pi, or `a` to toggle internal `tab_`/`chat_` models.
- **`[3 工具]` Tool Activation Management:** View and toggle built-in agent tools (`web_search`, `url_context`, `generate_image`, `analyze_file`). Press `Space`/`Enter` to toggle individual tools or `a` to toggle all. Changes take effect immediately in the current session and persist in `~/.pi/agent/pi-antigravity.json`.
- **`[4 诊断]` Diagnostics (Doctor):** Inspect sanitized provider diagnostics, active account/tool state, endpoint status, latency, and resolved runtime model.

Account credentials and quota are loaded on demand when visiting Accounts or Models; Tools and Diagnostics do not trigger those network calls. Auxiliary account RPCs have a five-second total timeout per fallback chain, and subscription-required quota errors are not retried across endpoints.

Outside the terminal UI, the same command prints the dashboard. If a dialog UI is available, it then opens a selector to switch.

On a hard quota wall (HTTP 429 with a reset hint), the provider automatically tries the next linked account.

## Authentication and credential safety

The provider uses the OAuth 2.0 Authorization Code flow with PKCE, so credentials are only ever exchanged with Google — never typed into Pi.

1. `/login antigravity` opens Google sign-in and starts a temporary callback listener at `http://localhost:51121/oauth-callback`.
2. After you approve access, Pi exchanges the callback code for tokens and stores the provider credentials in Pi's auth store (normally `~/.pi/agent/auth.json`).
3. Pi refreshes access tokens automatically when they expire — you shouldn't need to sign in again unless a token is revoked.
4. Successful logins and token rotations are also kept alongside tool preferences in `~/.pi/agent/pi-antigravity.json` with owner-only (`0600`) permissions so linked accounts can be switched without re-authenticating. An existing `antigravity-accounts.json` is automatically merged into this store and removed only after a successful write.

The callback listener binds only to a loopback host, so it isn't reachable from outside your machine. The auth and settings files it writes to contain sensitive access and refresh tokens: **do not commit them, paste them into issues, or share their contents.**

Signing in requests these Google OAuth scopes:

<!-- prettier-ignore -->
| Scope | Why it's needed |
| --- | --- |
| `aicode` | Access to the Cloud Code Assist / Antigravity model catalog and endpoints |
| `cloud-platform` | General Cloud Code Assist API access |
| `userinfo.email`, `userinfo.profile` | Identify the signed-in Google account |
| `cclog` | Cloud Code Assist logging/telemetry endpoints used by the API |
| `experimentsandconfigs` | Server-side experiment and config flags for the API |

Review these permissions before approving access. If your credentials expire or are revoked, just re-run `/login antigravity` to sign in again.

## Commands

<!-- prettier-ignore -->
| Command | Description |
| --- | --- |
| `/login antigravity` | Sign in to Google and configure the provider. |
| `/model antigravity/<model-id>` | Choose a registered Antigravity model. |
| `/antigravity` | Open the multi-tab interactive Control Center (`1 账号` · `2 模型` · `3 工具` · `4 诊断`). Optional subcommands (`models`, `tools`, `doctor`) jump directly to that tab in TUI mode or print text reports in headless mode. |
| `/file <path> [question]` | Mount one local file for Antigravity Gemini; optionally send a question immediately. |
| `/file status` / `/file clear` | Inspect or detach the current file attachment. |

Model availability, entitlement, quota groups, and resets are returned by the service and can differ by account. The quota percentage shown for a model can represent a shared pool, not a private per-model allowance.

### Built-in Agent Tools

The extension registers four built-in tools for Pi agents out of the box with **zero configuration**:

- **`generate_image`**: Generates images via Gemini image models and saves them inside the project directory (default `.pi/generated-images/`). The same models are also registered as Pi 1.0 image models (`antigravity/gemini-3-pro-image`, `antigravity/gemini-3.1-flash-image`) for `models.generateImages` when codemode is on. That path can take reference images but does not save files or accept an aspect ratio; use this tool when either matters. Image models stay out of `/model` — Pi lists only chat models there.
- **`web_search`**: Provider-native Google web search with Grounding. Injects byte-safe citations (`[1]`, `[2]`), automatically resolves Google redirect tracking links into canonical URLs, and lists verified sources.
- **`url_context`**: Reads and summarizes public URLs. Features native YouTube multimodal understanding (Gemini processes video streams directly) alongside standard web page extraction.

- **`analyze_file`**: Sends one local PDF, audio, or video to Gemini for task-specific extraction, transcription, questions, or reconstruction code. Takes only `path` and `instruction`; works independently of the main agent's model and does not change `/file` attachments.

Search, URL context, and file analysis default to `gemini-3.8-flash-tiered` using your existing Antigravity OAuth login, without a separate API key. Availability, quotas, and latency depend on the backend.

#### On-demand file analysis

```text
analyze_file({ path: "./recording.wav", instruction: "Return only the installation steps mentioned." })
analyze_file({ path: "./reference.pdf", instruction: "Recreate page 1 as HTML with inline CSS. Return only the code." })
```

Paths resolve against the session working directory and support absolute paths and `~/`.
The tool sends the file as `inlineData` in an isolated ordinary Gemini generation request,
not a dedicated parsing API. Only the requested answer text returns to the main agent;
no chat history, media bytes, or `/file` state are copied into that request or result.
Existing manual attachments keep their original behavior, including repeated transmission.

The request sets `includeThoughts: false` and `thinkingBudget: 0`. As a second layer,
the tool excludes marked thought parts, binary output, tool calls, and protocol metadata, trims outer
whitespace, and unwraps a single whole-answer code fence. It does not heuristically delete prose
or rewrite requested code/data: the instruction and a short internal prompt ask Gemini to omit
preambles and unrelated commentary. Empty, blocked, and interrupted responses fail explicitly;
output limited by tokens or the local 64,000-character budget is marked incomplete.
While waiting, elapsed-time status updates are emitted every five seconds and on endpoint retries,
without exposing partial answers. File validation failures use analysis-specific English messages;
manual `/file` diagnostics are unchanged.

Instructions are limited to 32,000 characters, checked before reading the file.
Local limits are 12 MiB per file, 18 MiB for the complete serialized request, and 180 seconds
for the overall analysis operation. These are safety policies, not backend guarantees. The
model is configurable with `ANTIGRAVITY_ANALYSIS_MODEL`; no automatic model switching is added.
Shared endpoint fallback may resend the file. There is no Files API upload, slicing, transcoding,
or cross-call media/result cache. Images, text files, and Office documents are outside this tool's scope.

Returned timing details report local preparation, request-to-first-answer-text, request duration,
and total analysis duration, starting after credential acquisition. Request timing includes serialization, connection/upload, backend work, and any
endpoint retries; it does **not** independently measure upload, media processing, or generation.
Try short audio/video first: acceptance of each container/codec requires live Antigravity testing.
Transcripts, timestamps, speaker labels, and reconstructed layouts may be approximate; binary assets
and internal model representations are not extracted.

For an opt-in live check using your existing login (the supplied file is sent to Google):

```bash
bun scripts/smoke-analyze-file.ts ./short.wav "Return only the spoken words."
```

Development smoke checks against `daily-cloudcode-pa.googleapis.com` with the default model,
including a rerun with thought output disabled and a zero thinking budget, successfully recognized
speech in a short WAV, the red → blue sequence and speech in a 6-second H.264/AAC MP4, and
requested invoice fields as JSON from a one-page PDF. These small samples establish basic
acceptance, not codec coverage, transcript/timestamp accuracy, or complex-document quality
with thinking disabled. They are not a latency guarantee.

## File attachments

Use `/file` to attach a local file to **Antigravity Gemini** conversations:

```text
/file "./documents/report.pdf" Summarize the key findings.
/file ./recording.wav Transcribe this recording.
/file ./src/index.ts
/file status
/file clear
```

Without a question, mounting does not start a model request; ask your question afterward.
Paths resolve against the session's working directory, support `~/`, and can be single-
or double-quoted when they contain spaces. Tab completion offers supported files and directories.
Pi's `!` / `!!` shell shortcuts are untouched; there is no `!file:` input syntax.

Supported inputs:

- **PDF:** `.pdf`, sent natively as `application/pdf`.
- **Images:** `.png`, `.jpg`, `.jpeg`, `.webp`, `.heic`, `.heif`.
- **Audio:** `.wav`, `.mp3`, `.aif`, `.aiff`, `.aac`, `.m4a` (`audio/mp4`), `.ogg`, `.flac`.
- **Video:** `.mp4`, `.mpeg`, `.mpg`, `.mov`, `.avi`, `.webm`, `.flv`, `.wmv`, `.3gp`.
- **UTF-8 text:** plain text, Markdown, CSV/TSV, JSON/JSONL, XML/HTML, YAML/TOML,
  common source-code/configuration files, Dockerfile and Makefile. Text is included as text,
  not as an image or a binary attachment. Non-UTF-8 and NUL-containing text is rejected.

**Office documents, archives, unknown binary formats, and multiple simultaneous attachments
are not supported.** Mounting another file replaces the active attachment. Media MIME types
follow Gemini's documented formats, but actual acceptance and duration/page/token limits depend
on the Antigravity backend and selected model; not every media format has been live-verified.

The session stores only the absolute path and reference metadata, never the file bytes. The
attachment stays on the first user turn after mounting; if compaction removes that turn, the
extension restores a stable reference turn. Resume, fork, and tree navigation follow the current
branch's attachment state. Deleted/explicitly omitted turns are not automatically resurrected,
except when compaction removed the source turn.

Each successfully injected attachment includes its name and a short model-visible note:
“The file content is included in this request; answer directly from the attachment.”
This does not claim successful backend decoding or restrict tools. Missing files or byte-budget
failures receive an unavailable marker, not a success note.
There is no separate cloud upload/readiness step or fixed parsing delay.

Unchanged file contents are cached locally; changes trigger a fresh read, and missing/invalid
files produce an explicit unavailable marker rather than silently sending stale bytes. **Contents
still travel with every request**: this is not a Files API upload or a server-side cache. Reopening
a session needs the original local file to remain accessible. Only attach files you intend to send
to the model service.

Local safety limits are **12 MiB per native file**, **1 MiB per text file**, and **18 MiB for the
hydrated conversation JSON**, reserving room for the provider envelope/system prompt. These are
local policies, not advertised server limits; large media should be split first. Mounting and
detaching are blocked while the agent is running. On other models/providers, attachments are
paused (not injected); switch back to Antigravity Gemini to resume. A question supplied while
attachments are paused is not submitted.

If you previously loaded the standalone `gemini-pdf.ts` extension, disable/remove it when enabling
this bundled feature. There are no legacy commands or state migrations.

## Models and routing

After you sign in, the provider refreshes its catalog from Antigravity (`fetchAvailableModels`) and groups runtime thinking variants into public Pi model IDs. Newly enabled models — for example a new Gemini Flash generation — become selectable after that refresh without waiting for an extension release. A last-known-good cache is kept for offline/cold start; the static table below is only the conservative fallback and a routing reference.

Use `/antigravity models` to see live availability and quota for your account. Runtime names such as `gemini-3.8-flash-low` / `-medium` / `-high` collapse to `gemini-3.8-flash` with those thinking levels. The conservative static entries remain selectable when an account's authenticated catalog omits them.

### Why Claude and GPT-OSS appear

Antigravity / Cloud Code Assist exposes a multi-provider catalog. Depending on your account, its Google-authenticated API can advertise Google Gemini models alongside Claude models served through Anthropic Vertex and GPT-OSS served through OpenAI Vertex. This extension intentionally exposes those advertised Claude and GPT-OSS models through the single `antigravity` provider; they are not separate Pi providers and do not use a separate Anthropic or OpenAI login.

The backend's display labels do not always match its runtime IDs. For example, `gemini-3.5-flash-extra-low`, `gemini-3.5-flash-low`, and `gemini-3-flash-agent` can be displayed as Gemini 3.5 Flash Low, Medium, and High. All supported models send integer `thinkingBudget` (Gemini 3.8/3.7/3.6: -1/4000/1000/0, Gemini 3.5: 10000/4000/1000/0, Gemini 3.1 Pro: 10001/1001/0, Claude: 1024/0, GPT-OSS: 8192/0) matching the official Antigravity CLI wire format.

<!-- prettier-ignore -->
| Public model ID | Input | Thinking levels shown | Max output tokens | Request routing |
| --- | --- | --- | --- | --- |
| `gemini-3.8-flash` | Text, image | Low, Medium, High | 65,536 | low → `gemini-3.8-flash-low`; medium → `gemini-3.8-flash-medium`; high → `gemini-3.8-flash-high` |
| `gemini-3.7-flash` | Text, image | Low, Medium, High | 65,536 | low → `gemini-3.7-flash-low`; medium → `gemini-3.7-flash-medium`; high → `gemini-3.7-flash-high` |
| `gemini-3.6-flash` | Text, image | Low, Medium, High | 65,536 | low → `gemini-3.6-flash-low`; medium → `gemini-3.6-flash-medium`; high → `gemini-3.6-flash-high` |
| `gemini-3.5-flash` | Text, image | Low, Medium, High | 65,536 | low → `gemini-3.5-flash-extra-low`; medium → `gemini-3.5-flash-low`; high → `gemini-3-flash-agent` |
| `gemini-3.1-pro` | Text, image | Low, High | 65,535 | low → `gemini-3.1-pro-low`; high → `gemini-pro-agent` |
| `claude-sonnet-4-6` | Text, image | High | 64,000 | high → `claude-sonnet-4-6` |
| `claude-opus-4-6` | Text, image | High | 64,000 | high → `claude-opus-4-6-thinking` |
| `gpt-oss-120b` | Text | Medium | 32,768 | medium → `gpt-oss-120b-medium` |

To limit which models Pi cycles through, enable specific entries in `~/.pi/agent/settings.json`:

```json
{
  "models": {
    "antigravity/gemini-3.8-flash": { "enabled": true },
    "antigravity/gemini-3.7-flash": { "enabled": true },
    "antigravity/gemini-3.6-flash": { "enabled": true },
    "antigravity/gemini-3.5-flash": { "enabled": true },
    "antigravity/gemini-3.1-pro": { "enabled": true },
    "antigravity/claude-sonnet-4-6": { "enabled": true }
  }
}
```

## Configuration

All primary environment variables start with `ANTIGRAVITY_`. The legacy `NOAGY_` prefix is also accepted for compatibility.

<!-- prettier-ignore -->
| Variable | Purpose |
| --- | --- |
| `ANTIGRAVITY_BASE_URL` | Override the API base URL. It must be HTTPS, contain no URL credentials, and target an allowed Google APIs host. |
| `ANTIGRAVITY_PROJECT_ID` | Use a specific Cloud Code Assist project ID instead of discovery or the stable account fallback. |
| `ANTIGRAVITY_CALLBACK_HOST` | Bind OAuth callback to `127.0.0.1`, `::1`, or `localhost` only. Defaults to `127.0.0.1`. |
| `ANTIGRAVITY_USER_AGENT` | Override the request user-agent. |
| `ANTIGRAVITY_RUNTIME_MODEL` | Pin requests to a runtime model ID, bypassing discovered/fallback routing. |
| `ANTIGRAVITY_SEARCH_MODEL` | Override the search model ID (defaults to `gemini-3.8-flash-tiered`). |
| `ANTIGRAVITY_ANALYSIS_MODEL` | Gemini runtime model for `analyze_file` (defaults to `gemini-3.8-flash-tiered`), independent of the main agent and search model. |
| `ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS` | Override catalog refresh TTL in ms. Defaults to 4 hours (`14400000`). Set to `0` to always refresh. |
| `ANTIGRAVITY_CLIENT_ID` | Use a custom Google OAuth client ID. |
| `ANTIGRAVITY_CLIENT_SECRET` | Use a custom Google OAuth client secret. Keep it out of source control and shell history. |
| `ANTIGRAVITY_NO_KEEPALIVE` | Set to `1` to skip the keep-alive connection pool. |
| `ANTIGRAVITY_NO_PREWARM` | Set to `1` to skip the TLS pre-warm request made on the first Antigravity request. |

By default, the provider tries `https://daily-cloudcode-pa.googleapis.com`, then the sandbox host, then `https://cloudcode-pa.googleapis.com`. Prefer the built-in OAuth client unless you have a reason to use your own credentials.

### Latency

Provider requests reuse a keep-alive connection pool when the runtime supports it, so consecutive turns do not repeat the DNS, TCP, and TLS handshake. When `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is set, that pool is skipped so Pi's proxy-aware dispatcher is used instead. The connection is opened on the first Antigravity request rather than at Pi startup, so other extensions are not stalled by an unauthenticated handshake. For the lowest time-to-first-token, pick a fast runtime: `gemini-3.8-flash` with reasoning off routes to `gemini-3.8-flash-low` at thinking level `LOW`. Setting `ANTIGRAVITY_PROJECT_ID` also removes the project-discovery round-trip when credentials do not already carry a project ID.

## Troubleshooting

- **No credentials / 401 / 403:** Run `/login antigravity` again, then check `/antigravity doctor`.
- **Remote/headless machine — browser can't reach `localhost:51121`:** The callback binds to loopback only, so a browser on another machine can't hit it. You have two options:
  - **Paste (no extra setup):** Run `/login antigravity`, open the shown URL and complete Google sign-in in _any_ browser. When it redirects to `http://localhost:51121/oauth-callback?…` and fails to load, copy that full URL from the address bar and paste it into the prompt Pi shows. The code is single-use and expires quickly, so paste promptly.
  - **SSH tunnel (reusable):** From the machine with the browser, run `ssh -N -L 51121:127.0.0.1:51121 <user>@<server>` and keep it open, then run `/login antigravity` on the server. The redirect to `localhost:51121` tunnels through to the local callback automatically.
- **OAuth callback will not start:** Ensure port `51121` is free and `ANTIGRAVITY_CALLBACK_HOST` is a permitted loopback address.
- **Model is unavailable:** Run `/antigravity models`; availability is account- and service-dependent.
- **Claude/GPT tool-call schema error:** Upgrade to the latest package release. The provider adapts Pi's JSON Schema tool definitions for the Cloud Code Assist custom-tool bridge.
- **Quota or rate limit:** Run `/antigravity`. A `429` response usually indicates quota or rate limiting; changing models may still draw from the same shared pool.
- **Need a safe diagnostic:** `/antigravity doctor` redacts recognized secrets from its error output. Still review output before sharing it publicly.

## Development

This repo uses [Bun](https://bun.sh) for install, scripts, and CI. The published extension itself runs on Node (Pi's CLI).

```bash
bun install
bun run check
```

The package declares its Pi extension in `package.json` under `pi.extensions`. See the [Pi package documentation](https://pi.dev/docs/latest/packages) for package installation, manifest, and gallery conventions.

## License & Credits

- Upstream base by [Rahul Arya](https://github.com/Rahularya01/pi-antigravity).
- Licensed under [MIT](LICENSE).
