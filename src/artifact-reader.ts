import { createHash } from "node:crypto"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  MAX_PREVIEW_ARTIFACT_BYTES_V1,
  type ArtifactReadBindingV1,
  type ArtifactReadResponseV1,
} from "../contracts/artifact-read-v1.ts"

const PREVIEW_REF_PATTERN =
  /^sprite-worktree:([a-f0-9]{32}):(\.siteagent-preview\.html|dist\/index\.html|build\/index\.html|index\.html)$/

type AuthorizedPreviewPathV1 = ArtifactReadResponseV1["artifact"]["relativePath"]

export type AuthorizedPreviewArtifactV1 = {
  binding: ArtifactReadBindingV1
  artifact: {
    kind: "preview"
    ref: string
    relativePath: AuthorizedPreviewPathV1
    mediaType: "text/html"
    sha256: string
  }
  expiresAt: number
}

export type PreviewArtifactBytesV1 = {
  bytes: Buffer
  sha256: string
  sizeBytes: number
}

export class ArtifactUnavailableError extends Error {
  constructor() {
    super("artifact_unavailable")
  }
}

function unavailable(): never {
  throw new ArtifactUnavailableError()
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate))
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  )
}

export function parseAuthorizedPreviewRefV1(
  ref: string,
): { workspaceId: string; relativePath: AuthorizedPreviewArtifactV1["artifact"]["relativePath"] } | null {
  const matched = PREVIEW_REF_PATTERN.exec(ref)
  const workspaceId = matched?.[1]
  const relativePath = matched?.[2]
  if (
    !workspaceId ||
    (relativePath !== ".siteagent-preview.html" &&
      relativePath !== "dist/index.html" &&
      relativePath !== "build/index.html" &&
      relativePath !== "index.html")
  ) {
    return null
  }
  return { workspaceId, relativePath }
}

export async function artifactReaderRootAvailableV1(workersRoot: string | undefined): Promise<boolean> {
  if (!workersRoot) return false
  try {
    const stats = await lstat(await realpath(workersRoot))
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

export async function readAuthorizedPreviewArtifactV1(
  workersRoot: string,
  authorization: AuthorizedPreviewArtifactV1,
  maxBytes: number,
): Promise<PreviewArtifactBytesV1> {
  if (
    Date.now() >= authorization.expiresAt ||
    maxBytes < 1 ||
    maxBytes > MAX_PREVIEW_ARTIFACT_BYTES_V1 ||
    authorization.artifact.kind !== "preview" ||
    authorization.artifact.mediaType !== "text/html" ||
    !/^[a-f0-9]{64}$/.test(authorization.artifact.sha256)
  ) {
    return unavailable()
  }

  const parsedRef = parseAuthorizedPreviewRefV1(authorization.artifact.ref)
  if (!parsedRef || parsedRef.relativePath !== authorization.artifact.relativePath) {
    return unavailable()
  }

  try {
    const realWorkersRoot = await realpath(workersRoot)
    const workerDir = join(realWorkersRoot, parsedRef.workspaceId)
    const realWorkerDir = await realpath(workerDir)
    if (!isContained(realWorkersRoot, realWorkerDir)) return unavailable()

    const artifactPath = join(realWorkerDir, authorization.artifact.relativePath)
    const pathStats = await lstat(artifactPath)
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) return unavailable()
    const realArtifactPath = await realpath(artifactPath)
    if (!isContained(realWorkerDir, realArtifactPath)) return unavailable()

    const handle = await open(realArtifactPath, "r")
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size < 1 || stats.size > maxBytes) {
        return unavailable()
      }
      const bytes = await handle.readFile()
      if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) return unavailable()
      let html: string
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(bytes).toLowerCase()
      } catch {
        return unavailable()
      }
      if (!html.includes("<html") && !html.includes("<!doctype html")) {
        return unavailable()
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      if (sha256 !== authorization.artifact.sha256) return unavailable()
      return { bytes, sha256, sizeBytes: bytes.byteLength }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof ArtifactUnavailableError) throw error
    return unavailable()
  }
}
