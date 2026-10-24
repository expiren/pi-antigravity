# Bounded silent-stream recovery

Stream generation uses separate header, first-content, and byte-stall deadlines. The
first-content deadline starts after response headers and is disarmed only by
nonempty text, reasoning, or a function call; SSE heartbeats, metadata, and
empty text do not count as generated content.

| Environment variable                          | Default | Scope                                     |
| --------------------------------------------- | ------: | ----------------------------------------- |
| `ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS`        |  180000 | Waiting for response headers              |
| `ANTIGRAVITY_STREAM_FIRST_CONTENT_TIMEOUT_MS` |  120000 | Waiting for the first generated content   |
| `ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS`         |  120000 | Waiting for the next SSE byte             |
| `ANTIGRAVITY_STREAM_MAX_ACCOUNT_CHANGES`      |       3 | Shared request-wide account-change budget |

Timeout values are integer milliseconds; zero disables the relevant deadline.
The account-change budget also covers quota and transient 429 responses. Recovery
uses the credential source to select an eligible, untried identity; it cannot
bypass that source's restrictions. After text, thinking, or a tool call is
emitted, or after caller cancellation, the request is never replayed.
Credential refresh and project resolution are outside the generation deadlines.

`bun scripts/test-stream-recovery.ts` exercises these rules with a manually
advanced clock and mocked provider responses. No account credentials or
provider requests are needed.
