# Sajtagent Sprites — legacy scaffold

This repository is a historical, unimplemented runtime scaffold. It is not an
active runtime repository or deployment target.

## Canonical home

The privileged controller, OpenClaw integration, project-scoped Sprites, tools,
checks, and preview runtime belong in
[`Jakeminator123/sajtagent-site/runtime`](https://github.com/Jakeminator123/sajtagent-site/tree/main/runtime).

The runtime remains a strict server-side trust boundary even though it lives in
the same Git repository as the web product. It must be built and deployed from
its own root and must never expose model-provider, Sprite, OpenClaw, or signing
credentials to the browser or frontend deployment.

No runtime implementation was selected or lost here. Do not add code, secrets,
environment values, or deployments to this repository. Its name-only
environment contract and boundary notes have been consolidated into
`sajtagent-site/runtime`; this repository can be archived after that change is
verified.
