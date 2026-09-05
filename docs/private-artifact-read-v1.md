# Private ArtifactReadV1

Status: ratified Runtime/Site wire contract, 2026-09-01.

ArtifactReadV1 is the narrow private byte transfer between the Site sessions
server and this Runtime. It is part of the authorized build-tool path, not the
continuous conversation stream. The browser never receives this endpoint,
its signing key, a worker path, or a directly usable artifact URL.

## Request

`POST /v1/artifacts/read` accepts strict JSON up to 32 KiB and the same HMAC
headers and canonical signature bytes as the other private Runtime routes:

```json
{
  "schemaVersion": 1,
  "readIdempotencyKey": "artifact-read:...",
  "binding": {
    "tenantId": "tenant:...",
    "projectId": "project:...",
    "jobId": "job:...",
    "baseRevisionId": "revision:...",
    "sourceRunId": "openclaw:...",
    "candidateRevisionId": "revision:sha256:<64 lowercase hex>",
    "reportedAt": "2026-09-01T12:00:00.000Z"
  },
  "artifact": {
    "kind": "preview",
    "ref": "opaque-runtime-reference",
    "mediaType": "text/html",
    "sha256": "64-lowercase-hex"
  },
  "maxBytes": 1048576
}
```

The signature pathname is exactly `/v1/artifacts/read`. Query parameters and
redirects are not part of the contract. `maxBytes` is the Site acceptance
policy and cannot exceed 1 MiB.

Runtime records an in-memory authorization only after its runner returns the
same valid `WorkerCandidateReportV1`. The record binds the tenant, project,
job, base revision, source run, candidate revision, report time, the report's
only preview artifact, and the Runtime-known relative path. Its lifetime ends
at the earlier of job expiry or 24 hours. Missing state after a restart fails
closed.

The opaque ref remains opaque to Site. New build reports map it to the
Runtime-owned `.siteagent-preview.html`, which contains only the deterministic
self-contained rendering derived from the frozen candidate. Runtime keeps
legacy reads for `dist/index.html`, `build/index.html`, and `index.html` so an
in-flight report from the previous runtime revision can still complete. The
caller cannot choose or send a filesystem path.

## Response

A successful read returns `application/json`, `cache-control: no-store`, no
CORS grant, and at most 1,572,864 wire bytes. It repeats the complete request
binding and adds the authorized relative path, exact decoded size, and
canonical base64 bytes:

```json
{
  "schemaVersion": 1,
  "readIdempotencyKey": "artifact-read:...",
  "binding": { "...": "exact request binding" },
  "maxBytes": 1048576,
  "artifact": {
    "kind": "preview",
    "ref": "opaque-runtime-reference",
    "relativePath": ".siteagent-preview.html",
    "mediaType": "text/html",
    "sha256": "64-lowercase-hex",
    "sizeBytes": 1234,
    "encoding": "base64",
    "bytesBase64": "..."
  }
}
```

Before returning bytes, Runtime resolves the real worker root, rejects
symlinks and escapes, caps the file before and after reading, requires fatal
UTF-8 decoding plus an HTML document marker, and recomputes SHA-256. Site then
independently checks the repeated binding, ref, path, media type, size, hash,
UTF-8, and HTML before it materializes a Site-owned preview.

Any missing authorization, binding drift, path problem, changed file, hash
mismatch, or unavailable byte source returns the same bounded `404
artifact_unavailable` response. It never reflects a ref, path, hash, or bytes.
Malformed requests are generic `400`/`413`; reused HMAC nonces are rejected.

`readIdempotencyKey` is retained with the canonical request digest. The same
key and body may safely re-read immutable hash-bound content with a fresh
nonce; the same key with different content returns `409
artifact_read_idempotency_conflict`.

## Health and deployment boundary

`GET /health` advertises `artifactReadContractVersion: 1`.
`artifactReadEnabled` becomes true only when request signing is configured and
the real worker-root reader is available. An authorized artifact record is
still required for every read.

This contract and its local checks do not deploy it, configure a cloud key, or
make the Sprite public. Site must mirror the contract and pass an end-to-end
private server-to-server test before live enablement.
