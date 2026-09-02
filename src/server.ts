import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

import {
  AgentProfileV1Schema,
  DEFAULT_LOCAL_AGENT_CEILING_V1,
  compilePortableOpenClawBundleV1,
  type AgentHostCeilingV1,
} from "../contracts/agent-profile-v1.ts"
import {
  AGENT_PROFILE_ACTIVATION_CONTRACT_VERSION_V1,
  AGENT_PROFILE_ACTIVATION_PATH_V1,
  AgentProfileActivationRequestV1Schema,
  MAX_AGENT_PROFILE_ACTIVATION_REQUEST_BYTES_V1,
} from "../contracts/agent-profile-activation-v1.ts"
import {
  BuildJobV1Schema,
  WorkerReportV1Schema,
  type BuildJobV1,
  type WorkerReportV1,
} from "../contracts/builder-v1.ts"
import {
  ARTIFACT_READ_CONTRACT_VERSION_V1,
  ARTIFACT_READ_PATH_V1,
  ArtifactReadRequestV1Schema,
  ArtifactReadResponseV1Schema,
  MAX_ARTIFACT_READ_REQUEST_BYTES_V1,
  MAX_ARTIFACT_READ_RESPONSE_BYTES_V1,
  type ArtifactReadBindingV1,
  type ArtifactReadRequestV1,
} from "../contracts/artifact-read-v1.ts"
import {
  OpenClawGatewayBuildJobRunnerV1,
  UNAVAILABLE_BUILD_JOB_RUNNER_V1,
  type BuildJobRunnerV1,
} from "./openclaw-gateway.ts"
import { routeBuildJobModelV1 } from "./model-routing.ts"
import {
  AGENT_TURN_TERMINAL_RESERVE_BYTES_V1,
  MAX_AGENT_EVENT_SSE_BYTES_V1,
  MAX_AGENT_TURN_EVENTS_V1,
  MAX_AGENT_TURN_SSE_BYTES_V1,
  RUNTIME_AGENT_TURN_CAPABILITIES_V1,
  RuntimeAgentTurnIngressV1Schema,
  UNAVAILABLE_AGENT_TURN_RUNNER_V1,
  assertRuntimeAgentTurnSupportedV1,
  createAgentEventEmitterV1,
  formatAgentEventSseV1,
  type AgentTurnRunnerV1,
} from "./agent-turn.ts"
import {
  SIGNATURE_HEADERS_V1,
  verifyRuntimeSignatureV1,
} from "./signing.ts"
import {
  artifactReaderRootAvailableV1,
  parseAuthorizedPreviewRefV1,
  readAuthorizedPreviewArtifactV1,
  type AuthorizedPreviewArtifactV1,
} from "./artifact-reader.ts"
import {
  AgentProfileActivationErrorV1,
  AgentProfileActivatorV1,
} from "./activate-profile.ts"

const MAX_BODY_BYTES = 512 * 1024
const MIN_RUNTIME_SIGNING_KEY_CHARACTERS = 32
const NONCE_RETENTION_MS = 10 * 60_000
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000
const ARTIFACT_AUTHORIZATION_RETENTION_MS = 24 * 60 * 60_000
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3001",
  "http://localhost:3001",
  "http://127.0.0.1:3147",
  "http://localhost:3147",
]

export type RuntimeServerOptions = {
  host: string
  port: number
  signingKey: string | null
  allowedOrigins: string[]
  ceiling: AgentHostCeilingV1
  runner?: BuildJobRunnerV1
  turnRunner?: AgentTurnRunnerV1
  openClawGatewayUrl?: string
  openClawGatewayToken?: string
  projectsRoot?: string
  workersRoot?: string
  openClawClientStateDir?: string
  openClawWorkspaceDir?: string
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

function hasValidRuntimeSigningKey(
  signingKey: string | null | undefined,
): signingKey is string {
  return Boolean(
    signingKey && signingKey.length >= MIN_RUNTIME_SIGNING_KEY_CHARACTERS,
  )
}

function responseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, { ...responseHeaders(), ...extraHeaders })
  response.end(JSON.stringify(value))
}

function safeRuntimeErrorCodeV1(error: unknown): string {
  if (!error || typeof error !== "object") return typeof error
  const record = error as Record<string, unknown>
  if (
    typeof record.code === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(record.code)
  ) {
    return record.code
  }
  if (
    error instanceof Error &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(error.message)
  ) {
    return error.message
  }
  return error instanceof Error ? error.name : "unknown"
}

async function readBody(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      throw new Error("request_too_large")
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function allowedCorsHeaders(
  origin: string | undefined,
  allowedOrigins: string[],
): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return {}
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": [
      "content-type",
      SIGNATURE_HEADERS_V1.timestamp,
      SIGNATURE_HEADERS_V1.nonce,
      SIGNATURE_HEADERS_V1.signature,
    ].join(", "),
    vary: "Origin",
  }
}

export function resolveRuntimeServerOptions(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeServerOptions {
  const host = env.SITEAGENT_RUNTIME_HOST?.trim() || "127.0.0.1"
  const parsedPort = Number.parseInt(env.SITEAGENT_RUNTIME_PORT || "4317", 10)
  const port = Number.isFinite(parsedPort) && parsedPort >= 0 && parsedPort <= 65_535
    ? parsedPort
    : 4317
  const signingKey = env.SITEAGENT_RUNTIME_SIGNING_KEY?.trim() || null
  const allowedOrigins = env.SITEAGENT_STUDIO_ORIGINS
    ? env.SITEAGENT_STUDIO_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS

  if (!isLoopbackHost(host) && !hasValidRuntimeSigningKey(signingKey)) {
    throw new Error(
      "A non-loopback runtime bind requires SITEAGENT_RUNTIME_SIGNING_KEY with at least 32 characters",
    )
  }

  return {
    host,
    port,
    signingKey,
    allowedOrigins,
    ceiling: DEFAULT_LOCAL_AGENT_CEILING_V1,
    openClawGatewayUrl: env.OPENCLAW_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789",
    openClawGatewayToken: env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined,
    projectsRoot: env.SITEAGENT_PROJECTS_ROOT?.trim() || "/workspace/sajtagent-projects",
    workersRoot: env.SITEAGENT_WORKERS_ROOT?.trim() || "/workspace/sajtagent-workers",
    openClawClientStateDir:
      env.SITEAGENT_OPENCLAW_CLIENT_STATE_DIR?.trim() ||
      "/home/sprite/.config/sajtagent/openclaw-client",
    openClawWorkspaceDir:
      env.SITEAGENT_OPENCLAW_WORKSPACE_DIR?.trim() ||
      "/workspace/sajtagent-openclaw/workspace",
  }
}

export function createRuntimeServer(options: RuntimeServerOptions) {
  const usedNonces = new Map<string, number>()
  const runner = options.runner ?? UNAVAILABLE_BUILD_JOB_RUNNER_V1
  const turnRunner = options.turnRunner ?? UNAVAILABLE_AGENT_TURN_RUNNER_V1
  const jobRequests = new Map<
    string,
    { bodyDigest: string; expiresAt: number; report: Promise<WorkerReportV1> }
  >()
  const turnRequests = new Map<
    string,
    { bodyDigest: string; expiresAt: number; sessionId: string }
  >()
  const activeTurnSessions = new Set<string>()
  const artifactAuthorizations = new Map<string, AuthorizedPreviewArtifactV1>()
  const artifactReadRequests = new Map<
    string,
    { bodyDigest: string; expiresAt: number }
  >()
  const profileActivator = new AgentProfileActivatorV1({
    outputDir:
      options.openClawWorkspaceDir || "/workspace/sajtagent-openclaw/workspace",
    ceiling: options.ceiling,
  })

  function artifactAuthorizationKey(
    binding: ArtifactReadBindingV1,
    artifactRef: string,
  ): string {
    return [
      binding.tenantId,
      binding.projectId,
      binding.jobId,
      binding.baseRevisionId,
      binding.sourceRunId,
      binding.candidateRevisionId,
      binding.reportedAt,
      artifactRef,
    ].join("\0")
  }

  function removeExpiredArtifactState(now: number): void {
    for (const [key, value] of artifactAuthorizations) {
      if (value.expiresAt <= now) artifactAuthorizations.delete(key)
    }
    for (const [key, value] of artifactReadRequests) {
      if (value.expiresAt <= now) artifactReadRequests.delete(key)
    }
  }

  function authorizeCandidatePreview(
    job: BuildJobV1,
    report: WorkerReportV1,
    recordedAt: number,
  ): void {
    if (
      report.status !== "candidate" ||
      report.jobId !== job.jobId ||
      report.baseRevisionId !== job.baseRevisionId ||
      !job.executionPolicy.capabilities.includes("preview.manage")
    ) {
      return
    }
    const previewArtifacts = report.artifacts.filter(
      (artifact) => artifact.kind === "preview",
    )
    const preview = previewArtifacts[0]
    if (
      previewArtifacts.length !== 1 ||
      !preview ||
      preview.mediaType !== "text/html" ||
      !preview.sha256
    ) {
      return
    }
    const parsedRef = parseAuthorizedPreviewRefV1(preview.ref)
    if (!parsedRef) return
    const expiresAt = Math.min(
      Date.parse(job.expiresAt),
      recordedAt + ARTIFACT_AUTHORIZATION_RETENTION_MS,
    )
    if (!Number.isFinite(expiresAt) || expiresAt <= recordedAt) return
    const binding: ArtifactReadBindingV1 = {
      tenantId: job.tenantId,
      projectId: job.projectId,
      jobId: report.jobId,
      baseRevisionId: report.baseRevisionId,
      sourceRunId: report.sourceRunId,
      candidateRevisionId: report.candidateRevisionId,
      reportedAt: report.reportedAt,
    }
    const authorization: AuthorizedPreviewArtifactV1 = {
      binding,
      artifact: {
        kind: "preview",
        ref: preview.ref,
        relativePath: parsedRef.relativePath,
        mediaType: "text/html",
        sha256: preview.sha256,
      },
      expiresAt,
    }
    artifactAuthorizations.set(
      artifactAuthorizationKey(binding, preview.ref),
      authorization,
    )
  }

  function exactArtifactRequest(
    request: ArtifactReadRequestV1,
    authorization: AuthorizedPreviewArtifactV1,
  ): boolean {
    return (
      JSON.stringify(request.binding) === JSON.stringify(authorization.binding) &&
      request.artifact.kind === authorization.artifact.kind &&
      request.artifact.ref === authorization.artifact.ref &&
      request.artifact.mediaType === authorization.artifact.mediaType &&
      request.artifact.sha256 === authorization.artifact.sha256
    )
  }

  function sendArtifactUnavailable(response: ServerResponse): void {
    sendJson(response, 404, { error: "artifact_unavailable" })
  }

  function reportStatus(report: WorkerReportV1): number {
    if (report.status === "candidate") return 200
    if (report.status === "timed_out") return 504
    if (report.status === "cancelled") return 409
    const code = report.diagnostics[0]?.code
    if (code === "stale_revision" || code === "idempotency_conflict") return 409
    return 503
  }

  function idempotencyConflict(job: BuildJobV1): WorkerReportV1 {
    return WorkerReportV1Schema.parse({
      schemaVersion: 1,
      status: "failed",
      jobId: job.jobId,
      sourceRunId: `local:${job.jobId}`,
      baseRevisionId: job.baseRevisionId,
      receipts: [],
      diagnostics: [
        {
          code: "idempotency_conflict",
          message: "Samma idempotencyKey har redan använts med ett annat BuildJobV1-innehåll.",
          retryable: false,
        },
      ],
      reportedAt: new Date().toISOString(),
    })
  }

  function requireSignature(
    request: IncomingMessage,
    pathname: string,
    body: string,
  ): { ok: true } | { ok: false; status: number; reason: string } {
    if (!hasValidRuntimeSigningKey(options.signingKey)) {
      return { ok: false, status: 503, reason: "Runtime signing is not configured" }
    }
    const timestamp = request.headers[SIGNATURE_HEADERS_V1.timestamp]
    const nonce = request.headers[SIGNATURE_HEADERS_V1.nonce]
    const signature = request.headers[SIGNATURE_HEADERS_V1.signature]
    if (
      typeof timestamp !== "string" ||
      typeof nonce !== "string" ||
      typeof signature !== "string"
    ) {
      return { ok: false, status: 401, reason: "Missing runtime signature headers" }
    }

    const now = Date.now()
    for (const [seenNonce, expiresAt] of usedNonces) {
      if (expiresAt <= now) usedNonces.delete(seenNonce)
    }
    if (usedNonces.has(nonce)) {
      return { ok: false, status: 409, reason: "Runtime nonce has already been used" }
    }

    const verified = verifyRuntimeSignatureV1(
      {
        method: request.method || "POST",
        pathname,
        timestamp,
        nonce,
        signature,
        body,
      },
      options.signingKey,
      { now },
    )
    if (!verified.ok) {
      return { ok: false, status: 401, reason: verified.reason }
    }
    usedNonces.set(nonce, now + NONCE_RETENTION_MS)
    return { ok: true }
  }

  return createServer(async (request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined
    const corsHeaders = allowedCorsHeaders(origin, options.allowedOrigins)
    if (origin && !options.allowedOrigins.includes(origin)) {
      sendJson(response, 403, { error: "origin_not_allowed" })
      return
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders)
      response.end()
      return
    }

    const url = new URL(request.url || "/", `http://${options.host}`)
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const gatewayHealth = await runner.health()
        const turnGatewayHealth = Object.is(runner, turnRunner)
          ? gatewayHealth
          : await turnRunner.health()
        const artifactReaderAvailable = await artifactReaderRootAvailableV1(
          options.workersRoot,
        )
        const signedPrivateRoutesEnabled = hasValidRuntimeSigningKey(
          options.signingKey,
        )
        const buildRequestHandoffEnabled = Boolean(
          signedPrivateRoutesEnabled &&
          turnGatewayHealth.connected &&
          turnGatewayHealth.buildRequestToolRegistered === true,
        )
        const agentTurnCapabilities = buildRequestHandoffEnabled
          ? RUNTIME_AGENT_TURN_CAPABILITIES_V1
          : (["conversation.respond"] as const)
        sendJson(
          response,
          200,
          {
            service: "sajtagent-sprites-runtime",
            mode: gatewayHealth.connected ? "openclaw-gateway" : "fail-closed",
            openClawConnected: gatewayHealth.connected,
            openClawVersion: gatewayHealth.runtimeVersion,
            openClawReason: gatewayHealth.reason,
            signedJobsEnabled: signedPrivateRoutesEnabled,
            agentSessionContractVersion: 1,
            agentTurnStreamTransport: "sse",
            agentTurnStreamEnabled: Boolean(
              signedPrivateRoutesEnabled && turnGatewayHealth.connected,
            ),
            agentTurnCapabilities,
            buildRequestHandoffEnabled,
            ...(!buildRequestHandoffEnabled &&
            turnGatewayHealth.buildRequestToolReason
              ? {
                  buildRequestHandoffReason:
                    turnGatewayHealth.buildRequestToolReason,
                }
              : {}),
            artifactReadContractVersion: ARTIFACT_READ_CONTRACT_VERSION_V1,
            artifactReadEnabled: Boolean(
              signedPrivateRoutesEnabled && artifactReaderAvailable,
            ),
            agentProfileActivationContractVersion:
              AGENT_PROFILE_ACTIVATION_CONTRACT_VERSION_V1,
            agentProfileActivationEnabled: signedPrivateRoutesEnabled,
          },
          corsHeaders,
        )
        return
      }

      if (request.method === "GET" && url.pathname === "/v1/runtime-capabilities") {
        sendJson(response, 200, { ceiling: options.ceiling }, corsHeaders)
        return
      }

      if (request.method === "POST" && url.pathname === "/v1/agent-profiles/compile") {
        const body = await readBody(request)
        if (!isLoopbackHost(options.host)) {
          const signed = requireSignature(request, url.pathname, body)
          if (!signed.ok) {
            sendJson(response, signed.status, { error: "unauthorized", message: signed.reason }, corsHeaders)
            return
          }
        }
        const input = JSON.parse(body) as { profile?: unknown }
        const profile = AgentProfileV1Schema.parse(input.profile)
        const bundle = compilePortableOpenClawBundleV1(profile, options.ceiling)
        sendJson(response, 200, bundle, corsHeaders)
        return
      }

      if (
        request.method === "POST" &&
        url.pathname === AGENT_PROFILE_ACTIVATION_PATH_V1 &&
        url.search === ""
      ) {
        const contentType = request.headers["content-type"]
        if (
          typeof contentType !== "string" ||
          contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
        ) {
          sendJson(response, 400, { error: "invalid_request" }, corsHeaders)
          return
        }
        let body: string
        try {
          body = await readBody(
            request,
            MAX_AGENT_PROFILE_ACTIVATION_REQUEST_BYTES_V1,
          )
        } catch {
          sendJson(response, 413, { error: "invalid_request" }, corsHeaders)
          return
        }
        const signed = requireSignature(
          request,
          AGENT_PROFILE_ACTIVATION_PATH_V1,
          body,
        )
        if (!signed.ok) {
          sendJson(
            response,
            signed.status,
            { error: "unauthorized", message: signed.reason },
            corsHeaders,
          )
          return
        }
        const input = AgentProfileActivationRequestV1Schema.parse(
          JSON.parse(body),
        )
        const requestDigest = createHash("sha256").update(body).digest("hex")
        try {
          const receipt = await profileActivator.activate(input, requestDigest)
          sendJson(response, 200, receipt, corsHeaders)
        } catch (error) {
          if (error instanceof AgentProfileActivationErrorV1) {
            const status = error.code.includes("conflict") ? 409 : 503
            sendJson(
              response,
              status,
              {
                error: error.code,
                message: error.message,
                ...(error.activeRevision === undefined
                  ? {}
                  : { activeRevision: error.activeRevision }),
              },
              corsHeaders,
            )
            return
          }
          throw error
        }
        return
      }

      if (
        request.method === "POST" &&
        url.pathname === ARTIFACT_READ_PATH_V1 &&
        url.search === ""
      ) {
        const contentType = request.headers["content-type"]
        if (
          typeof contentType !== "string" ||
          contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
        ) {
          sendJson(response, 400, { error: "invalid_request" })
          return
        }

        let body: string
        try {
          body = await readBody(request, MAX_ARTIFACT_READ_REQUEST_BYTES_V1)
        } catch {
          sendJson(response, 413, { error: "invalid_request" })
          return
        }
        const signed = requireSignature(request, ARTIFACT_READ_PATH_V1, body)
        if (!signed.ok) {
          sendJson(response, signed.status, { error: "unauthorized" })
          return
        }

        let decoded: unknown
        try {
          decoded = JSON.parse(body)
        } catch {
          sendJson(response, 400, { error: "invalid_request" })
          return
        }
        const parsedRequest = ArtifactReadRequestV1Schema.safeParse(decoded)
        if (!parsedRequest.success) {
          sendJson(response, 400, { error: "invalid_request" })
          return
        }
        const input = parsedRequest.data
        const now = Date.now()
        removeExpiredArtifactState(now)
        const bodyDigest = createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex")
        const existingRead = artifactReadRequests.get(input.readIdempotencyKey)
        if (existingRead && existingRead.bodyDigest !== bodyDigest) {
          sendJson(response, 409, { error: "artifact_read_idempotency_conflict" })
          return
        }

        const authorization = artifactAuthorizations.get(
          artifactAuthorizationKey(input.binding, input.artifact.ref),
        )
        if (!authorization || !exactArtifactRequest(input, authorization)) {
          sendArtifactUnavailable(response)
          return
        }
        if (!existingRead) {
          artifactReadRequests.set(input.readIdempotencyKey, {
            bodyDigest,
            expiresAt: Math.min(
              authorization.expiresAt,
              now + IDEMPOTENCY_RETENTION_MS,
            ),
          })
        }

        try {
          const value = await readAuthorizedPreviewArtifactV1(
            options.workersRoot || "",
            authorization,
            input.maxBytes,
          )
          const result = ArtifactReadResponseV1Schema.parse({
            schemaVersion: ARTIFACT_READ_CONTRACT_VERSION_V1,
            readIdempotencyKey: input.readIdempotencyKey,
            binding: authorization.binding,
            maxBytes: input.maxBytes,
            artifact: {
              ...authorization.artifact,
              sizeBytes: value.sizeBytes,
              encoding: "base64",
              bytesBase64: value.bytes.toString("base64"),
            },
          })
          const serialized = JSON.stringify(result)
          const serializedBytes = Buffer.byteLength(serialized, "utf8")
          if (serializedBytes > MAX_ARTIFACT_READ_RESPONSE_BYTES_V1) {
            sendArtifactUnavailable(response)
            return
          }
          response.writeHead(200, {
            ...responseHeaders(),
            "content-length": String(serializedBytes),
          })
          response.end(serialized)
        } catch {
          sendArtifactUnavailable(response)
        }
        return
      }

      if (request.method === "POST" && url.pathname === "/v1/build-jobs") {
        const body = await readBody(request)
        const signed = requireSignature(request, url.pathname, body)
        if (!signed.ok) {
          sendJson(response, signed.status, { error: "unauthorized", message: signed.reason }, corsHeaders)
          return
        }
        const job = BuildJobV1Schema.parse(JSON.parse(body))
        const now = Date.now()
        for (const [key, value] of jobRequests) {
          if (value.expiresAt <= now) jobRequests.delete(key)
        }
        const bodyDigest = createHash("sha256").update(JSON.stringify(job)).digest("hex")
        const existing = jobRequests.get(job.idempotencyKey)
        if (existing && existing.bodyDigest !== bodyDigest) {
          const report = idempotencyConflict(job)
          sendJson(response, 409, report, corsHeaders)
          return
        }
        const reportPromise = existing?.report ?? runner.run(job, routeBuildJobModelV1(job))
        if (!existing) {
          jobRequests.set(job.idempotencyKey, {
            bodyDigest,
            expiresAt: now + IDEMPOTENCY_RETENTION_MS,
            report: reportPromise,
          })
        }
        const report = WorkerReportV1Schema.parse(await reportPromise)
        removeExpiredArtifactState(now)
        authorizeCandidatePreview(job, report, now)
        sendJson(response, reportStatus(report), report, corsHeaders)
        return
      }

      if (request.method === "POST" && url.pathname === "/v1/agent-turns") {
        const body = await readBody(request)
        const signed = requireSignature(request, url.pathname, body)
        if (!signed.ok) {
          sendJson(response, signed.status, { error: "unauthorized", message: signed.reason }, corsHeaders)
          return
        }
        const input = RuntimeAgentTurnIngressV1Schema.parse(JSON.parse(body))
        try {
          assertRuntimeAgentTurnSupportedV1(input)
        } catch (error) {
          sendJson(response, 409, {
            error: error instanceof Error ? error.message : "agent_turn_not_supported",
          }, corsHeaders)
          return
        }
        if (input.policy.capabilities.includes("build.request")) {
          const turnHealth = await turnRunner.health()
          if (
            !turnHealth.connected ||
            turnHealth.buildRequestToolRegistered !== true
          ) {
            sendJson(response, 503, {
              error: "agent_build_request_handoff_unavailable",
              message:
                "OpenClaw build-request handoff tool is not registered.",
            }, corsHeaders)
            return
          }
        }

        const now = Date.now()
        for (const [key, value] of turnRequests) {
          if (value.expiresAt <= now) turnRequests.delete(key)
        }
        const bodyDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex")
        const existing = turnRequests.get(input.turn.idempotencyKey)
        if (existing) {
          sendJson(response, 409, {
            error: existing.bodyDigest === bodyDigest
              ? "agent_turn_already_started_use_site_resume"
              : "agent_turn_idempotency_conflict",
          }, corsHeaders)
          return
        }
        if (activeTurnSessions.has(input.session.sessionId)) {
          sendJson(response, 409, { error: "agent_session_turn_in_progress" }, corsHeaders)
          return
        }
        turnRequests.set(input.turn.idempotencyKey, {
          bodyDigest,
          expiresAt: now + IDEMPOTENCY_RETENTION_MS,
          sessionId: input.session.sessionId,
        })
        activeTurnSessions.add(input.session.sessionId)

        response.writeHead(200, {
          "cache-control": "no-store",
          "connection": "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
          ...corsHeaders,
        })
        response.flushHeaders()
        let streamedEventCount = 0
        let streamedBytes = 0
        const emitter = createAgentEventEmitterV1(input, (event) => {
          const frame = formatAgentEventSseV1(event)
          const frameBytes = Buffer.byteLength(frame, "utf8")
          const terminal = event.type === "turn.completed" || event.type === "turn.failed"
          if (frameBytes > MAX_AGENT_EVENT_SSE_BYTES_V1) {
            throw new Error("agent_event_sse_too_large")
          }
          if (
            !terminal &&
            (streamedEventCount >= MAX_AGENT_TURN_EVENTS_V1 - 1 ||
              streamedBytes + frameBytes >
                MAX_AGENT_TURN_SSE_BYTES_V1 - AGENT_TURN_TERMINAL_RESERVE_BYTES_V1)
          ) {
            throw new Error("agent_turn_sse_limit_reached")
          }
          if (
            terminal &&
            (streamedEventCount >= MAX_AGENT_TURN_EVENTS_V1 ||
              streamedBytes + frameBytes > MAX_AGENT_TURN_SSE_BYTES_V1)
          ) {
            throw new Error("agent_turn_terminal_sse_limit_reached")
          }
          streamedEventCount += 1
          streamedBytes += frameBytes
          response.write(frame)
        })
        const acceptedAt = new Date().toISOString()
        emitter.emit({
          type: "turn.accepted",
          occurredAt: acceptedAt,
          payload: { acceptedAt },
        })
        try {
          const result = await turnRunner.runTurn(
            input,
            (event) => emitter.emit(event),
          )
          if (result.outcome === "build_handoff") {
            const lastEvent = emitter.lastEvent
            if (
              emitter.terminal ||
              lastEvent?.type !== "tool.started" ||
              lastEvent.payload.capability !== "build.request" ||
              lastEvent.payload.toolCallId !== result.toolCallId
            ) {
              throw new Error("agent_turn_invalid_build_handoff")
            }
          } else if (!emitter.terminal) {
            emitter.emit({
              type: "turn.failed",
              payload: {
                code: "agent_turn_stream_incomplete",
                message: "Agentkörningen avslutades utan en terminal händelse.",
                retryable: true,
              },
            })
          }
        } catch (error) {
          console.error("[runtime/agent-turn] failed", {
            errorCode: safeRuntimeErrorCodeV1(error),
          })
          if (!emitter.terminal) {
            emitter.emit({
              type: "turn.failed",
              payload: {
                code: "agent_turn_runtime_error",
                message: "Agentkörningen misslyckades i Runtime.",
                retryable: true,
              },
            })
          }
        } finally {
          activeTurnSessions.delete(input.session.sessionId)
          response.end()
        }
        return
      }

      sendJson(response, 404, { error: "not_found" }, corsHeaders)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request"
      const status = message === "request_too_large" ? 413 : 400
      sendJson(response, status, { error: "invalid_request", message }, corsHeaders)
    }
  })
}

export async function startRuntimeServer(
  options: RuntimeServerOptions = resolveRuntimeServerOptions(),
) {
  const gatewayRunner = new OpenClawGatewayBuildJobRunnerV1({
          gatewayUrl: options.openClawGatewayUrl || "ws://127.0.0.1:18789",
          gatewayToken: options.openClawGatewayToken,
          projectsRoot: options.projectsRoot || "/workspace/sajtagent-projects",
          workersRoot: options.workersRoot || "/workspace/sajtagent-workers",
          clientStateDir:
            options.openClawClientStateDir ||
            "/home/sprite/.config/sajtagent/openclaw-client",
        })
  const effectiveOptions: RuntimeServerOptions = {
    ...options,
    runner: options.runner ?? gatewayRunner,
    turnRunner: options.turnRunner ?? gatewayRunner,
  }
  const server = createRuntimeServer(effectiveOptions)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : options.port
  console.log(`sajtagent-sprites-runtime listening on http://${options.host}:${port}`)
  console.log(`mode=openclaw-gateway gateway=${options.openClawGatewayUrl || "ws://127.0.0.1:18789"}`)
  return server
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (invokedPath === import.meta.url) {
  await startRuntimeServer()
}
