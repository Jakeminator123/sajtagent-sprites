import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const SIGNATURE_HEADERS_V1 = {
  timestamp: "x-siteagent-timestamp",
  nonce: "x-siteagent-nonce",
  signature: "x-siteagent-signature",
} as const

export type RuntimeSignatureInputV1 = {
  method: string
  pathname: string
  timestamp: string
  nonce: string
  body: string
}

export function runtimeSignaturePayloadV1(input: RuntimeSignatureInputV1): string {
  const bodyDigest = createHash("sha256").update(input.body).digest("hex")
  return [
    "siteagent-runtime-v1",
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.pathname,
    bodyDigest,
  ].join("\n")
}

export function signRuntimeRequestV1(
  input: RuntimeSignatureInputV1,
  signingKey: string,
): string {
  if (signingKey.length < 32) {
    throw new Error("Runtime signing key must contain at least 32 characters")
  }
  return createHmac("sha256", signingKey)
    .update(runtimeSignaturePayloadV1(input))
    .digest("hex")
}

export function verifyRuntimeSignatureV1(
  input: RuntimeSignatureInputV1 & { signature: string },
  signingKey: string,
  options: { now?: number; maxClockSkewMs?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!/^[A-Za-z0-9._:-]{16,160}$/.test(input.nonce)) {
    return { ok: false, reason: "Invalid nonce" }
  }
  const timestamp = Date.parse(input.timestamp)
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "Invalid timestamp" }
  }
  const now = options.now ?? Date.now()
  const maxClockSkewMs = options.maxClockSkewMs ?? 5 * 60_000
  if (Math.abs(now - timestamp) > maxClockSkewMs) {
    return { ok: false, reason: "Expired signature timestamp" }
  }
  if (!/^[a-f0-9]{64}$/.test(input.signature)) {
    return { ok: false, reason: "Invalid signature format" }
  }

  const expected = Buffer.from(signRuntimeRequestV1(input, signingKey), "hex")
  const received = Buffer.from(input.signature, "hex")
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "Signature mismatch" }
  }
  return { ok: true }
}
