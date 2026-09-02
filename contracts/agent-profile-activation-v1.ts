import { z } from "zod"

import {
  AgentProfileV1Schema,
  EffectiveAgentPolicyV1Schema,
} from "./agent-profile-v1.ts"

const IdentifierV1Schema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

const TimestampV1Schema = z.string().datetime({ offset: true })
const Sha256V1Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const AGENT_PROFILE_ACTIVATION_CONTRACT_VERSION_V1 = 1 as const
export const AGENT_PROFILE_ACTIVATION_PATH_V1 = "/v1/agent-profiles/activate"
export const MAX_AGENT_PROFILE_ACTIVATION_REQUEST_BYTES_V1 = 64 * 1024

export const AgentProfileActivationRequestV1Schema = z
  .object({
    schemaVersion: z.literal(AGENT_PROFILE_ACTIVATION_CONTRACT_VERSION_V1),
    activationId: IdentifierV1Schema,
    idempotencyKey: IdentifierV1Schema,
    requestedAt: TimestampV1Schema,
    expectedActiveRevision: z.number().int().positive().optional(),
    profile: AgentProfileV1Schema,
  })
  .strict()

export type AgentProfileActivationRequestV1 = z.infer<
  typeof AgentProfileActivationRequestV1Schema
>

export const AgentProfileActivationReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(AGENT_PROFILE_ACTIVATION_CONTRACT_VERSION_V1),
    activated: z.literal(true),
    profileId: IdentifierV1Schema,
    revision: z.number().int().positive(),
    activatedAt: TimestampV1Schema,
    activationId: IdentifierV1Schema,
    bundleSha256: Sha256V1Schema,
    takesEffect: z.literal("next-run"),
    effectivePolicy: EffectiveAgentPolicyV1Schema,
    runtime: z
      .object({
        service: z.literal("sajtagent-sprites-runtime"),
        mode: z.literal("openclaw-workspace"),
      })
      .strict(),
  })
  .strict()

export type AgentProfileActivationReceiptV1 = z.infer<
  typeof AgentProfileActivationReceiptV1Schema
>
