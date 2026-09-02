# Sajtagent Build Request plugin

This Runtime-owned OpenClaw plugin registers one optional, parameterless tool:
`siteagent_build_request`.

The tool only signals that OpenClaw selected the Site-authorized
`build.request` handoff. It does not read or write files, use credentials,
create a BuildJob, produce a preview, persist a version, or claim success.

Install and inspect it only as part of the reviewed Runtime rollout:

```bash
npm pack
openclaw plugins install npm-pack:./sajtagent-openclaw-build-request-0.1.0.tgz
openclaw plugins inspect siteagent-build-request --runtime --json
```
