import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_AGENT_PROFILE_V1,
  DEFAULT_LOCAL_AGENT_CEILING_V1,
} from "../contracts/agent-profile-v1.ts"
import {
  createRuntimeServer,
  resolveRuntimeServerOptions,
} from "../src/server.ts"
import { routeBuildJobModelV1 } from "../src/model-routing.ts"
import { compileSessionPermissionModeV1 } from "../src/openclaw-gateway.ts"
import {
  SIGNATURE_HEADERS_V1,
  signRuntimeRequestV1,
} from "../src/signing.ts"
import { materializeOpenClawProfileV1 } from "../src/materialize-profile.ts"
import { parseGitStatusPathsV1 } from "../src/workspace.ts"

const signingKey = "local-test-key-that-is-at-least-32-characters-long"
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
  assert.equal((await health.json() as { openClawConnected: boolean }).openClawConnected, false)

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
