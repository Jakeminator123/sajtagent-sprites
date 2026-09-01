# AgentSession V1

Status: authoritative shared contract. Site transport and persistence are the
next implementation layer; the raw OpenClaw Gateway protocol is not a browser
API.

## Product rule

The chat card talks to one continuous SiteAgent. That same agent can answer a
simple question, inspect the current project, ask a structured follow-up or
request one authorized site build. A build job is a tool action inside the
conversation, not the conversation itself.

```text
Browser chat
  -> Site-owned session + server-owned turn policy
  -> private runtime mapping -> OpenClaw session
     -> answer/read tool: sanitized AgentEventV1
     -> mutation request: exact BuildJobV1
        -> worker receipt -> Site acceptance -> canonical preview.ready
```

The browser never receives the internal OpenClaw session key and never calls
OpenClaw, Sprite or model tools directly.

## Transport touchdown

- `POST /sessions/{sessionId}/turns` starts a turn and fetch-streams its first
  events.
- `GET /sessions/{sessionId}/events?afterSequence=N` resumes persisted events.
- Site owns one strictly increasing sequence for the whole product session.
  Gateway sequence numbers are adapter input only.
- A POST turn stream always starts with `turn.accepted` even when its base
  sequence is greater than zero.
- A GET suffix validates schema, session, event IDs and sequence immediately.
  Causal lifecycle checks run against the persisted prefix plus the suffix.

## Authority

`AgentTurnRequestV1` contains the user's message, selected revision and safe UI
context. It cannot name a tool or grant itself permissions.

Site creates a short-lived `AgentTurnPolicyV1` after authentication and project
binding. Every policy preserves conversation capability. Mutating capabilities
require explicit allowed mutation intents, and policy lifetime is at most 15
minutes.

The executable policy validator binds session, project, active base revision
and turn, enforces the tool-call budget and rejects every ungranted capability
or build intent. An answer-only turn cannot start on an expired policy.

Read-only tools and answers do not create a worktree or `BuildJobV1`. The only
turn-level mutation capability is `build.request`; package installation,
workspace writes and preview generation exist only inside `BuildJobV1`'s
execution policy. When the agent requests a build, Site rechecks mandate,
credits and base revision, then mints one exact job. V1 permits at most one
build per turn.

## Browser-safe events

`AgentEventV1` exposes only these event families:

- turn accepted/completed/failed;
- agent status and message deltas;
- explicit structured `question.requested`;
- sanitized tool start/completion receipts and opaque artifact refs;
- build start and canonical preview ready.

`question.requested` mirrors non-secret OpenClaw `ask_user`: a stable lowercase
question ID, short header, question text, up to four `{ label, description? }`
options, and optional multi-select/other flags. Secret fields fail closed.

Raw command output and upstream receipt summaries are not event fields. Large
bytes live behind high-entropy opaque refs. `preview.ready` contains only the
Site-accepted product result, never a runtime candidate URL.

## Terminal matrix

| Outcome | Required | Forbidden |
| --- | --- | --- |
| `answered` | at least one message delta | question or build |
| `awaiting_user` | one explicit question | build |
| `built` | passed mutation tool, one build and canonical preview | question |
| `no_change` | no mutation result | question, build or preview |
| `turn.failed` | a bounded safe error | any later event in that turn |

This matrix prevents optimistic or contradictory UI states. A worker candidate
can never make the session or preview ready by itself.

## Executable evidence

```powershell
npm run check:agent-session
```

The digest printed by this command must match the mirrored Sprites contract
before either side enables the transport.
