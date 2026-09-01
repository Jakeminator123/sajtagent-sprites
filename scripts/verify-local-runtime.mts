import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_AGENT_PROFILE_V1,
  DEFAULT_LOCAL_AGENT_CEILING_V1,
} from "../contracts/agent-profile-v1.ts"
import {
  AgentEventV1Schema,
  validateAgentTurnAgainstPolicyV1,
} from "../contracts/agent-session-v1.ts"
import {
  ARTIFACT_READ_PATH_V1,
  ArtifactReadRequestV1Schema,
  MAX_ARTIFACT_READ_REQUEST_BYTES_V1,
  MAX_PREVIEW_ARTIFACT_BYTES_V1,
  validateArtifactReadResponseV1,
} from "../contracts/artifact-read-v1.ts"
import { WorkerReportV1Schema } from "../contracts/builder-v1.ts"
import {
  createRuntimeServer,
  resolveRuntimeServerOptions,
} from "../src/server.ts"
import {
  routeAgentTurnModelV1,
  routeBuildJobModelV1,
} from "../src/model-routing.ts"
import {
  compileSessionPermissionModeV1,
  type BuildJobRunnerV1,
} from "../src/openclaw-gateway.ts"
import {
  SIGNATURE_HEADERS_V1,
  signRuntimeRequestV1,
} from "../src/signing.ts"
import { materializeOpenClawProfileV1 } from "../src/materialize-profile.ts"
import { parseGitStatusPathsV1 } from "../src/workspace.ts"
import {
  MAX_AGENT_EVENT_SSE_BYTES_V1,
  MAX_AGENT_TURN_EVENTS_V1,
  MAX_AGENT_TURN_SSE_BYTES_V1,
  compileConversationOnlyOpenClawToolPolicyV1,
  createOpenClawAgentNormalizerStateV1,
  normalizeOpenClawGatewayEventV1,
  type AgentTurnRunnerV1,
  type RuntimeAgentTurnIngressV1,
} from "../src/agent-turn.ts"

const signingKey = "local-test-key-that-is-at-least-32-characters-long"

function signedRuntimeHeaders(pathname: string, body: string, nonce = randomUUID()) {
  const timestamp = new Date().toISOString()
  return {
    "content-type": "application/json",
    [SIGNATURE_HEADERS_V1.timestamp]: timestamp,
    [SIGNATURE_HEADERS_V1.nonce]: nonce,
    [SIGNATURE_HEADERS_V1.signature]: signRuntimeRequestV1(
      { method: "POST", pathname, timestamp, nonce, body },
      signingKey,
    ),
  }
}
assert.equal(MAX_AGENT_TURN_EVENTS_V1, 4_096)
assert.equal(MAX_AGENT_EVENT_SSE_BYTES_V1, 32 * 1024)
assert.equal(MAX_AGENT_TURN_SSE_BYTES_V1, 4 * 1024 * 1024)
assert.deepEqual(compileConversationOnlyOpenClawToolPolicyV1(), {
  inheritedToolPolicyVersion: 1,
  inheritedToolAllow: [],
  inheritedToolDeny: ["*"],
})
const fakeTurnRunner = {
  async health() {
    return { connected: true, runtimeVersion: "openclaw-test" }
  },
  async runTurn(_input, emit) {
    emit({ type: "agent.status", payload: { state: "thinking" } })
    emit({
      type: "message.delta",
      payload: { messageId: "message:local-test", delta: "Hej från OpenClaw" },
    })
    emit({ type: "turn.completed", payload: { outcome: "answered" } })
  },
} satisfies AgentTurnRunnerV1
assert.deepEqual(parseGitStatusPathsV1(" M index.html\n?? preview.html"), [
  "index.html",
  "preview.html",
])
const allowedOrigin = "http://localhost:3000"
assert(
  resolveRuntimeServerOptions({}).allowedOrigins.includes("http://127.0.0.1:3147"),
)
const profileOutput = await mkdtemp(join(tmpdir(), "siteagent-openclaw-profile-"))
try {
  await materializeOpenClawProfileV1({ outputDir: profileOutput })
  assert.match(await readFile(join(profileOutput, "SOUL.md"), "utf8"), /Sajtagenten/)
  assert.match(
    await readFile(join(profileOutput, "profiles", "openclaw.yml"), "utf8"),
    /workspaceOnly: true/,
  )
} finally {
  await rm(profileOutput, { recursive: true, force: true })
}
const server = createRuntimeServer({
  host: "127.0.0.1",
  port: 0,
  signingKey,
  allowedOrigins: [allowedOrigin],
  ceiling: DEFAULT_LOCAL_AGENT_CEILING_V1,
  turnRunner: fakeTurnRunner,
})

await new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => resolve())
})

try {
  const address = server.address()
  assert(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}`

  const health = await fetch(`${baseUrl}/health`, {
    headers: { Origin: allowedOrigin },
  })
  assert.equal(health.status, 200)
  assert.equal(health.headers.get("access-control-allow-origin"), allowedOrigin)
  const healthBody = await health.json() as {
    openClawConnected: boolean
    agentSessionContractVersion: number
    agentTurnStreamTransport: string
    agentTurnStreamEnabled: boolean
    agentTurnCapabilities: string[]
    artifactReadEnabled: boolean
  }
  assert.equal(healthBody.openClawConnected, false)
  assert.equal(healthBody.agentSessionContractVersion, 1)
  assert.equal(healthBody.agentTurnStreamTransport, "sse")
  assert.equal(healthBody.agentTurnStreamEnabled, true)
  assert.deepEqual(healthBody.agentTurnCapabilities, ["conversation.respond"])
  assert.equal(healthBody.artifactReadEnabled, false)

  const blockedOrigin = await fetch(`${baseUrl}/health`, {
    headers: { Origin: "https://attacker.example" },
  })
  assert.equal(blockedOrigin.status, 403)

  const compiled = await fetch(`${baseUrl}/v1/agent-profiles/compile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: allowedOrigin,
    },
    body: JSON.stringify({ profile: DEFAULT_AGENT_PROFILE_V1 }),
  })
  assert.equal(compiled.status, 200)
  const bundle = await compiled.json() as {
    files: Record<string, string>
    effectivePolicy: { commandMode: string }
  }
  assert.match(bundle.files["SOUL.md"] || "", /Sajtagenten/)
  assert.match(bundle.files["profiles/openclaw.yml"] || "", /workspaceOnly: true/)
  assert.equal(bundle.effectivePolicy.commandMode, "auto")

  const invalidProfile = await fetch(`${baseUrl}/v1/agent-profiles/compile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: { schemaVersion: 1 } }),
  })
  assert.equal(invalidProfile.status, 400)

  const sessionCreatedAt = new Date()
  const turnPolicyExpiresAt = new Date(sessionCreatedAt.getTime() + 10 * 60_000)
  const directTurn: RuntimeAgentTurnIngressV1 = {
    schemaVersion: 1,
    session: {
      schemaVersion: 1,
      sessionId: "session:abcdefghijklmnopqrstuvwxyzABCDEF",
      projectId: "project:test",
      activeBaseRevisionId: "revision:base",
      status: "active",
      createdAt: sessionCreatedAt.toISOString(),
      updatedAt: sessionCreatedAt.toISOString(),
    },
    turn: {
      schemaVersion: 1,
      sessionId: "session:abcdefghijklmnopqrstuvwxyzABCDEF",
      turnId: "turn:abcdefghijklmnop",
      idempotencyKey: "idempotency:agent-turn-local-test",
      message: "Vad är klockan?",
      uiContext: {
        selectedBaseRevisionId: "revision:base",
        mode: "freeform",
      },
    },
    policy: {
      schemaVersion: 1,
      sessionId: "session:abcdefghijklmnopqrstuvwxyzABCDEF",
      turnId: "turn:abcdefghijklmnop",
      projectId: "project:test",
      baseRevisionId: "revision:base",
      issuedAt: sessionCreatedAt.toISOString(),
      expiresAt: turnPolicyExpiresAt.toISOString(),
      capabilities: ["conversation.respond"],
      allowedMutationIntents: [],
      maxToolCalls: 0,
      maxModelTokens: 10_000,
      maxCostMicros: 100_000,
    },
    baseSequence: 40,
  }

  assert.equal(
    routeAgentTurnModelV1(directTurn.turn, directTurn.policy).model,
    "openai/gpt-5.6-luna",
  )
  const routineDirectTurn = structuredClone(directTurn)
  routineDirectTurn.turn.message = "x".repeat(600)
  routineDirectTurn.policy.maxModelTokens = 60_000
  assert.equal(
    routeAgentTurnModelV1(routineDirectTurn.turn, routineDirectTurn.policy).model,
    "openai/gpt-5.6-terra",
  )
  const deepDirectTurn = structuredClone(routineDirectTurn)
  deepDirectTurn.turn.uiContext.mode = "audit"
  deepDirectTurn.policy.maxModelTokens = 250_000
  assert.deepEqual(
    {
      model: routeAgentTurnModelV1(deepDirectTurn.turn, deepDirectTurn.policy).model,
      thinking: routeAgentTurnModelV1(deepDirectTurn.turn, deepDirectTurn.policy).thinkingLevel,
    },
    { model: "openai/gpt-5.6-sol", thinking: "xhigh" },
  )

  const unsignedTurn = await fetch(`${baseUrl}/v1/agent-turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(directTurn),
  })
  assert.equal(unsignedTurn.status, 401)

  const turnBody = JSON.stringify(directTurn)
  const turnTimestamp = new Date().toISOString()
  const turnNonce = randomUUID()
  const turnSignature = signRuntimeRequestV1(
    {
      method: "POST",
      pathname: "/v1/agent-turns",
      timestamp: turnTimestamp,
      nonce: turnNonce,
      body: turnBody,
    },
    signingKey,
  )
  const turnResponse = await fetch(`${baseUrl}/v1/agent-turns`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADERS_V1.timestamp]: turnTimestamp,
      [SIGNATURE_HEADERS_V1.nonce]: turnNonce,
      [SIGNATURE_HEADERS_V1.signature]: turnSignature,
    },
    body: turnBody,
  })
  assert.equal(turnResponse.status, 200)
  assert.match(turnResponse.headers.get("content-type") || "", /^text\/event-stream/)
  assert.equal(turnResponse.headers.get("cache-control"), "no-store")
  const frames = (await turnResponse.text()).trim().split("\n\n")
  const agentEvents = frames.map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))
    assert(data)
    return AgentEventV1Schema.parse(JSON.parse(data.slice("data: ".length)))
  })
  assert.deepEqual(agentEvents.map((event) => event.sequence), [41, 42, 43, 44])
  assert.deepEqual(agentEvents.map((event) => event.type), [
    "turn.accepted",
    "agent.status",
    "message.delta",
    "turn.completed",
  ])
  assert.equal(validateAgentTurnAgainstPolicyV1(
    directTurn.session,
    directTurn.policy,
    agentEvents,
    { baseSequence: directTurn.baseSequence },
  ).success, true)

  const retryTimestamp = new Date().toISOString()
  const retryNonce = randomUUID()
  const retriedTurn = await fetch(`${baseUrl}/v1/agent-turns`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADERS_V1.timestamp]: retryTimestamp,
      [SIGNATURE_HEADERS_V1.nonce]: retryNonce,
      [SIGNATURE_HEADERS_V1.signature]: signRuntimeRequestV1(
        {
          method: "POST",
          pathname: "/v1/agent-turns",
          timestamp: retryTimestamp,
          nonce: retryNonce,
          body: turnBody,
        },
        signingKey,
      ),
    },
    body: turnBody,
  })
  assert.equal(retriedTurn.status, 409)
  assert.equal(
    (await retriedTurn.json() as { error: string }).error,
    "agent_turn_already_started_use_site_resume",
  )

  const normalizerState = createOpenClawAgentNormalizerStateV1()
  const normalizeContext = {
    runId: "openclaw-run:test",
    turnId: directTurn.turn.turnId,
    capabilities: directTurn.policy.capabilities,
    state: normalizerState,
  }
  assert.equal(normalizeOpenClawGatewayEventV1({
    event: "agent",
    payload: {
      runId: "openclaw-run:test",
      seq: 0,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "start" },
    },
  }, normalizeContext)[0]?.type, "agent.status")
  const firstAssistantDelta = normalizeOpenClawGatewayEventV1({
    event: "agent",
    payload: {
      runId: "openclaw-run:test",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hej", delta: "Hej" },
    },
  }, normalizeContext)[0]
  assert.equal(firstAssistantDelta?.type, "message.delta")
  assert.equal(firstAssistantDelta?.type === "message.delta"
    ? firstAssistantDelta.payload.delta
    : undefined, "Hej")
  const secondAssistantDelta = normalizeOpenClawGatewayEventV1({
    event: "agent",
    payload: {
      runId: "openclaw-run:test",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hej där" },
    },
  }, normalizeContext)[0]
  assert.equal(secondAssistantDelta?.type, "message.delta")
  assert.equal(secondAssistantDelta?.type === "message.delta"
    ? secondAssistantDelta.payload.delta
    : undefined, " där")
  assert.throws(() => normalizeOpenClawGatewayEventV1({
    event: "agent",
    payload: {
      runId: "openclaw-run:test",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "exec", toolCallId: "tool-call-1" },
    },
  }, normalizeContext), /openclaw_unauthorized_tool_event/)

  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + 10 * 60_000)
  const deadlineAt = new Date(createdAt.getTime() + 5 * 60_000)
  const job = {
    schemaVersion: 1,
    jobId: "job:local-runtime-test",
    tenantId: "tenant:test",
    projectId: "project:test",
    baseRevisionId: "revision:base",
    idempotencyKey: "idempotency:local-runtime-test",
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    intent: {
      schemaVersion: 1,
      intentType: "site.change",
      message: "Verifiera fail-closed runtime",
      context: {},
    },
    executionPolicy: {
      deadlineAt: deadlineAt.toISOString(),
      maxSteps: 10,
      maxToolCalls: 20,
      maxModelTokens: 10_000,
      maxCostMicros: 100_000,
      capabilities: ["workspace.read"],
      network: { mode: "deny-all" },
      packages: { mode: "deny" },
    },
  }
  const body = JSON.stringify(job)

  assert.deepEqual(
    routeBuildJobModelV1(job as never),
    {
      schemaVersion: 1,
      tier: "fast",
      model: "openai/gpt-5.6-luna",
      thinkingLevel: "off",
      reasoningVisibility: "off",
      reasonCode: "small_bounded_change",
    },
  )
  assert.equal(compileSessionPermissionModeV1(job as never), "read-only")
  const routineJob = structuredClone(job)
  routineJob.executionPolicy.maxSteps = 30
  routineJob.executionPolicy.maxToolCalls = 60
  routineJob.executionPolicy.maxModelTokens = 60_000
  routineJob.executionPolicy.capabilities = ["workspace.read", "workspace.write"]
  assert.equal(routeBuildJobModelV1(routineJob as never).model, "openai/gpt-5.6-terra")
  assert.equal(compileSessionPermissionModeV1(routineJob as never), "guarded")
  const complexJob = structuredClone(routineJob)
  complexJob.intent.context = { ...complexJob.intent.context, planMode: true }
  complexJob.executionPolicy.capabilities = [
    "workspace.read",
    "workspace.write",
    "command.execute",
    "browser.inspect",
    "preview.manage",
  ]
  assert.deepEqual(
    {
      model: routeBuildJobModelV1(complexJob as never).model,
      thinking: routeBuildJobModelV1(complexJob as never).thinkingLevel,
    },
    { model: "openai/gpt-5.6-sol", thinking: "xhigh" },
  )
  assert.equal(compileSessionPermissionModeV1(complexJob as never), "workspace")

  const unsignedJob = await fetch(`${baseUrl}/v1/build-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  assert.equal(unsignedJob.status, 401)

  const timestamp = new Date().toISOString()
  const nonce = randomUUID()
  const signature = signRuntimeRequestV1(
    { method: "POST", pathname: "/v1/build-jobs", timestamp, nonce, body },
    signingKey,
  )
  const signedHeaders = {
    "content-type": "application/json",
    [SIGNATURE_HEADERS_V1.timestamp]: timestamp,
    [SIGNATURE_HEADERS_V1.nonce]: nonce,
    [SIGNATURE_HEADERS_V1.signature]: signature,
  }
  const failedClosed = await fetch(`${baseUrl}/v1/build-jobs`, {
    method: "POST",
    headers: signedHeaders,
    body,
  })
  assert.equal(failedClosed.status, 503)
  const report = await failedClosed.json() as { status: string; diagnostics: Array<{ code: string }> }
  assert.equal(report.status, "failed")
  assert.equal(report.diagnostics[0]?.code, "openclaw_not_connected")

  const replayed = await fetch(`${baseUrl}/v1/build-jobs`, {
    method: "POST",
    headers: signedHeaders,
    body,
  })
  assert.equal(replayed.status, 409)

  console.log("PASS local runtime: signed fail-closed flow and Luna/Terra/Sol routing")
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

const artifactTestRoot = await mkdtemp(join(tmpdir(), "siteagent-artifact-read-"))
const workersRoot = join(artifactTestRoot, "workers")
const workspaceId = "a".repeat(32)
const workerDir = join(workersRoot, workspaceId)
const previewPath = join(workerDir, "index.html")
const previewBytes = Buffer.from(
  "<!doctype html><html><body>verified preview</body></html>",
)
const previewSha256 = createHash("sha256").update(previewBytes).digest("hex")
const previewRef = `sprite-worktree:${workspaceId}:index.html`
const sourceRunId = "openclaw:artifact-read-test"

await mkdir(workerDir, { recursive: true })
await writeFile(previewPath, previewBytes)

const shortSigningKey = "too-short"
const shortKeyServer = createRuntimeServer({
  host: "127.0.0.1",
  port: 0,
  signingKey: shortSigningKey,
  allowedOrigins: [allowedOrigin],
  ceiling: DEFAULT_LOCAL_AGENT_CEILING_V1,
  workersRoot,
})
await new Promise<void>((resolve, reject) => {
  shortKeyServer.once("error", reject)
  shortKeyServer.listen(0, "127.0.0.1", () => resolve())
})
try {
  const shortAddress = shortKeyServer.address()
  assert(shortAddress && typeof shortAddress === "object")
  const shortBaseUrl = `http://127.0.0.1:${shortAddress.port}`
  const shortHealth = await fetch(`${shortBaseUrl}/health`)
  const shortHealthBody = await shortHealth.json() as {
    signedJobsEnabled: boolean
    agentTurnStreamEnabled: boolean
    artifactReadEnabled: boolean
  }
  assert.equal(shortHealthBody.signedJobsEnabled, false)
  assert.equal(shortHealthBody.agentTurnStreamEnabled, false)
  assert.equal(shortHealthBody.artifactReadEnabled, false)

  const shortBody = "{}"
  const shortTimestamp = new Date().toISOString()
  const shortNonce = randomUUID()
  const shortSignedRead = await fetch(`${shortBaseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADERS_V1.timestamp]: shortTimestamp,
      [SIGNATURE_HEADERS_V1.nonce]: shortNonce,
      [SIGNATURE_HEADERS_V1.signature]: "0".repeat(64),
    },
    body: shortBody,
  })
  assert.equal(shortSignedRead.status, 503)
  assert.deepEqual(await shortSignedRead.json(), { error: "unauthorized" })
} finally {
  await new Promise<void>((resolve, reject) => {
    shortKeyServer.close((error) => (error ? reject(error) : resolve()))
  })
}

const artifactRunner: BuildJobRunnerV1 = {
  async health() {
    return { connected: true, runtimeVersion: "artifact-test" }
  },
  async run(job) {
    const reportedAt = new Date().toISOString()
    return WorkerReportV1Schema.parse({
      schemaVersion: 1,
      status: "candidate",
      jobId: job.jobId,
      sourceRunId,
      baseRevisionId: job.baseRevisionId,
      candidateRevisionId: "candidate:artifact-read-test",
      changedPaths: ["index.html"],
      artifacts: [
        {
          kind: "preview",
          ref: previewRef,
          mediaType: "text/html",
          sha256: previewSha256,
        },
      ],
      receipts: [
        {
          receiptId: "preview:artifact-read-test",
          category: "preview",
          name: "HTML preview artifact",
          status: "passed",
          startedAt: reportedAt,
          finishedAt: reportedAt,
          evidenceRef: previewRef,
        },
      ],
      diagnostics: [],
      reportedAt,
    })
  },
}

const artifactServer = createRuntimeServer({
  host: "127.0.0.1",
  port: 0,
  signingKey,
  allowedOrigins: [allowedOrigin],
  ceiling: DEFAULT_LOCAL_AGENT_CEILING_V1,
  runner: artifactRunner,
  workersRoot,
})

await new Promise<void>((resolve, reject) => {
  artifactServer.once("error", reject)
  artifactServer.listen(0, "127.0.0.1", () => resolve())
})

try {
  const address = artifactServer.address()
  assert(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const healthResponse = await fetch(`${baseUrl}/health`)
  const health = await healthResponse.json() as {
    artifactReadContractVersion: number
    artifactReadEnabled: boolean
  }
  assert.equal(health.artifactReadContractVersion, 1)
  assert.equal(health.artifactReadEnabled, true)

  const createdAt = new Date()
  const artifactJob = {
    schemaVersion: 1,
    jobId: "job:artifact-read-test",
    tenantId: "tenant:test",
    projectId: "project:test",
    baseRevisionId: "revision:artifact-base",
    idempotencyKey: "idempotency:artifact-read-test",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
    intent: {
      schemaVersion: 1,
      intentType: "site.change",
      message: "Skapa en verifierbar preview",
      context: {},
    },
    executionPolicy: {
      deadlineAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
      maxSteps: 20,
      maxToolCalls: 40,
      maxModelTokens: 20_000,
      maxCostMicros: 100_000,
      capabilities: ["workspace.read", "preview.manage"],
      network: { mode: "deny-all" },
      packages: { mode: "deny" },
    },
  }
  const buildBody = JSON.stringify(artifactJob)
  const candidateResponse = await fetch(`${baseUrl}/v1/build-jobs`, {
    method: "POST",
    headers: signedRuntimeHeaders("/v1/build-jobs", buildBody),
    body: buildBody,
  })
  assert.equal(candidateResponse.status, 200)
  const candidate = WorkerReportV1Schema.parse(await candidateResponse.json())
  assert.equal(candidate.status, "candidate")
  if (candidate.status !== "candidate") throw new Error("Expected candidate report")
  const preview = candidate.artifacts.find((artifact) => artifact.kind === "preview")
  assert(preview?.sha256)

  const readRequest = ArtifactReadRequestV1Schema.parse({
    schemaVersion: 1,
    readIdempotencyKey: "artifact-read:runtime-test",
    binding: {
      tenantId: artifactJob.tenantId,
      projectId: artifactJob.projectId,
      jobId: candidate.jobId,
      baseRevisionId: candidate.baseRevisionId,
      sourceRunId: candidate.sourceRunId,
      candidateRevisionId: candidate.candidateRevisionId,
      reportedAt: candidate.reportedAt,
    },
    artifact: {
      kind: "preview",
      ref: preview.ref,
      mediaType: preview.mediaType,
      sha256: preview.sha256,
    },
    maxBytes: MAX_PREVIEW_ARTIFACT_BYTES_V1,
  })
  const readBody = JSON.stringify(readRequest)

  const unsignedRead = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: readBody,
  })
  assert.equal(unsignedRead.status, 401)

  const firstRead = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: {
      ...signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, readBody),
      origin: allowedOrigin,
    },
    body: readBody,
  })
  assert.equal(firstRead.status, 200)
  assert.match(firstRead.headers.get("content-type") || "", /^application\/json/)
  assert.equal(firstRead.headers.get("cache-control"), "no-store")
  assert.equal(firstRead.headers.get("access-control-allow-origin"), null)
  const readResponse = await firstRead.json()
  const validatedRead = validateArtifactReadResponseV1(readRequest, readResponse)
  assert.equal(validatedRead.success, true)
  assert.equal(validatedRead.response.artifact.relativePath, "index.html")
  assert.deepEqual(
    Buffer.from(validatedRead.response.artifact.bytesBase64, "base64"),
    previewBytes,
  )

  const repeatRead = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, readBody),
    body: readBody,
  })
  assert.equal(repeatRead.status, 200)

  const replayNonce = randomUUID()
  const replayHeaders = signedRuntimeHeaders(
    ARTIFACT_READ_PATH_V1,
    readBody,
    replayNonce,
  )
  const nonceFirst = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: replayHeaders,
    body: readBody,
  })
  assert.equal(nonceFirst.status, 200)
  const nonceReplay = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: replayHeaders,
    body: readBody,
  })
  assert.equal(nonceReplay.status, 409)

  const conflictingReadBody = JSON.stringify({ ...readRequest, maxBytes: 1000 })
  const conflictingRead = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, conflictingReadBody),
    body: conflictingReadBody,
  })
  assert.equal(conflictingRead.status, 409)

  const wrongBindingBody = JSON.stringify({
    ...readRequest,
    readIdempotencyKey: "artifact-read:wrong-binding",
    binding: { ...readRequest.binding, projectId: "project:other" },
  })
  const wrongBinding = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, wrongBindingBody),
    body: wrongBindingBody,
  })
  assert.equal(wrongBinding.status, 404)
  assert.deepEqual(await wrongBinding.json(), { error: "artifact_unavailable" })

  const queriedRead = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}?ref=forbidden`, {
    method: "POST",
    headers: signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, readBody),
    body: readBody,
  })
  assert.equal(queriedRead.status, 404)

  const oversizedWireBody = `${readBody}${" ".repeat(MAX_ARTIFACT_READ_REQUEST_BYTES_V1)}`
  const oversizedWire = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, oversizedWireBody),
    body: oversizedWireBody,
  })
  assert.equal(oversizedWire.status, 413)
  assert.deepEqual(await oversizedWire.json(), { error: "invalid_request" })

  await writeFile(previewPath, "<!doctype html><html><body>tampered</body></html>")
  const tamperedBody = JSON.stringify({
    ...readRequest,
    readIdempotencyKey: "artifact-read:tampered",
  })
  const tamperedRead = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, tamperedBody),
    body: tamperedBody,
  })
  assert.equal(tamperedRead.status, 404)

  await writeFile(previewPath, Buffer.alloc(MAX_PREVIEW_ARTIFACT_BYTES_V1 + 1, 0x61))
  const oversizedArtifactBody = JSON.stringify({
    ...readRequest,
    readIdempotencyKey: "artifact-read:oversized-artifact",
  })
  const oversizedArtifact = await fetch(`${baseUrl}${ARTIFACT_READ_PATH_V1}`, {
    method: "POST",
    headers: signedRuntimeHeaders(ARTIFACT_READ_PATH_V1, oversizedArtifactBody),
    body: oversizedArtifactBody,
  })
  assert.equal(oversizedArtifact.status, 404)

  console.log("PASS artifact read: exact signed binding, bounded bytes, hash and idempotency")
} finally {
  await new Promise<void>((resolve, reject) => {
    artifactServer.close((error) => (error ? reject(error) : resolve()))
  })
  await rm(artifactTestRoot, { recursive: true, force: true })
}
