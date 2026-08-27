# Sajtagent Sprites

Separate runtime repository for SiteAgent's privileged building environment.

This repository will own the narrow controller API, OpenClaw integration,
project-scoped worker Sprites, file and command tools, services, tasks,
checkpoints, deterministic checks, and preview runtime.

It does not own SiteAgent's web UI, users, product database, project pages, or
Vercel publication controls. Those belong in `sajtagent-site`.

## Initial boundary

```text
SiteAgent web product
  -> signed and scoped BuildJob
  -> Sajtagent Sprites controller
  -> OpenClaw on a private boundary
  -> isolated worker Sprite for one project
```

No runtime implementation has been selected yet. Add the first package and
source layout only with the first verified vertical slice, rather than creating
an empty framework in advance.

## Local environment

Use the Git-ignored `.env.local` for runtime secrets and `.env.example` as the
tracked name-only contract. Model-provider, Sprite, OpenClaw, and controller
signing credentials belong here and must never be copied into the SiteAgent
frontend or platform control panel.
