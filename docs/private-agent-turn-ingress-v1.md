# Private Agent Turn Ingress V1

Status: build-request handoff and its Runtime-owned OpenClaw plugin are
implemented on an isolated Runtime branch; not deployed. The live Runtime must
not advertise this capability until the plugin is installed and enabled and
the Site join has been verified.

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

Runtime accepts either exact `conversation.respond` with `maxToolCalls: 0`, or
the exact capability set `conversation.respond + build.request` with
`maxToolCalls >= 1` and exactly one `allowedMutationIntent`. Project reads,
checks, multiple mutation intents, question resume and all other capability
sets fail with HTTP 409 before an OpenClaw run starts.

Conversation-only turns receive an explicit inherited wildcard deny
(`deny: ["*"]`). Build-capable turns receive an exact allowlist containing
only `siteagent_build_request` and its `build.request` alias. Both modes remain
`read-only`; no file, shell, check or browser tool is granted.

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
`baseSequence + 1` and emits consecutive values. An answered or failed turn
terminates with exactly one `turn.completed` or `turn.failed`.

A build handoff is the one deliberate non-terminal exception. Runtime closes
its SSE stream immediately after this exact last event:

```text
tool.started { capability: "build.request", toolCallId, safeLabel }
```

Runtime best-effort aborts the upstream OpenClaw run after that frame. It does
not mint a BuildJob, emit `build.started` or `tool.completed`, produce a
preview, or claim product success. Site derives the authorized intent from the
singleton `allowedMutationIntent` plus the original signed turn, dispatches
the BuildJob, and appends the remaining authoritative AgentEvents.

Event IDs are deterministic for turn, sequence and type. Site validates and
persists all events and owns the session-global sequence.

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

The runtime derives a private V2 subagent-scoped session key from SHA-256 of
the bound project ID and high-entropy Site session ID, adopts that exact
existing OpenClaw session on later turns, and creates it only when missing.
The child is linked at spawn depth one to a private, read-only Runtime
controller session. OpenClaw requires both that parent lineage and the
subagent scope before it applies inherited per-session tool allow/deny policy.
Neither the browser nor Site receives either key. The OpenClaw label uses the
same digest instead of the project ID, and the V2 namespace prevents legacy
root or unlinked test sessions and their creation-idempotency receipts from
being adopted. Runtime advertises
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

The build transport uses the Runtime-owned plugin in
`openclaw-plugins/siteagent-build-request`. It registers the optional,
parameterless OpenClaw tool `siteagent_build_request`; Runtime normalizes that
name to the semantic `build.request` capability. The tool returns only a
non-authoritative handoff acknowledgement and performs no file, network,
credential, BuildJob, preview or persistence action.

Runtime probes both `plugins.list` and `tools.catalog`. An allowlist cannot make
an unregistered tool callable, so `build.request` is withheld from health and
new build-capable turns fail with HTTP 503 until the plugin is installed,
enabled and visible in the plugin tool catalog.

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
  "agentTurnCapabilities": ["conversation.respond", "build.request"],
  "buildRequestHandoffEnabled": true,
  "artifactReadEnabled": false
}
```

`agentTurnStreamEnabled` is true only when HMAC signing is configured and the
turn runner can connect to OpenClaw. When the plugin probe is not green,
`agentTurnCapabilities` contains only `conversation.respond`,
`buildRequestHandoffEnabled` is false, and a safe reason code may be present.
The Site continuation still has to be verified before rollout.

## Verification

```powershell
npm run check:runtime
```

The focused verification covers HMAC rejection, nonce replay, SSE framing,
contract parsing, sequence continuation, duplicate-turn behavior, health
capabilities, Luna/Terra/Sol routing, assistant/lifecycle normalization and
fail-closed unauthorized tool events.
