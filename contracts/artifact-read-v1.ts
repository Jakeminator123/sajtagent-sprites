import { createHash } from "node:crypto"

import { z } from "zod"

export const ARTIFACT_READ_CONTRACT_VERSION_V1 = 1 as const
export const ARTIFACT_READ_PATH_V1 = "/v1/artifacts/read" as const
export const MAX_ARTIFACT_READ_REQUEST_BYTES_V1 = 32 * 1024
export const MAX_PREVIEW_ARTIFACT_BYTES_V1 = 1024 * 1024
export const MAX_ARTIFACT_READ_RESPONSE_BYTES_V1 = 1_572_864

const IdentifierV1Schema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

export const CandidateRevisionIdV1Schema = z
  .string()
  .regex(/^revision:sha256:[a-f0-9]{64}$/)

const TimestampV1Schema = z.string().datetime({ offset: true })
const OpaqueRefV1Schema = z.string().min(1).max(512)
const Sha256V1Schema = z.string().regex(/^[a-f0-9]{64}$/)
const PreviewRelativePathV1Schema = z.enum([
  ".siteagent-preview.html",
  "dist/index.html",
  "build/index.html",
  "index.html",
])
const CanonicalBase64V1Schema = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_PREVIEW_ARTIFACT_BYTES_V1 / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

export const ArtifactReadBindingV1Schema = z
  .object({
    tenantId: IdentifierV1Schema,
    projectId: IdentifierV1Schema,
    jobId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    sourceRunId: IdentifierV1Schema,
    candidateRevisionId: CandidateRevisionIdV1Schema,
    reportedAt: TimestampV1Schema,
  })
  .strict()

export type ArtifactReadBindingV1 = z.infer<typeof ArtifactReadBindingV1Schema>

const RequestedPreviewArtifactV1Schema = z
  .object({
    kind: z.literal("preview"),
    ref: OpaqueRefV1Schema,
    mediaType: z.literal("text/html"),
    sha256: Sha256V1Schema,
  })
  .strict()

export const ArtifactReadRequestV1Schema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_READ_CONTRACT_VERSION_V1),
    readIdempotencyKey: IdentifierV1Schema,
    binding: ArtifactReadBindingV1Schema,
    artifact: RequestedPreviewArtifactV1Schema,
    maxBytes: z.number().int().min(1).max(MAX_PREVIEW_ARTIFACT_BYTES_V1),
  })
  .strict()

export type ArtifactReadRequestV1 = z.infer<typeof ArtifactReadRequestV1Schema>

export const ArtifactReadResponseV1Schema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_READ_CONTRACT_VERSION_V1),
    readIdempotencyKey: IdentifierV1Schema,
    binding: ArtifactReadBindingV1Schema,
    maxBytes: z.number().int().min(1).max(MAX_PREVIEW_ARTIFACT_BYTES_V1),
    artifact: RequestedPreviewArtifactV1Schema.extend({
      relativePath: PreviewRelativePathV1Schema,
      sizeBytes: z.number().int().min(1).max(MAX_PREVIEW_ARTIFACT_BYTES_V1),
      encoding: z.literal("base64"),
      bytesBase64: CanonicalBase64V1Schema,
    }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = Buffer.from(value.artifact.bytesBase64, "base64")
    if (bytes.toString("base64") !== value.artifact.bytesBase64) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact", "bytesBase64"],
        message: "bytesBase64 must use canonical base64 encoding",
      })
    }
    if (bytes.byteLength !== value.artifact.sizeBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact", "sizeBytes"],
        message: "sizeBytes must match the decoded artifact bytes",
      })
    }
    if (bytes.byteLength > value.maxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact", "sizeBytes"],
        message: "Artifact bytes must not exceed maxBytes",
      })
    }
    if (createHash("sha256").update(bytes).digest("hex") !== value.artifact.sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact", "sha256"],
        message: "sha256 must match the decoded artifact bytes",
      })
    }
  })

export type ArtifactReadResponseV1 = z.infer<typeof ArtifactReadResponseV1Schema>

export type ArtifactReadResponseValidationV1 =
  | { success: true; response: ArtifactReadResponseV1 }
  | { success: false; error: string }

export function validateArtifactReadResponseV1(
  requestValue: unknown,
  responseValue: unknown,
): ArtifactReadResponseValidationV1 {
  const parsedRequest = ArtifactReadRequestV1Schema.safeParse(requestValue)
  if (!parsedRequest.success) {
    return { success: false, error: "Invalid ArtifactReadV1 request" }
  }
  const parsedResponse = ArtifactReadResponseV1Schema.safeParse(responseValue)
  if (!parsedResponse.success) {
    return {
      success: false,
      error: parsedResponse.error.issues[0]?.message ?? "Invalid ArtifactReadV1 response",
    }
  }
  const request = parsedRequest.data
  const response = parsedResponse.data
  if (
    response.readIdempotencyKey !== request.readIdempotencyKey ||
    response.maxBytes !== request.maxBytes ||
    JSON.stringify(response.binding) !== JSON.stringify(request.binding) ||
    response.artifact.kind !== request.artifact.kind ||
    response.artifact.ref !== request.artifact.ref ||
    response.artifact.mediaType !== request.artifact.mediaType ||
    response.artifact.sha256 !== request.artifact.sha256
  ) {
    return {
      success: false,
      error: "ArtifactReadV1 response must preserve the exact request binding",
    }
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(response), "utf8")
  if (serializedBytes > MAX_ARTIFACT_READ_RESPONSE_BYTES_V1) {
    return { success: false, error: "ArtifactReadV1 response exceeds its wire limit" }
  }
  return { success: true, response }
}
