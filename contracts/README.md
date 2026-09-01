# Builder contract v1

This directory is an intentionally mirrored snapshot shared by
`sajtagent-site` and `sajtagent-sprites`. The products remain separate Git
repositories and do not gain a live cross-repo package dependency.

## Contract layers

1. `BuilderIntentV1`: untrusted browser intent without runtime tool names.
2. `BuildJobV1`: server-authorized job and semantic execution policy.
3. `WorkerReportV1`: non-authoritative normalized upstream run evidence.
4. `BuildResultV1`: product-controller verified and persisted result.
5. `BuildEventV1`: replayable browser event with strict sequence ordering.

OpenClaw session, sandbox, MCP, and tool-policy configuration are private
adapter details and never fields in these versioned product contracts.

## Verification

```powershell
npm run check:contracts
```

The verifier checks valid and invalid fixtures, exact terminal stream ordering,
and focused TypeScript compilation. Both repositories must print the same
`contract-fixture-sha256` before either side changes a shared contract.

Change the source and fixtures in both repositories in one coordinated delivery.
Do not treat one repository's newer contract as silently backward compatible.
