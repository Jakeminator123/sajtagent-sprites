# Sajtagent Sprites

Separate runtime repository for SiteAgent's privileged building environment.

This repository owns the deployable OpenClaw/Sprites integration bundle:
Sajtagent's agent profile, workspace, skills, plugins, runtime policy adapter,
project-scoped worker environments, and normalized worker evidence.

It does not own SiteAgent's web UI, users, product database, project pages, or
Vercel publication controls. Those belong in `sajtagent-site`.

## Initial boundary

```text
SiteAgent web product
  -> signed and scoped BuildJobV1
  -> thin runtime adapter and Job Policy Compiler
  -> OpenClaw Gateway on a private boundary
  -> isolated worker Sprite for one project
  -> non-authoritative WorkerReportV1
  -> SiteAgent verification and BuildResultV1
```

OpenClaw Gateway owns the upstream agent loop, session queue, run lifecycle,
sandbox, native tools, and upstream tool policy. This repository must not
implement a competing loop. SiteAgent retains product authorization, mandates,
idempotency, verification, persistence, versions, and its replayable event
stream.

## Contract checkpoint

`contracts/builder-v1.ts` freezes the first shared Intent, Job, WorkerReport,
Result, and Event schemas. The same source and fixtures are mirrored in
`sajtagent-site`.

```powershell
npm run check:contracts
```

The command validates positive and negative fixtures, terminal stream ordering,
and focused TypeScript compilation.

## Runtime references

Read [`docs/runtime-and-mcp.md`](docs/runtime-and-mcp.md) before changing
OpenClaw, Sprites, MCP, sandboxing, tool policy, or cloud-resource lifecycle.
The repo-local Codex configuration registers the official hosted Sprites MCP as
an optional developer control plane; it contains no credential and does not
authorize resource creation.

## Local environment

Use the Git-ignored `.env.local` for runtime secrets and `.env.example` as the
tracked name-only contract. Model-provider, Sprite, OpenClaw, and controller
signing credentials belong here and must never be copied into the SiteAgent
frontend or platform control panel.
