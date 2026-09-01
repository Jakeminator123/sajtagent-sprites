# Sprites, OpenClaw, and MCP boundary

Status: accepted runtime baseline, 2026-09-01.

## Runtime adapter and local profile compiler

The runtime has four surfaces: a local profile compiler, a signed
`BuildJobV1` adapter, a signed continuous-agent turn stream for an OpenClaw
Gateway, and a signed private reader for preview bytes authorized by a
candidate report. The exact local-only turn ingress is documented in
[`private-agent-turn-ingress-v1.md`](./private-agent-turn-ingress-v1.md). The
artifact reader is documented in
[`private-artifact-read-v1.md`](./private-artifact-read-v1.md). The
build adapter creates one server-owned detached Git worktree per idempotent job, creates a private
OpenClaw session rooted at that worktree, runs the selected model, and
normalizes the result into a validated `WorkerReportV1`.
When `checks.run` is granted, the adapter independently executes the project's
existing `npm run check` with a scrubbed environment. When `preview.manage` is
granted, a candidate is accepted only when a bounded HTML preview artifact can
be found and hashed.

```powershell
npm ci
npm run check:runtime
npm run dev:runtime
```

The default listener is `http://127.0.0.1:4317`. `GET /health` and local
`POST /v1/agent-profiles/compile` need no credential. `POST /v1/build-jobs`,
`POST /v1/agent-turns`, and `POST /v1/artifacts/read` always need
`SITEAGENT_RUNTIME_SIGNING_KEY` and
validate timestamp, nonce, signature, expiry, idempotency, workspace revision,
and their frozen schemas.
It returns fail-closed typed diagnostics when the Gateway or project checkout
is unavailable. A worker candidate remains non-authoritative until
`sajtagent-site` has verified and persisted it.

The adapter persists its own Ed25519 Gateway client identity beneath
`SITEAGENT_OPENCLAW_CLIENT_STATE_DIR`. Pair that exact local client once with
`openclaw devices list` and `openclaw devices approve`; subsequent connections
reuse the device token without putting it in Git or the project workspace.

The server-owned model router uses Luna with thinking off for small bounded
changes, Terra with low or medium thinking for routine work, and Sol with high
or xhigh thinking for complex planning or high-capability jobs. OpenClaw
reasoning visibility remains off for every route: thinking controls model
compute, while reasoning visibility controls whether reasoning blocks are
shown.

OpenClaw permission modes are compiled fail-closed from semantic capabilities:
read-only jobs use `read-only`, edit-only jobs use `guarded`, and jobs that
explicitly allow commands, checks, or package installation use `workspace`.
Every session records the detached worktree as its canonical session root.
The hard wall-clock deadline is enforced by the adapter. OpenClaw 2026.8 does
not expose per-run hard counters for step, tool-call, token, or cost budgets;
those limits are sent as policy constraints and must not be described as hard
enforcement until upstream receipts can be stopped and counted in-flight.

The verified development Sprite currently has neither Docker nor Podman.
Therefore the live V1 uses the OpenClaw session-root boundary and a secret-free
per-job worktree, but it must not be described as container-sandboxed. Enable a
supported Docker, Podman, SSH, or OpenShell backend before treating arbitrary
mutually untrusted customer code as strongly isolated.

Agent Studio development origins on ports 3000, 3001, and 3147 are allowed by
default. Override them with a comma-separated `SITEAGENT_STUDIO_ORIGINS` value.
Binding outside loopback requires a signing key of at least 32 characters.
The OpenClaw Gateway and this adapter stay on loopback; no browser calls either
service directly.

The compiler emits `SOUL.md`, `AGENTS.md`, `profiles/openclaw.yml`, and a
structured host configuration. These are portable inputs, not proof that the
host granted every requested capability. The effective policy is always the
intersection of the profile request and the server-owned host ceiling.

Materialize the default profile, or an Agent Studio export, into a concrete
OpenClaw workspace with:

```powershell
npm run profile:materialize -- --output <workspace>
npm run profile:materialize -- --output <workspace> --profile <export.json>
```

The command overwrites only the known profile files and never deletes the
target workspace. `.siteagent-profile-v1.json` records the compiled profile,
effective policy, findings, and host configuration without credentials.

## Official sources

- [Sprites remote MCP server](https://docs.sprites.dev/integrations/remote-mcp/)
- [Sprites setup for coding agents](https://fly.io/run-agent-code/)
- [Official Sprites plugin for Codex](https://github.com/superfly/sprites-codex-plugin)
- [OpenClaw agent loop](https://docs.openclaw.ai/agent-loop)
- [OpenClaw sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- [OpenClaw sandbox and tool policy](https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated)

These upstream documents are current operational references, not vendored
runtime code. Recheck them before changing integration details.

## Three separate layers

1. **Upstream runtime:** OpenClaw Gateway owns the serialized agent loop,
   session queues, run lifecycle, sandbox, native tools, and upstream tool
   policy. Sprites provide isolated, persistent Linux environments.
2. **Sajtagent product layer:** the SiteAgent controller owns user and tenant
   authorization, project binding, credits and mandate decisions, idempotency,
   semantic execution policy, acceptance checks, persistence, versions, and
   the replayable product event stream.
3. **Builder UI:** cards emit an untrusted typed intent and render read models.
   They never call OpenClaw, Sprites, MCP, or model tools directly.

Sajtmaskin's local OpenClaw bridge, armed-continuation behavior, mandate
counters, and action envelopes are reference material only. Sajtagent may
selectively implement equivalent product behavior behind its own contracts,
but it must not import, raw-copy, or depend on Sajtmaskin runtime state.

## What this repository owns

This repository is a deployable runtime-integration bundle:

- OpenClaw host configuration and the Sajtagent agent profile;
- workspace bootstrap material, skills, and approved plugins;
- a thin signed Gateway adapter and Job Policy Compiler;
- optional Sajtagent-specific MCP tools that OpenClaw does not already provide;
- normalization of an upstream run into non-authoritative
  `WorkerReportV1`.

It does not implement another agent loop. It does not decide user mandates,
increase capabilities, mint product versions, or emit authoritative success.
The SiteAgent controller compiles a verified `BuildResultV1` only after
acceptance checks and persistence.

## Developer control plane: hosted Sprites MCP

The repository-local [`.codex/config.toml`](../.codex/config.toml) registers
three secret-free documentation servers for standalone child-repo work:

- `openai-docs` for official OpenAI and Codex documentation;
- `openclaw-docs` for official upstream OpenClaw documentation; and
- `context7` for current third-party library documentation.

Documentation MCP output is reference material. It cannot override repository
contracts, authorize cloud actions, or prove runtime behavior.

The same file registers the official hosted Sprites endpoint as
`sprites_developer`:

```text
https://sprites.dev/mcp
```

The endpoint uses browser OAuth. Prefer the restricted consent policy: a
Sajtagent-only name prefix, a small creation cap, and no organization-wide full
access. The checked-in configuration contains no token and creates no Sprite.

This MCP is a developer control plane. It can list and create Sprites, execute
commands, manage services and checkpoints, change network policy, and
permanently destroy Sprites. It is not:

- a browser API;
- the product event stream;
- a product dependency;
- a replacement for the signed SiteAgent-to-runtime job; or
- the MCP surface exposed to the deployed Sajtagent worker.

Codex may also use the official Sprites plugin, which supplies MCP wiring and
Sprite-specific skills. Installing or authenticating that plugin is a local
developer action and does not authorize cloud resource mutation.

## Runtime tool policy

`BuildJobV1.executionPolicy` contains semantic capabilities and limits only.
It must never contain OpenClaw tool names or raw Gateway configuration. The
runtime adapter compiles it fail-closed into one session, workspace, sandbox,
and tool-policy snapshot.

Use OpenClaw native tools for ordinary file reads, writes, patches, command
execution, checks, and browser inspection. Add product MCP tools only when a
real missing capability is demonstrated, such as a typed preview receipt or
package-policy decision.

Tool policy is not a substitute for isolation. An allowed shell can write
wherever its host filesystem permits, so the assigned worker must remain in a
secret-free isolated workspace with an external network allowlist.

## Authorization before cloud use

Documentation and local contract tests do not authorize Sprite actions. Before
the first live integration, the active task must explicitly approve:

- the organization and Sajtagent-only Sprite name prefix;
- maximum Sprite count, expiry, tool-call budget, and spend ceiling;
- create and cleanup behavior;
- checkpoint and restore behavior;
- outbound network and package allowlists;
- private preview exposure and authentication; and
- placement of runtime-only credentials.

Destroy, checkpoint restore, network-policy widening, public exposure, and
full-access OAuth always require explicit confirmation.
