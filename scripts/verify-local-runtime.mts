import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionsCreateParamsSchema,
  SessionsPatchParamsSchema,
} from "@openclaw/gateway-protocol"
import { Value } from "typebox/value"

import {
  DEFAULT_AGENT_PROFILE_V1,
  DEFAULT_LOCAL_AGENT_CEILING_V1,
} from "../contracts/agent-profile-v1.ts"
import {
  AGENT_PROFILE_ACTIVATION_PATH_V1,
  AgentProfileActivationReceiptV1Schema,
} from "../contracts/agent-profile-activation-v1.ts"
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
import { BuildJobV1Schema, WorkerReportV1Schema } from "../contracts/builder-v1.ts"
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
  compileBuildWorkspaceToolPolicyV1,
  createBuildWorkspaceSessionParamsV1,
  deriveAgentTurnSessionCreateIdempotencyKeyV1,
  deriveAgentTurnSessionLabelV1,
  deriveAgentTurnSessionKeyV1,
  findBuildRequestToolCallIdInHistoryV1,
  resolveBuildRequestHistoryBaselineV1,
  hasRegisteredBuildRequestToolV1,
  OPENCLAW_AGENT_TURN_PARENT_SESSION_KEY_V1,
  patchBuildWorkspaceSessionParamsV1,
  type BuildJobRunnerV1,
} from "../src/openclaw-gateway.ts"
import {
  SIGNATURE_HEADERS_V1,
  signRuntimeRequestV1,
} from "../src/signing.ts"
import { materializeOpenClawProfileV1 } from "../src/materialize-profile.ts"
import {
  candidateRevisionIdV1,
  inspectBuildWorkspaceV1,
  parseGitStatusPathsV1,
  prepareBuildWorkspaceV1,
  recordBuildWorkspaceCandidateV1,
} from "../src/workspace.ts"
import {
  MAX_AGENT_EVENT_SSE_BYTES_V1,
  MAX_AGENT_TURN_EVENTS_V1,
  MAX_AGENT_TURN_SSE_BYTES_V1,
  assertRuntimeAgentTurnSupportedV1,
  compileAgentTurnOpenClawToolPolicyV1,
  compileBuildRequestOpenClawToolPolicyV1,
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
assert.deepEqual(compileBuildRequestOpenClawToolPolicyV1(), {
  inheritedToolPolicyVersion: 1,
  inheritedToolAllow: ["siteagent_build_request", "build.request"],
  inheritedToolDeny: [],
})
assert.deepEqual(compileBuildWorkspaceToolPolicyV1(), {
  inheritedToolPolicyVersion: 1,
  inheritedToolDeny: ["exec", "process"],
})
const buildSessionCreateParams = createBuildWorkspaceSessionParamsV1({
  sessionKey: "agent:main:sajtagent-build-protocol-test",
  idempotencyKey: "session:build-protocol-test",
  label: "Sajtagent build protocol test",
  model: "openai/gpt-5.6-terra",
  thinkingLevel: "medium",
  permissionMode: "guarded",
  webSearch: false,
  cwd: process.cwd(),
})
assert.equal(Value.Check(SessionsCreateParamsSchema, buildSessionCreateParams), true)
assert.equal(
  buildSessionCreateParams.parentSessionKey,
  OPENCLAW_AGENT_TURN_PARENT_SESSION_KEY_V1,
)
assert.equal("inheritedToolDeny" in buildSessionCreateParams, false)
const buildSessionPatchParams = patchBuildWorkspaceSessionParamsV1({
  sessionKey: buildSessionCreateParams.key,
  model: "openai/gpt-5.6-terra",
  thinkingLevel: "medium",
  reasoningLevel: "off",
  permissionMode: "guarded",
})
assert.equal(Value.Check(SessionsPatchParamsSchema, buildSessionPatchParams), true)
assert.deepEqual(buildSessionPatchParams.inheritedToolDeny, ["exec", "process"])
assert.deepEqual(
  compileAgentTurnOpenClawToolPolicyV1([
    "conversation.respond",
    "build.request",
  ]),
  compileBuildRequestOpenClawToolPolicyV1(),
)
assert.throws(
  () => compileAgentTurnOpenClawToolPolicyV1([
    "conversation.respond",
    "project.read",
    "build.request",
  ]),
  /agent_turn_tool_policy_not_supported/,
)
assert.equal(hasRegisteredBuildRequestToolV1(
  {
    plugins: [{
      id: "siteagent-build-request",
      installed: true,
      enabled: true,
      state: "enabled",
    }],
  },
  {
    groups: [{
      source: "plugin",
      pluginId: "siteagent-build-request",
      tools: [{ id: "siteagent_build_request", source: "plugin" }],
    }],
  },
), true)
assert.equal(hasRegisteredBuildRequestToolV1(
  {
    plugins: [{
      id: "siteagent-build-request",
      installed: true,
      enabled: false,
      state: "disabled",
    }],
  },
  {
    groups: [{
      source: "plugin",
      pluginId: "siteagent-build-request",
      tools: [{ id: "siteagent_build_request", source: "plugin" }],
    }],
  },
), false)
const privateAgentTurnSessionKey = deriveAgentTurnSessionKeyV1(
  "project:test",
  "session:abcdefghijklmnopqrstuvwxyzABCDEF",
)
assert.match(
  privateAgentTurnSessionKey,
  /^agent:main:subagent:sajtagent-session-v2-[A-Za-z0-9_-]{32}$/,
)
assert.doesNotMatch(privateAgentTurnSessionKey, /project:test|abcdefghijkl/)
const privateAgentTurnSessionLabel = deriveAgentTurnSessionLabelV1(
  "project:test",
  "session:abcdefghijklmnopqrstuvwxyzABCDEF",
)
assert.match(
  privateAgentTurnSessionLabel,
  /^Sajtagent session v2 [A-Za-z0-9_-]{32}$/,
)
assert.doesNotMatch(privateAgentTurnSessionLabel, /project:test|abcdefghijkl/)
const privateAgentTurnSessionCreateIdempotencyKey =
  deriveAgentTurnSessionCreateIdempotencyKeyV1(
    "project:test",
    "session:abcdefghijklmnopqrstuvwxyzABCDEF",
  )
assert.match(
  privateAgentTurnSessionCreateIdempotencyKey,
  /^session:v2:[A-Za-z0-9_-]{32}$/,
)
assert.doesNotMatch(
  privateAgentTurnSessionCreateIdempotencyKey,
  /project:test|abcdefghijkl/,
)
assert.equal(
  OPENCLAW_AGENT_TURN_PARENT_SESSION_KEY_V1,
  "agent:main:sajtagent-controller-v1",
)
let fakeBuildRequestToolRegistered = true
const fakeTurnRunner = {
  async health() {
    return {
      connected: true,
      runtimeVersion: "openclaw-test",
      buildRequestToolRegistered: fakeBuildRequestToolRegistered,
      ...(fakeBuildRequestToolRegistered
        ? {}
        : {
            buildRequestToolReason:
              "openclaw_build_request_tool_not_registered",
          }),
    }
  },
  async runTurn(input, emit) {
    if (input.policy.capabilities.includes("build.request")) {
      if (input.turn.message === "invalid handoff") {
        return { outcome: "build_handoff", toolCallId: "tool:missing" } as const
      }
      emit({
        type: "tool.started",
        payload: {
          toolCallId: "tool:build-request-local-test",
          capability: "build.request",
          safeLabel: "siteagent_build_request",
        },
      })
      return {
        outcome: "build_handoff",
        toolCallId: "tool:build-request-local-test",
      } as const
    }
    emit({ type: "agent.status", payload: { state: "thinking" } })
    emit({
      type: "message.delta",
      payload: { messageId: "message:local-test", delta: "Hej från OpenClaw" },
    })
    emit({ type: "turn.completed", payload: { outcome: "answered" } })
    return { outcome: "terminal" } as const
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
const activationWorkspace = await mkdtemp(
  join(tmpdir(), "siteagent-openclaw-active-profile-"),
)
await materializeOpenClawProfileV1({ outputDir: activationWorkspace })
const server = createRuntimeServer({
  host: "127.0.0.1",
  port: 0,
  signingKey,
  allowedOrigins: [allowedOrigin],
  ceiling: DEFAULT_LOCAL_AGENT_CEILING_V1,
  turnRunner: fakeTurnRunner,
  openClawWorkspaceDir: activationWorkspace,
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
    buildRequestHandoffEnabled: boolean
    artifactReadEnabled: boolean
    agentProfileActivationContractVersion: number
    agentProfileActivationEnabled: boolean
  }
  assert.equal(healthBody.openClawConnected, false)
  assert.equal(healthBody.agentSessionContractVersion, 1)
  assert.equal(healthBody.agentTurnStreamTransport, "sse")
  assert.equal(healthBody.agentTurnStreamEnabled, true)
  assert.deepEqual(healthBody.agentTurnCapabilities, [
    "conversation.respond",
    "build.request",
  ])
  assert.equal(healthBody.buildRequestHandoffEnabled, true)
  assert.equal(healthBody.artifactReadEnabled, false)
  assert.equal(healthBody.agentProfileActivationContractVersion, 1)
  assert.equal(healthBody.agentProfileActivationEnabled, true)

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

  const activatedProfile = {
    ...structuredClone(DEFAULT_AGENT_PROFILE_V1),
    revision: 2,
    updatedAt: new Date().toISOString(),
    identity: {
      ...DEFAULT_AGENT_PROFILE_V1.identity,
      name: "Aktiverad Sajtagent",
    },
  }
  const activationRequest = {
    schemaVersion: 1 as const,
    activationId: "activation:local-test-2",
    idempotencyKey: "activation-idempotency:local-test-2",
    requestedAt: new Date().toISOString(),
    expectedActiveRevision: 1,
    profile: activatedProfile,
  }
  const activationBody = JSON.stringify(activationRequest)
  const unsignedActivation = await fetch(
    `${baseUrl}${AGENT_PROFILE_ACTIVATION_PATH_V1}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: activationBody,
    },
  )
  assert.equal(unsignedActivation.status, 401)

  const activated = await fetch(
    `${baseUrl}${AGENT_PROFILE_ACTIVATION_PATH_V1}`,
    {
      method: "POST",
      headers: signedRuntimeHeaders(
        AGENT_PROFILE_ACTIVATION_PATH_V1,
        activationBody,
      ),
      body: activationBody,
    },
  )
  assert.equal(activated.status, 200)
  const activationReceipt = AgentProfileActivationReceiptV1Schema.parse(
    await activated.json(),
  )
  assert.equal(activationReceipt.profileId, activatedProfile.profileId)
  assert.equal(activationReceipt.revision, 2)
  assert.equal(activationReceipt.takesEffect, "next-run")
  assert.match(
    await readFile(join(activationWorkspace, "SOUL.md"), "utf8"),
    /Aktiverad Sajtagent/,
  )

  const repeatedActivation = await fetch(
    `${baseUrl}${AGENT_PROFILE_ACTIVATION_PATH_V1}`,
    {
      method: "POST",
      headers: signedRuntimeHeaders(
        AGENT_PROFILE_ACTIVATION_PATH_V1,
        activationBody,
      ),
      body: activationBody,
    },
  )
  assert.equal(repeatedActivation.status, 200)
  const repeatedReceipt = AgentProfileActivationReceiptV1Schema.parse(
    await repeatedActivation.json(),
  )
  assert.equal(repeatedReceipt.activatedAt, activationReceipt.activatedAt)

  const conflictingActivationBody = JSON.stringify({
    ...activationRequest,
    profile: {
      ...activatedProfile,
      revision: 3,
      operatingInstructions: "Annat innehåll med återanvänd idempotencyKey.",
    },
  })
  const conflictingActivation = await fetch(
    `${baseUrl}${AGENT_PROFILE_ACTIVATION_PATH_V1}`,
    {
      method: "POST",
      headers: signedRuntimeHeaders(
        AGENT_PROFILE_ACTIVATION_PATH_V1,
        conflictingActivationBody,
      ),
      body: conflictingActivationBody,
    },
  )
  assert.equal(conflictingActivation.status, 409)

  const staleActivationBody = JSON.stringify({
    ...activationRequest,
    activationId: "activation:local-test-stale",
    idempotencyKey: "activation-idempotency:local-test-stale",
    expectedActiveRevision: 1,
    profile: {
      ...activatedProfile,
      revision: 3,
    },
  })
  const staleActivation = await fetch(
    `${baseUrl}${AGENT_PROFILE_ACTIVATION_PATH_V1}`,
    {
      method: "POST",
      headers: signedRuntimeHeaders(
        AGENT_PROFILE_ACTIVATION_PATH_V1,
        staleActivationBody,
      ),
      body: staleActivationBody,
    },
  )
  assert.equal(staleActivation.status, 409)
  assert.equal(
    (await staleActivation.json() as { activeRevision?: number }).activeRevision,
    2,
  )

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

  const questionResume = structuredClone(directTurn)
  questionResume.turn.replyToQuestionId = "question:local-test"
  questionResume.turn.answerSelections = ["Ja"]
  assert.throws(
    () => assertRuntimeAgentTurnSupportedV1(questionResume),
    /agent_question_resume_not_implemented/,
  )

  const supportedBuildTurn = structuredClone(directTurn)
  supportedBuildTurn.turn.turnId = "turn:build-handoff-local"
  supportedBuildTurn.turn.idempotencyKey = "idempotency:build-handoff-local"
  supportedBuildTurn.turn.message = "Bygg en hero"
  supportedBuildTurn.policy.turnId = supportedBuildTurn.turn.turnId
  supportedBuildTurn.policy.capabilities = [
    "conversation.respond",
    "build.request",
  ]
  supportedBuildTurn.policy.allowedMutationIntents = ["site.change"]
  supportedBuildTurn.policy.maxToolCalls = 1
  supportedBuildTurn.baseSequence = 44
  assert.doesNotThrow(() => assertRuntimeAgentTurnSupportedV1(supportedBuildTurn))

  const multiIntentBuildTurn = structuredClone(supportedBuildTurn)
  multiIntentBuildTurn.turn.turnId = "turn:multi-intent-local"
  multiIntentBuildTurn.turn.idempotencyKey = "idempotency:multi-intent-local"
  multiIntentBuildTurn.policy.turnId = multiIntentBuildTurn.turn.turnId
  multiIntentBuildTurn.policy.allowedMutationIntents = [
    "site.create",
    "site.change",
  ]
  assert.throws(
    () => assertRuntimeAgentTurnSupportedV1(multiIntentBuildTurn),
    /agent_turn_capability_not_implemented/,
  )
  const extraCapabilityBuildTurn = structuredClone(supportedBuildTurn)
  extraCapabilityBuildTurn.policy.capabilities.push("project.read")
  assert.throws(
    () => assertRuntimeAgentTurnSupportedV1(extraCapabilityBuildTurn),
    /agent_turn_capability_not_implemented/,
  )
  const zeroToolBuildTurn = structuredClone(supportedBuildTurn)
  zeroToolBuildTurn.policy.maxToolCalls = 0
  assert.throws(
    () => assertRuntimeAgentTurnSupportedV1(zeroToolBuildTurn),
    /agent_turn_capability_not_implemented/,
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

  const buildTurnBody = JSON.stringify(supportedBuildTurn)
  const buildTurnResponse = await fetch(`${baseUrl}/v1/agent-turns`, {
    method: "POST",
    headers: signedRuntimeHeaders("/v1/agent-turns", buildTurnBody),
    body: buildTurnBody,
  })
  assert.equal(buildTurnResponse.status, 200)
  const buildFrames = (await buildTurnResponse.text()).trim().split("\n\n")
  const buildEvents = buildFrames.map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))
    assert(data)
    return AgentEventV1Schema.parse(JSON.parse(data.slice("data: ".length)))
  })
  assert.deepEqual(buildEvents.map((event) => event.sequence), [45, 46])
  assert.deepEqual(buildEvents.map((event) => event.type), [
    "turn.accepted",
    "tool.started",
  ])
  const buildHandoffEvent = buildEvents[1]
  assert.equal(
    buildHandoffEvent?.type === "tool.started"
      ? buildHandoffEvent.payload.capability
      : undefined,
    "build.request",
  )
  assert.equal(validateAgentTurnAgainstPolicyV1(
    supportedBuildTurn.session,
    supportedBuildTurn.policy,
    buildEvents,
    { baseSequence: supportedBuildTurn.baseSequence, requireTerminal: false },
  ).success, true)

  const multiIntentBody = JSON.stringify(multiIntentBuildTurn)
  const multiIntentResponse = await fetch(`${baseUrl}/v1/agent-turns`, {
    method: "POST",
    headers: signedRuntimeHeaders("/v1/agent-turns", multiIntentBody),
    body: multiIntentBody,
  })
  assert.equal(multiIntentResponse.status, 409)

  const unavailableBuildTurn = structuredClone(supportedBuildTurn)
  unavailableBuildTurn.turn.turnId = "turn:unavailable-handoff-local"
  unavailableBuildTurn.turn.idempotencyKey =
    "idempotency:unavailable-handoff-local"
  unavailableBuildTurn.policy.turnId = unavailableBuildTurn.turn.turnId
  const unavailableBuildBody = JSON.stringify(unavailableBuildTurn)
  fakeBuildRequestToolRegistered = false
  const degradedHealthResponse = await fetch(`${baseUrl}/health`)
  const degradedHealth = await degradedHealthResponse.json() as {
    agentTurnCapabilities: string[]
    buildRequestHandoffEnabled: boolean
    buildRequestHandoffReason?: string
  }
  assert.deepEqual(degradedHealth.agentTurnCapabilities, [
    "conversation.respond",
  ])
  assert.equal(degradedHealth.buildRequestHandoffEnabled, false)
  assert.equal(
    degradedHealth.buildRequestHandoffReason,
    "openclaw_build_request_tool_not_registered",
  )
  const unavailableBuildResponse = await fetch(`${baseUrl}/v1/agent-turns`, {
    method: "POST",
    headers: signedRuntimeHeaders(
      "/v1/agent-turns",
      unavailableBuildBody,
    ),
    body: unavailableBuildBody,
  })
  assert.equal(unavailableBuildResponse.status, 503)
  assert.equal(
    (await unavailableBuildResponse.json() as { error: string }).error,
    "agent_build_request_handoff_unavailable",
  )
  fakeBuildRequestToolRegistered = true

  const invalidHandoffTurn = structuredClone(supportedBuildTurn)
  invalidHandoffTurn.turn.turnId = "turn:invalid-handoff-local"
  invalidHandoffTurn.turn.idempotencyKey = "idempotency:invalid-handoff-local"
  invalidHandoffTurn.turn.message = "invalid handoff"
  invalidHandoffTurn.policy.turnId = invalidHandoffTurn.turn.turnId
  invalidHandoffTurn.baseSequence = 60
  const invalidHandoffBody = JSON.stringify(invalidHandoffTurn)
  const invalidHandoffResponse = await fetch(`${baseUrl}/v1/agent-turns`, {
    method: "POST",
    headers: signedRuntimeHeaders("/v1/agent-turns", invalidHandoffBody),
    body: invalidHandoffBody,
  })
  assert.equal(invalidHandoffResponse.status, 200)
  const invalidHandoffEvents = (await invalidHandoffResponse.text())
    .trim()
    .split("\n\n")
    .map((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))
      assert(data)
      return AgentEventV1Schema.parse(JSON.parse(data.slice("data: ".length)))
    })
  assert.deepEqual(invalidHandoffEvents.map((event) => event.type), [
    "turn.accepted",
    "turn.failed",
  ])

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

  const buildNormalizerContext = {
    runId: "openclaw-run:build-test",
    turnId: supportedBuildTurn.turn.turnId,
    capabilities: supportedBuildTurn.policy.capabilities,
    state: createOpenClawAgentNormalizerStateV1(),
  }
  const normalizedBuildRequest = normalizeOpenClawGatewayEventV1({
    event: "agent",
    payload: {
      runId: "openclaw-run:build-test",
      seq: 0,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "start",
        name: "siteagent_build_request",
        toolCallId: "upstream-build-call",
      },
    },
  }, buildNormalizerContext)[0]
  assert.equal(normalizedBuildRequest?.type, "tool.started")
  assert.equal(
    normalizedBuildRequest?.type === "tool.started"
      ? normalizedBuildRequest.payload.capability
      : undefined,
    "build.request",
  )
  assert.throws(() => normalizeOpenClawGatewayEventV1({
    event: "agent",
    payload: {
      runId: "openclaw-run:build-test",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "start",
        name: "build.request",
        toolCallId: "duplicate-upstream-build-call",
      },
    },
  }, buildNormalizerContext), /openclaw_duplicate_build_request/)

  const transcriptBuildRequestToolCallId =
    findBuildRequestToolCallIdInHistoryV1([
      {
        sessionKey: "agent:main:subagent:test",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            name: "siteagent_build_request",
            id: "transcript-build-call",
          }],
        },
      },
      {
        role: "toolResult",
        toolName: "siteagent_build_request",
        toolCallId: "transcript-build-call",
      },
    ])
  assert.match(transcriptBuildRequestToolCallId || "", /^tool:[A-Za-z0-9_-]{24}$/)
  assert.equal(findBuildRequestToolCallIdInHistoryV1([
    { role: "assistant", content: [{ type: "text", text: "ingen handoff" }] },
  ]), undefined)
  assert.throws(() => findBuildRequestToolCallIdInHistoryV1([
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "siteagent_build_request", id: "one" },
        { type: "toolCall", name: "build.request", toolCallId: "two" },
      ],
    },
  ]), /openclaw_duplicate_build_request/)
  assert.deepEqual(
    resolveBuildRequestHistoryBaselineV1({ messages: [] }),
    { kind: "empty" },
  )
  assert.deepEqual(
    resolveBuildRequestHistoryBaselineV1({
      messages: [],
      deltaCursor: "cursor:fresh-session",
    }),
    { kind: "cursor", cursor: "cursor:fresh-session" },
  )
  assert.throws(
    () => resolveBuildRequestHistoryBaselineV1({
      messages: [{ role: "assistant", content: [] }],
    }),
    /openclaw_build_request_history_cursor_missing/,
  )

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

  console.log(
    "PASS local runtime: profile activation, signed fail-closed flow and Luna/Terra/Sol routing",
  )
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  await rm(activationWorkspace, { recursive: true, force: true })
}

const revisionBridgeRoot = await mkdtemp(join(tmpdir(), "siteagent-revision-bridge-"))
try {
  const projectsRoot = join(revisionBridgeRoot, "projects")
  const bridgeWorkersRoot = join(revisionBridgeRoot, "workers")
  const createdAt = new Date()
  const initialJob = BuildJobV1Schema.parse({
    schemaVersion: 1,
    jobId: "job:revision-bridge-initial",
    tenantId: "tenant:revision-bridge",
    projectId: "project:revision-bridge",
    baseRevisionId: "revision:initial:revision-bridge",
    idempotencyKey: "idempotency:revision-bridge-initial",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
    intent: {
      schemaVersion: 1,
      intentType: "site.create",
      message: "Skapa den första statiska sajten",
      context: {},
    },
    executionPolicy: {
      deadlineAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
      maxSteps: 20,
      maxToolCalls: 40,
      maxModelTokens: 20_000,
      maxCostMicros: 100_000,
      capabilities: ["workspace.read", "workspace.write", "preview.manage"],
      network: { mode: "deny-all" },
      packages: { mode: "deny" },
    },
  })
  const digestBase = "a".repeat(40)
  const digestTree = "b".repeat(40)
  assert.notEqual(
    candidateRevisionIdV1(
      { tenantId: initialJob.tenantId, projectId: initialJob.projectId },
      digestBase,
      digestTree,
    ),
    candidateRevisionIdV1(
      { tenantId: initialJob.tenantId, projectId: "project:other" },
      digestBase,
      digestTree,
    ),
  )
  const initialWorkspace = await prepareBuildWorkspaceV1(initialJob, {
    projectsRoot,
    workersRoot: bridgeWorkersRoot,
  })
  assert.notEqual(initialWorkspace.baseCommit, initialJob.baseRevisionId)
  assert.match(
    await readFile(join(initialWorkspace.workerDir, "index.html"), "utf8"),
    /Din nya sajt/,
  )
  await assert.rejects(readFile(join(initialWorkspace.workerDir, ".git")))
  await writeFile(
    join(initialWorkspace.workerDir, ".gitmodules"),
    "[submodule \"unsafe\"]\n\tpath = unsafe\n\turl = https://example.invalid/unsafe.git\n",
  )
  await assert.rejects(
    inspectBuildWorkspaceV1(initialWorkspace),
    /förbjuden workspace-sökväg/,
  )
  await rm(join(initialWorkspace.workerDir, ".gitmodules"))

  const outsideWorkspace = join(revisionBridgeRoot, "outside-workspace")
  await mkdir(outsideWorkspace)
  await writeFile(
    join(outsideWorkspace, "outside.html"),
    "<!doctype html><html><body>must not be captured</body></html>",
  )
  const linkedDirectory = join(initialWorkspace.workerDir, "linked-directory")
  await symlink(
    outsideWorkspace,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  )
  await assert.rejects(
    inspectBuildWorkspaceV1(initialWorkspace),
    /symlink eller annan otillåten filtyp/,
  )
  await rm(linkedDirectory)

  const firstCandidateHtml =
    "<!doctype html><html><body><h1>Första accepterade bygget</h1></body></html>"
  await writeFile(join(initialWorkspace.workerDir, "index.html"), firstCandidateHtml)
  const packageJsonPath = join(initialWorkspace.workerDir, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    scripts: Record<string, string>
  }
  packageJson.scripts.check =
    "node -e \"require('node:fs').writeFileSync('runtime-check-marker','unsafe')\""
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
  const inspected = await inspectBuildWorkspaceV1(initialWorkspace)
  assert.deepEqual(inspected.changedPaths, ["index.html", "package.json"])
  const firstProjection = await recordBuildWorkspaceCandidateV1(
    initialWorkspace,
    { tenantId: initialJob.tenantId, projectId: initialJob.projectId },
  )
  assert.match(firstProjection.candidateRevisionId, /^revision:sha256:[a-f0-9]{64}$/u)
  assert.deepEqual(firstProjection.changedPaths, ["index.html", "package.json"])
  assert.equal(firstProjection.preview?.path, "index.html")
  assert.match(firstProjection.check.snapshotSha256, /^[a-f0-9]{64}$/u)
  await assert.rejects(
    readFile(join(initialWorkspace.workerDir, "runtime-check-marker")),
  )

  const secondJob = BuildJobV1Schema.parse({
    ...initialJob,
    jobId: "job:revision-bridge-second",
    baseRevisionId: firstProjection.candidateRevisionId,
    idempotencyKey: "idempotency:revision-bridge-second",
    intent: {
      ...initialJob.intent,
      intentType: "site.change",
      message: "Fortsätt från det första accepterade bygget",
    },
  })
  const secondWorkspace = await prepareBuildWorkspaceV1(secondJob, {
    projectsRoot,
    workersRoot: bridgeWorkersRoot,
  })
  assert.equal(secondWorkspace.baseCommit, firstProjection.candidateCommit)
  assert.equal(
    await readFile(join(secondWorkspace.workerDir, "index.html"), "utf8"),
    firstCandidateHtml,
  )
  assert.notEqual(secondWorkspace.workerDir, initialWorkspace.workerDir)

  const missingProjectJob = BuildJobV1Schema.parse({
    ...secondJob,
    jobId: "job:revision-bridge-missing",
    projectId: "project:revision-bridge-missing",
    idempotencyKey: "idempotency:revision-bridge-missing",
  })
  await assert.rejects(
    prepareBuildWorkspaceV1(missingProjectJob, {
      projectsRoot,
      workersRoot: bridgeWorkersRoot,
    }),
    /serverägda Git-checkout finns inte/,
  )
  console.log(
    "PASS revision bridge: signed site.create bootstrap and accepted candidate base",
  )
} finally {
  await rm(revisionBridgeRoot, { recursive: true, force: true })
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
      candidateRevisionId: `revision:sha256:${"1".repeat(64)}`,
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
