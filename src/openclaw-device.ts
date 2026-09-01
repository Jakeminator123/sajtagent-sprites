import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type {
  DeviceIdentity,
  GatewayClientHostDeps,
} from "@openclaw/gateway-client"

type StoredDeviceAuth = {
  deviceId: string
  roles: Record<string, { token: string; scopes: string[] }>
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })
  if (der.length < 32) throw new Error("Invalid Ed25519 public key")
  return der.subarray(der.length - 32)
}

export function createRuntimeGatewayHostDepsV1(stateDir: string): GatewayClientHostDeps {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const identityPath = join(stateDir, "device.json")
  const authPath = join(stateDir, "device-auth.json")

  const loadOrCreateDeviceIdentity = (): DeviceIdentity => {
    const existing = readJson<DeviceIdentity>(identityPath)
    if (existing?.deviceId && existing.privateKeyPem && existing.publicKeyPem) return existing

    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString()
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const deviceId = createHash("sha256").update(rawPublicKey(publicKeyPem)).digest("hex")
    const identity = { deviceId, privateKeyPem, publicKeyPem }
    writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 })
    return identity
  }

  return {
    loadOrCreateDeviceIdentity,
    signDevicePayload: (privateKeyPem, payload) =>
      sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url"),
    publicKeyRawBase64UrlFromPem: (publicKeyPem) => rawPublicKey(publicKeyPem).toString("base64url"),
    loadDeviceAuthToken: ({ deviceId, role }) => {
      const stored = readJson<StoredDeviceAuth>(authPath)
      if (stored?.deviceId !== deviceId) return null
      return stored.roles[role] || null
    },
    storeDeviceAuthToken: ({ deviceId, role, token, scopes }) => {
      const current = readJson<StoredDeviceAuth>(authPath)
      const roles = current?.deviceId === deviceId ? current.roles : {}
      writeFileSync(
        authPath,
        `${JSON.stringify({ deviceId, roles: { ...roles, [role]: { token, scopes } } })}\n`,
        { mode: 0o600 },
      )
    },
    clearDeviceAuthToken: ({ deviceId, role }) => {
      const current = readJson<StoredDeviceAuth>(authPath)
      if (current?.deviceId !== deviceId) return
      const roles = { ...current.roles }
      delete roles[role]
      writeFileSync(authPath, `${JSON.stringify({ deviceId, roles })}\n`, { mode: 0o600 })
    },
  }
}
