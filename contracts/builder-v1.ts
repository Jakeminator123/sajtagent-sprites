import { z } from "zod"

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
const RelativePathV1Schema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), {
    message: "Expected a portable workspace-relative path",
  })

export const BuilderIntentTypeV1Schema = z.enum([
  "site.create",
  "site.change",
  "site.block.add",
  "site.block.replace",
  "site.block.remove",
])

const BuildChoiceValueV1Schema = z.union([
  z.string().max(160),
  z.number().int().safe(),
  z.boolean(),
])

export const BuilderIntentContextV1Schema = z
  .object({
    selectedRouteId: IdentifierV1Schema.optional(),
    selectedElementRef: OpaqueRefV1Schema.optional(),
    selectedBaseRevisionId: IdentifierV1Schema.optional(),
    buildChoices: z.record(BuildChoiceValueV1Schema).optional(),
    mode: z.enum(["freeform", "analyzed", "audit", "template"]).optional(),
    planMode: z.boolean().optional(),
  })
  .strict()

export const BuilderIntentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    intentType: BuilderIntentTypeV1Schema,
    message: z.string().trim().min(1).max(20_000),
    context: BuilderIntentContextV1Schema,
  })
  .strict()

export type BuilderIntentV1 = z.infer<typeof BuilderIntentV1Schema>

export const ExecutionCapabilityV1Schema = z.enum([
  "workspace.read",
  "workspace.write",
  "workspace.apply_patch",
  "command.execute",
  "checks.run",
  "browser.inspect",
  "preview.manage",
  "packages.install",
])

const NetworkPolicyV1Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("deny-all") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(64),
    })
    .strict(),
])

const PackagePolicyV1Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("deny") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      allowedPackages: z.array(z.string().min(1).max(214)).min(1).max(128),
    })
    .strict(),
])

export const ExecutionPolicyV1Schema = z
  .object({
    deadlineAt: TimestampV1Schema,
    maxSteps: z.number().int().min(1).max(200),
    maxToolCalls: z.number().int().min(1).max(1_000),
    maxModelTokens: z.number().int().min(1).max(2_000_000),
    maxCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    capabilities: z.array(ExecutionCapabilityV1Schema).min(1).max(16),
    network: NetworkPolicyV1Schema,
    packages: PackagePolicyV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Capabilities must be unique",
      })
    }
    if (
      value.capabilities.includes("packages.install") &&
      value.packages.mode === "deny"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packages"],
        message: "packages.install requires an allowlist",
      })
    }
  })

export type ExecutionPolicyV1 = z.infer<typeof ExecutionPolicyV1Schema>

export const BuildJobV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: IdentifierV1Schema,
    tenantId: IdentifierV1Schema,
    projectId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    idempotencyKey: IdentifierV1Schema,
    createdAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
    intent: BuilderIntentV1Schema,
    executionPolicy: ExecutionPolicyV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after createdAt",
      })
    }
    if (Date.parse(value.executionPolicy.deadlineAt) <= Date.parse(value.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionPolicy", "deadlineAt"],
        message: "deadlineAt must be after job creation",
      })
    }
    if (Date.parse(value.executionPolicy.deadlineAt) > Date.parse(value.expiresAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionPolicy", "deadlineAt"],
        message: "deadlineAt cannot exceed job expiry",
      })
    }
  })

export type BuildJobV1 = z.infer<typeof BuildJobV1Schema>

export const EvidenceReceiptV1Schema = z
  .object({
    receiptId: IdentifierV1Schema,
    category: z.enum(["tool", "check", "preview", "policy"]),
    name: z.string().min(1).max(160),
    status: z.enum(["passed", "failed", "cancelled"]),
    startedAt: TimestampV1Schema,
    finishedAt: TimestampV1Schema,
    summary: z.string().max(2_000).optional(),
    evidenceRef: OpaqueRefV1Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt cannot be before startedAt",
      })
    }
  })

export type EvidenceReceiptV1 = z.infer<typeof EvidenceReceiptV1Schema>

export const ArtifactRefV1Schema = z
  .object({
    kind: z.enum(["preview", "diff", "log", "check-report", "other"]),
    ref: OpaqueRefV1Schema,
    mediaType: z.string().min(1).max(160).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict()

export const DiagnosticV1Schema = z
  .object({
    code: IdentifierV1Schema,
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
  })
  .strict()

export const WorkerCandidateReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("candidate"),
    jobId: IdentifierV1Schema,
    sourceRunId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    candidateRevisionId: CandidateRevisionIdV1Schema,
    changedPaths: z.array(RelativePathV1Schema).max(5_000),
    artifacts: z.array(ArtifactRefV1Schema).max(256),
    receipts: z.array(EvidenceReceiptV1Schema).max(2_000),
    diagnostics: z.array(DiagnosticV1Schema).max(256),
    reportedAt: TimestampV1Schema,
  })
  .strict()

export const WorkerFailureReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["failed", "cancelled", "timed_out"]),
    jobId: IdentifierV1Schema,
    sourceRunId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    receipts: z.array(EvidenceReceiptV1Schema).max(2_000),
    diagnostics: z.array(DiagnosticV1Schema).min(1).max(256),
    reportedAt: TimestampV1Schema,
  })
  .strict()

export const WorkerReportV1Schema = z.union([
  WorkerCandidateReportV1Schema,
  WorkerFailureReportV1Schema,
])

export type WorkerReportV1 = z.infer<typeof WorkerReportV1Schema>

export const BuildFailureCodeV1Schema = z.enum([
  "unauthenticated",
  "forbidden",
  "stale_revision",
  "idempotency_conflict",
  "expired",
  "policy_rejected",
  "runtime_unavailable",
  "worker_failed",
  "cancelled",
  "timeout",
  "verification_failed",
  "preview_unhealthy",
  "persistence_failed",
  "internal_error",
])

export const BuildResultSuccessV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("succeeded"),
    jobId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    workspaceRevisionId: IdentifierV1Schema,
    versionId: IdentifierV1Schema,
    previewRef: OpaqueRefV1Schema,
    sitemapRevision: IdentifierV1Schema,
    verifiedAt: TimestampV1Schema,
    receipts: z.array(EvidenceReceiptV1Schema).min(1).max(2_000),
  })
  .strict()

export const BuildResultFailureV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("failed"),
    jobId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    code: BuildFailureCodeV1Schema,
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
    failedAt: TimestampV1Schema,
    receipts: z.array(EvidenceReceiptV1Schema).max(2_000),
  })
  .strict()

export const BuildResultV1Schema = z.discriminatedUnion("status", [
  BuildResultSuccessV1Schema,
  BuildResultFailureV1Schema,
])

export type BuildResultV1 = z.infer<typeof BuildResultV1Schema>

const BuildEventBaseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: IdentifierV1Schema,
    sequence: z.number().int().positive(),
    occurredAt: TimestampV1Schema,
    sourceRunId: IdentifierV1Schema.optional(),
  })
  .strict()

const buildEvent = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) =>
  BuildEventBaseV1Schema.extend({
    type: z.literal(type),
    payload,
  }).strict()

export const BuildEventV1Schema = z
  .union([
    buildEvent(
      "job.accepted",
      z.object({ acceptedAt: TimestampV1Schema }).strict(),
    ),
    buildEvent(
      "job.running",
      z
        .object({
          phase: z.enum(["plan", "build", "check", "persist"]),
          label: z.string().min(1).max(240).optional(),
        })
        .strict(),
    ),
    buildEvent(
      "message.delta",
      z.object({ delta: z.string().min(1).max(8_000) }).strict(),
    ),
    buildEvent(
      "job.succeeded",
      z.object({ result: BuildResultSuccessV1Schema }).strict(),
    ),
    buildEvent(
      "job.failed",
      z.object({ result: BuildResultFailureV1Schema }).strict(),
    ),
  ])
  .superRefine((value, context) => {
    if (
      (value.type === "job.succeeded" || value.type === "job.failed") &&
      value.payload.result.jobId !== value.jobId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "result", "jobId"],
        message: "Terminal result jobId must match event jobId",
      })
    }
  })

export type BuildEventV1 = z.infer<typeof BuildEventV1Schema>

export const ContractSchemaNameV1Schema = z.enum([
  "BuilderIntentV1",
  "BuildJobV1",
  "WorkerReportV1",
  "BuildResultV1",
  "BuildEventV1",
])

export type ContractSchemaNameV1 = z.infer<typeof ContractSchemaNameV1Schema>

export const BuilderContractSchemasV1: Record<
  ContractSchemaNameV1,
  z.ZodTypeAny
> = {
  BuilderIntentV1: BuilderIntentV1Schema,
  BuildJobV1: BuildJobV1Schema,
  WorkerReportV1: WorkerReportV1Schema,
  BuildResultV1: BuildResultV1Schema,
  BuildEventV1: BuildEventV1Schema,
}

export type BuildEventStreamValidationV1 =
  | { success: true; events: BuildEventV1[] }
  | { success: false; error: string }

export function validateBuildEventStreamV1(
  values: unknown[],
  options: { afterSequence?: number; requireTerminal?: boolean } = {},
): BuildEventStreamValidationV1 {
  const events: BuildEventV1[] = []
  let expectedSequence = (options.afterSequence ?? 0) + 1
  let terminalSeen = false

  for (const value of values) {
    const parsed = BuildEventV1Schema.safeParse(value)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid event" }
    }
    const event = parsed.data
    if (terminalSeen) {
      return { success: false, error: "No event may follow a terminal event" }
    }
    if (event.sequence !== expectedSequence) {
      return {
        success: false,
        error: `Expected sequence ${expectedSequence}, received ${event.sequence}`,
      }
    }
    if (
      events.length > 0 &&
      event.jobId !== events[0]?.jobId
    ) {
      return { success: false, error: "All events must belong to the same job" }
    }
    terminalSeen = event.type === "job.succeeded" || event.type === "job.failed"
    expectedSequence += 1
    events.push(event)
  }

  if (options.requireTerminal !== false && !terminalSeen) {
    return { success: false, error: "A complete stream must end in one terminal event" }
  }

  return { success: true, events }
}
