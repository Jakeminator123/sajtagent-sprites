# Private Agent Turn Ingress V1

Status: locally implemented and verified; not pushed or deployed.

This is the private server-to-server touchdown between `sajtagent-site` and
the Sprite runtime. It is not a browser API and it does not replace the
Site-owned product transport in `docs/agent-session-v1.md`.

## Request

```text
POST /v1/agent-turns
content-type: application/json
x-siteagent-timestamp: <ISO-8601 timestamp>
x-siteagent-nonce: <16-160 safe characters>
x-siteagent-signature: <lowercase HMAC-SHA256 hex>
```

The HMAC payload is the existing `siteagent-runtime-v1` canonical string:
timestamp, nonce, uppercase method, pathname and the SHA-256 digest of the
exact request body. Timestamp skew is at most five minutes and a nonce cannot
be replayed during its ten-minute in-memory retention window. The maximum HTTP
body is 512 KiB.

The strict JSON body is:

```ts
{
  schemaVersion: 1
  session: AgentSessionV1
  turn: AgentTurnRequestV1
  policy: AgentTurnPolicyV1
  baseSequence: number
}
```

Runtime revalidates the session, turn, project, active base revision, selected
UI revision and policy bindings. Policy TTL is at most 15 minutes. Only one
turn may run for a Site session at a time. Idempotency keys are retained in
memory for 24 hours: the same body returns
`agent_turn_already_started_use_site_resume`; a different body with the same
key returns `agent_turn_idempotency_conflict`.

The current checkpoint advertises and accepts only
`conversation.respond` with `maxToolCalls: 0`. Project reads, checks,
`build.request`, question resume and all mutations fail with HTTP 409 before
an OpenClaw run starts. OpenClaw receives an explicit inherited wildcard deny
(`deny: ["*"]`) plus `read-only` permission mode for this slice. An empty
allow/deny pair is not used because OpenClaw interprets that as no inherited
restriction.

## Response stream

A valid accepted request returns:

```text
HTTP 200
content-type: text/event-stream; charset=utf-8
cache-control: no-store
x-accel-buffering: no

id: <AgentEventV1.sequence>
event: <AgentEventV1.type>
data: <one complete AgentEventV1 JSON object>

```

The first frame is always `turn.accepted`. Runtime starts at
`baseSequence + 1`, emits consecutive values, and terminates with exactly one
`turn.completed` or `turn.failed`. Event IDs are deterministic for turn,
sequence and type. Site remains authoritative: it validates and persists the
events and owns the session-global sequence.

The SSE transport permits at most 4,096 events and 4 MiB of framed event data
per turn, with at most 32 KiB per framed event. Runtime reserves 64 KiB and one
event slot for a terminal failure, so exceeding a non-terminal limit can still
close the stream with a valid `turn.failed`. The policy deadline limits the
stream to at most 15 minutes.

There is deliberately no Runtime GET/resume endpoint. Browser reconnect and
`GET /sessions/{sessionId}/events?afterSequence=N` belong to Site because
Runtime does not own or persist the product event history. A duplicate POST is
therefore told to use Site resume rather than pretending Runtime can replay it.

## OpenClaw mapping

The runtime derives a private session key from SHA-256 of the bound project ID
and high-entropy Site session ID, adopts that exact existing OpenClaw session
on later turns, and creates it only when missing. Neither the browser nor Site receives that key. It advertises
OpenClaw's `session-scoped-events` and `tool-events` client capabilities and
normalizes only documented Gateway families:

- `agent` + `stream: assistant` -> append-only `message.delta`;
- `agent` + `stream: lifecycle` -> safe status or terminal failure;
- `agent` + `stream: tool` -> typed tool events only when the policy grants the
  exact semantic capability;
- `question.requested` -> non-secret structured question fields only.

Unknown streams are ignored. Unsupported replacement text, secret questions,
and ungranted tools fail closed. Runtime never emits `preview.ready`; only Site
may do that after acceptance and persistence.

OpenClaw model selection is server-owned. Small direct questions use Luna with
thinking off, routine conversation uses Terra with low or medium thinking, and
analyzed/audit/template or large-budget conversation uses Sol with high or
xhigh thinking. Reasoning visibility stays off on every route.

## Health contract

`GET /health` adds these explicit fields:

```json
{
  "agentSessionContractVersion": 1,
  "agentTurnStreamTransport": "sse",
  "agentTurnStreamEnabled": true,
  "agentTurnCapabilities": ["conversation.respond"],
  "artifactReadEnabled": false
}
```

`agentTurnStreamEnabled` is true only when HMAC signing is configured and the
turn runner can connect to OpenClaw. `artifactReadEnabled` remains false until
a separate artifact-byte protocol is implemented, reviewed and verified.

## Verification

```powershell
npm run check:runtime
```

The focused verification covers HMAC rejection, nonce replay, SSE framing,
contract parsing, sequence continuation, duplicate-turn behavior, health
capabilities, Luna/Terra/Sol routing, assistant/lifecycle normalization and
fail-closed unauthorized tool events.
