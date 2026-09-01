import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { pathToFileURL } from "node:url"

import {
  AgentProfileV1Schema,
  DEFAULT_LOCAL_AGENT_CEILING_V1,
  compilePortableOpenClawBundleV1,
  type AgentHostCeilingV1,
} from "../contracts/agent-profile-v1.ts"
import {
  BuildJobV1Schema,
  WorkerReportV1Schema,
} from "../contracts/builder-v1.ts"
import {
  SIGNATURE_HEADERS_V1,
  verifyRuntimeSignatureV1,
} from "./signing.ts"

const MAX_BODY_BYTES = 512 * 1024
const NONCE_RETENTION_MS = 10 * 60_000
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
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
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

  if (!isLoopbackHost(host) && (!signingKey || signingKey.length < 32)) {
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
  }
}

export function createRuntimeServer(options: RuntimeServerOptions) {
  const usedNonces = new Map<string, number>()

  function requireSignature(
    request: IncomingMessage,
    pathname: string,
    body: string,
  ): { ok: true } | { ok: false; status: number; reason: string } {
    if (!options.signingKey) {
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
        sendJson(
          response,
          200,
          {
            service: "sajtagent-sprites-runtime",
            mode: "local-compile-only",
            openClawConnected: false,
            signedJobsEnabled: Boolean(options.signingKey),
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

      if (request.method === "POST" && url.pathname === "/v1/build-jobs") {
        const body = await readBody(request)
        const signed = requireSignature(request, url.pathname, body)
        if (!signed.ok) {
          sendJson(response, signed.status, { error: "unauthorized", message: signed.reason }, corsHeaders)
          return
        }
        const job = BuildJobV1Schema.parse(JSON.parse(body))
        const report = WorkerReportV1Schema.parse({
          schemaVersion: 1,
          status: "failed",
          jobId: job.jobId,
          sourceRunId: `local:${job.jobId}`,
          baseRevisionId: job.baseRevisionId,
          receipts: [],
          diagnostics: [
            {
              code: "openclaw_not_connected",
              message:
                "Profilkompilatorn är redo, men ingen OpenClaw Gateway är ansluten. Jobbet kan inte rapporteras som lyckat.",
              retryable: true,
            },
          ],
          reportedAt: new Date().toISOString(),
        })
        sendJson(response, 503, report, corsHeaders)
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
  const server = createRuntimeServer(options)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : options.port
  console.log(`sajtagent-sprites-runtime listening on http://${options.host}:${port}`)
  console.log("mode=local-compile-only openclawConnected=false")
  return server
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (invokedPath === import.meta.url) {
  await startRuntimeServer()
}
