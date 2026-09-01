import { z } from "zod"

import { BuilderIntentTypeV1Schema } from "./builder-v1.ts"

const IdentifierV1Schema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const TimestampV1Schema = z.string().datetime({ offset: true })
const OpaqueRefV1Schema = z.string().min(1).max(512)
const SessionIdV1Schema = z
  .string()
  .min(40)
  .max(136)
  .regex(/^session:[A-Za-z0-9_-]{32,128}$/)
const TurnIdV1Schema = z
  .string()
  .min(21)
  .max(133)
  .regex(/^turn:[A-Za-z0-9_-]{16,128}$/)
const EventIdV1Schema = z
  .string()
  .min(22)
  .max(134)
  .regex(/^event:[A-Za-z0-9_-]{16,128}$/)
const QuestionIdV1Schema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_]*$/)
const AgentArtifactRefV1Schema = z
  .object({
    kind: z.enum(["preview", "diff", "log", "check-report", "other"]),
    ref: z
      .string()
      .min(25)
      .max(137)
      .regex(/^artifact:[A-Za-z0-9_-]{16,128}$/),
    mediaType: z.string().min(1).max(160).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict()
const AgentReceiptV1Schema = z
  .object({
    receiptId: IdentifierV1Schema,
    category: z.enum(["tool", "check", "preview", "policy"]),
    safeLabel: z.string().trim().min(1).max(160),
    status: z.enum(["passed", "failed", "cancelled"]),
    startedAt: TimestampV1Schema,
    finishedAt: TimestampV1Schema,
    detailRef: AgentArtifactRefV1Schema.optional(),
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
const AgentPreviewResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("succeeded"),
    jobId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    workspaceRevisionId: IdentifierV1Schema,
    versionId: IdentifierV1Schema,
    previewRef: z
      .string()
      .min(24)
      .max(136)
      .regex(/^preview:[A-Za-z0-9_-]{16,128}$/),
    sitemapRevision: IdentifierV1Schema,
    verifiedAt: TimestampV1Schema,
  })
  .strict()

const AgentBuildChoiceValueV1Schema = z.union([
  z.string().max(160),
  z.number().int().safe(),
  z.boolean(),
])

export const AgentSessionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdV1Schema,
    projectId: IdentifierV1Schema,
    activeBaseRevisionId: IdentifierV1Schema,
    status: z.enum(["active", "closed"]),
    createdAt: TimestampV1Schema,
    updatedAt: TimestampV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt cannot be before createdAt",
      })
    }
  })

export type AgentSessionV1 = z.infer<typeof AgentSessionV1Schema>

export const AgentUiContextV1Schema = z
  .object({
    selectedBaseRevisionId: IdentifierV1Schema,
    selectedRouteId: IdentifierV1Schema.optional(),
    selectedElementRef: OpaqueRefV1Schema.optional(),
    buildChoices: z.record(AgentBuildChoiceValueV1Schema).optional(),
    mode: z.enum(["freeform", "analyzed", "audit", "template"]).optional(),
  })
  .strict()

export const AgentTurnRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdV1Schema,
    turnId: TurnIdV1Schema,
    idempotencyKey: IdentifierV1Schema,
    message: z.string().trim().min(1).max(20_000),
    replyToQuestionId: QuestionIdV1Schema.optional(),
    answerSelections: z.array(z.string().trim().min(1).max(240)).min(1).max(4).optional(),
    uiContext: AgentUiContextV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.replyToQuestionId) !== Boolean(value.answerSelections)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.replyToQuestionId
          ? ["answerSelections"]
          : ["replyToQuestionId"],
        message:
          "replyToQuestionId and answerSelections must be supplied together",
      })
    }
  })

export type AgentTurnRequestV1 = z.infer<typeof AgentTurnRequestV1Schema>

export const AgentTurnCapabilityV1Schema = z.enum([
  "conversation.respond",
  "project.read",
  "checks.run",
  "build.request",
])

export const AgentToolCapabilityV1Schema = z.enum([
  "project.read",
  "checks.run",
  "build.request",
])

export type AgentToolCapabilityV1 = z.infer<
  typeof AgentToolCapabilityV1Schema
>

export type AgentTurnCapabilityV1 = z.infer<
  typeof AgentTurnCapabilityV1Schema
>

export const AgentTurnPolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdV1Schema,
    turnId: TurnIdV1Schema,
    projectId: IdentifierV1Schema,
    baseRevisionId: IdentifierV1Schema,
    issuedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
    capabilities: z.array(AgentTurnCapabilityV1Schema).min(1).max(12),
    allowedMutationIntents: z.array(BuilderIntentTypeV1Schema).max(8),
    maxToolCalls: z.number().int().min(0).max(1_000),
    maxModelTokens: z.number().int().min(1).max(2_000_000),
    maxCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after issuedAt",
      })
    }
    if (Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 15 * 60_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Turn policy TTL cannot exceed 15 minutes",
      })
    }
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Capabilities must be unique",
      })
    }
    if (!value.capabilities.includes("conversation.respond")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Every turn must authorize conversation.respond",
      })
    }
    if (
      new Set(value.allowedMutationIntents).size !==
      value.allowedMutationIntents.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedMutationIntents"],
        message: "Mutation intents must be unique",
      })
    }
    if (
      value.capabilities.includes("build.request") !==
      (value.allowedMutationIntents.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedMutationIntents"],
        message:
          "Mutation intents must be present exactly when build.request is authorized",
      })
    }
    if (
      value.maxToolCalls === 0 &&
      (value.capabilities.length !== 1 ||
        value.capabilities[0] !== "conversation.respond")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxToolCalls"],
        message: "A zero-tool turn may only authorize conversation.respond",
      })
    }
  })

export type AgentTurnPolicyV1 = z.infer<typeof AgentTurnPolicyV1Schema>

const AgentEventBaseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdV1Schema,
    turnId: TurnIdV1Schema,
    eventId: EventIdV1Schema,
    sequence: z.number().int().safe().positive(),
    occurredAt: TimestampV1Schema,
  })
  .strict()

const agentEvent = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) =>
  AgentEventBaseV1Schema.extend({
    type: z.literal(type),
    payload,
  }).strict()

export const AgentEventV1Schema = z
  .union([
    agentEvent(
      "turn.accepted",
      z.object({ acceptedAt: TimestampV1Schema }).strict(),
    ),
    agentEvent(
      "agent.status",
      z
        .object({
          state: z.enum([
            "idle",
            "thinking",
            "waiting_for_user",
            "using_tool",
            "checking",
          ]),
          label: z.string().trim().min(1).max(240).optional(),
        })
        .strict(),
    ),
    agentEvent(
      "message.delta",
      z
        .object({
          messageId: IdentifierV1Schema,
          delta: z.string().min(1).max(8_000),
        })
        .strict(),
    ),
    agentEvent(
      "question.requested",
      z
        .object({
          questionId: QuestionIdV1Schema,
          header: z.string().trim().min(1).max(12),
          question: z.string().trim().min(1).max(2_000),
          options: z
            .array(
              z
                .object({
                  label: z.string().trim().min(1).max(240),
                  description: z.string().trim().min(1).max(500).optional(),
                })
                .strict(),
            )
            .max(4),
          multiSelect: z.boolean().optional(),
          isOther: z.boolean().optional(),
        })
        .strict(),
    ),
    agentEvent(
      "tool.started",
      z
        .object({
          toolCallId: IdentifierV1Schema,
          capability: AgentToolCapabilityV1Schema,
          safeLabel: z.string().trim().min(1).max(240),
        })
        .strict(),
    ),
    agentEvent(
      "tool.completed",
      z
        .object({
          toolCallId: IdentifierV1Schema,
          status: z.enum(["passed", "failed", "cancelled"]),
          receipts: z.array(AgentReceiptV1Schema).max(64),
          artifacts: z.array(AgentArtifactRefV1Schema).max(32),
        })
        .strict(),
    ),
    agentEvent(
      "build.started",
      z
        .object({
          jobId: IdentifierV1Schema,
          toolCallId: IdentifierV1Schema,
          intentType: BuilderIntentTypeV1Schema,
        })
        .strict(),
    ),
    agentEvent(
      "preview.ready",
      z
        .object({
          jobId: IdentifierV1Schema,
          result: AgentPreviewResultV1Schema,
        })
        .strict(),
    ),
    agentEvent(
      "turn.completed",
      z
        .object({
          outcome: z.enum(["answered", "awaiting_user", "built", "no_change"]),
        })
        .strict(),
    ),
    agentEvent(
      "turn.failed",
      z
        .object({
          code: IdentifierV1Schema,
          message: z.string().trim().min(1).max(2_000),
          retryable: z.boolean(),
        })
        .strict(),
    ),
  ])
  .superRefine((value, context) => {
    if (
      value.type === "turn.accepted" &&
      value.payload.acceptedAt !== value.occurredAt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "acceptedAt"],
        message: "acceptedAt must match the event occurredAt",
      })
    }
    if (
      value.type === "preview.ready" &&
      value.payload.result.jobId !== value.payload.jobId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "result", "jobId"],
        message: "Preview result jobId must match preview jobId",
      })
    }
  })

export type AgentEventV1 = z.infer<typeof AgentEventV1Schema>

export const AgentSessionContractNameV1Schema = z.enum([
  "AgentSessionV1",
  "AgentTurnRequestV1",
  "AgentTurnPolicyV1",
  "AgentEventV1",
])

export type AgentSessionContractNameV1 = z.infer<
  typeof AgentSessionContractNameV1Schema
>

export const AgentSessionContractSchemasV1: Record<
  AgentSessionContractNameV1,
  z.ZodTypeAny
> = {
  AgentSessionV1: AgentSessionV1Schema,
  AgentTurnRequestV1: AgentTurnRequestV1Schema,
  AgentTurnPolicyV1: AgentTurnPolicyV1Schema,
  AgentEventV1: AgentEventV1Schema,
}

export type AgentEventStreamValidationV1 =
  | { success: true; events: AgentEventV1[] }
  | { success: false; error: string }

export function validateAgentEventBatchV1(
  values: unknown[],
  options: {
    afterSequence?: number
    expectedSessionId?: string
  } = {},
): AgentEventStreamValidationV1 {
  const afterSequence = options.afterSequence ?? 0
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    return { success: false, error: "afterSequence must be a non-negative integer" }
  }
  const events: AgentEventV1[] = []
  const eventIds = new Set<string>()
  let expectedSequence = afterSequence + 1
  let sessionId = options.expectedSessionId ?? null

  if (
    options.expectedSessionId &&
    !SessionIdV1Schema.safeParse(options.expectedSessionId).success
  ) {
    return { success: false, error: "expectedSessionId must be a valid session id" }
  }

  for (const value of values) {
    const parsed = AgentEventV1Schema.safeParse(value)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid AgentEventV1",
      }
    }
    const event = parsed.data
    if (event.sequence !== expectedSequence) {
      return {
        success: false,
        error: `Expected sequence ${expectedSequence}, received ${event.sequence}`,
      }
    }
    if (eventIds.has(event.eventId)) {
      return { success: false, error: "Agent eventId values must be unique" }
    }
    sessionId ??= event.sessionId
    if (event.sessionId !== sessionId) {
      return { success: false, error: "All events must belong to one session" }
    }
    eventIds.add(event.eventId)
    expectedSequence += 1
    events.push(event)
  }

  return { success: true, events }
}

export function validateAgentTurnEventStreamV1(
  values: unknown[],
  options: { baseSequence?: number; requireTerminal?: boolean } = {},
): AgentEventStreamValidationV1 {
  const batch = validateAgentEventBatchV1(values, {
    afterSequence: options.baseSequence,
  })
  if (!batch.success) return batch
  if (batch.events.length === 0) {
    return { success: false, error: "A turn stream cannot be empty" }
  }

  const [firstEvent] = batch.events
  if (!firstEvent || firstEvent.type !== "turn.accepted") {
    return { success: false, error: "A turn stream must start with turn.accepted" }
  }

  const turnId = firstEvent.turnId
  const openTools = new Map<string, AgentToolCapabilityV1>()
  const completedTools = new Map<
    string,
    "passed" | "failed" | "cancelled"
  >()
  let terminalSeen = false
  let messageSeen = false
  let questionSeen = false
  let buildRequestSeen = false
  let buildJobId: string | null = null
  let buildToolCallId: string | null = null
  let readyJobId: string | null = null

  for (const [index, event] of batch.events.entries()) {
    if (event.turnId !== turnId) {
      return { success: false, error: "A turn stream must contain one turnId" }
    }
    if (terminalSeen) {
      return { success: false, error: "No event may follow a terminal turn event" }
    }
    if (index > 0 && event.type === "turn.accepted") {
      return { success: false, error: "turn.accepted may only be the first event" }
    }

    if (event.type === "message.delta") messageSeen = true
    if (event.type === "question.requested") {
      if (questionSeen) {
        return { success: false, error: "V1 permits at most one question per turn" }
      }
      questionSeen = true
    }
    if (event.type === "tool.started") {
      if (
        openTools.has(event.payload.toolCallId) ||
        completedTools.has(event.payload.toolCallId)
      ) {
        return { success: false, error: "tool.started toolCallId must be unique" }
      }
      if (event.payload.capability === "build.request" && buildRequestSeen) {
        return { success: false, error: "V1 permits at most one build.request per turn" }
      }
      openTools.set(event.payload.toolCallId, event.payload.capability)
      if (event.payload.capability === "build.request") {
        buildRequestSeen = true
      }
    }
    if (event.type === "tool.completed") {
      if (!openTools.has(event.payload.toolCallId)) {
        return { success: false, error: "tool.completed requires a matching tool.started" }
      }
      openTools.delete(event.payload.toolCallId)
      completedTools.set(event.payload.toolCallId, event.payload.status)
    }
    if (event.type === "build.started") {
      if (buildJobId) {
        return { success: false, error: "V1 permits at most one build job per turn" }
      }
      if (openTools.get(event.payload.toolCallId) !== "build.request") {
        return {
          success: false,
          error: "build.started requires its open build.request tool",
        }
      }
      buildJobId = event.payload.jobId
      buildToolCallId = event.payload.toolCallId
    }
    if (event.type === "preview.ready") {
      if (readyJobId) {
        return { success: false, error: "V1 permits at most one preview.ready per turn" }
      }
      if (event.payload.jobId !== buildJobId) {
        return { success: false, error: "preview.ready requires its matching build.started" }
      }
      if (
        !buildToolCallId ||
        completedTools.get(buildToolCallId) !== "passed"
      ) {
        return {
          success: false,
          error: "preview.ready requires its mutation tool to pass first",
        }
      }
      readyJobId = event.payload.jobId
    }
    if (event.type === "turn.completed") {
      if (openTools.size > 0) {
        return { success: false, error: "turn.completed cannot leave tools open" }
      }
      if (
        event.payload.outcome === "awaiting_user" &&
        (!questionSeen || buildRequestSeen || buildJobId !== null)
      ) {
        return {
          success: false,
          error: "awaiting_user requires one question and no build",
        }
      }
      if (
        event.payload.outcome === "built" &&
        (questionSeen || !buildJobId || readyJobId !== buildJobId)
      ) {
        return {
          success: false,
          error: "built requires one passed build, canonical preview and no question",
        }
      }
      if (
        event.payload.outcome === "answered" &&
        (!messageSeen || questionSeen || buildRequestSeen || buildJobId !== null)
      ) {
        return {
          success: false,
          error: "answered requires a message and no question or build",
        }
      }
      if (
        event.payload.outcome === "no_change" &&
        (questionSeen || buildRequestSeen || buildJobId !== null || readyJobId !== null)
      ) {
        return {
          success: false,
          error: "no_change cannot contain a question, build or preview",
        }
      }
      terminalSeen = true
    }
    if (event.type === "turn.failed") terminalSeen = true
  }

  if (options.requireTerminal !== false && !terminalSeen) {
    return { success: false, error: "A complete turn stream must be terminal" }
  }
  return batch
}

export function validateAgentTurnAgainstPolicyV1(
  sessionValue: unknown,
  policyValue: unknown,
  values: unknown[],
  options: { baseSequence?: number; requireTerminal?: boolean } = {},
): AgentEventStreamValidationV1 {
  const session = AgentSessionV1Schema.safeParse(sessionValue)
  if (!session.success) {
    return {
      success: false,
      error: session.error.issues[0]?.message ?? "Invalid AgentSessionV1",
    }
  }
  const policy = AgentTurnPolicyV1Schema.safeParse(policyValue)
  if (!policy.success) {
    return {
      success: false,
      error: policy.error.issues[0]?.message ?? "Invalid AgentTurnPolicyV1",
    }
  }
  const stream = validateAgentTurnEventStreamV1(values, options)
  if (!stream.success) return stream

  if (session.data.status !== "active") {
    return { success: false, error: "A closed AgentSession cannot accept a turn" }
  }
  if (
    policy.data.sessionId !== session.data.sessionId ||
    policy.data.projectId !== session.data.projectId ||
    policy.data.baseRevisionId !== session.data.activeBaseRevisionId
  ) {
    return {
      success: false,
      error: "Turn policy must match the active Site-owned session binding",
    }
  }

  let toolCallCount = 0
  for (const event of stream.events) {
    if (
      event.sessionId !== policy.data.sessionId ||
      event.turnId !== policy.data.turnId
    ) {
      return { success: false, error: "Every event must match its turn policy" }
    }
    if (
      event.type === "turn.accepted" &&
      Date.parse(event.occurredAt) < Date.parse(policy.data.issuedAt)
    ) {
      return { success: false, error: "A turn cannot be accepted before its policy" }
    }
    if (
      event.type === "turn.accepted" &&
      Date.parse(event.occurredAt) > Date.parse(policy.data.expiresAt)
    ) {
      return { success: false, error: "A turn cannot start after policy expiry" }
    }
    if (event.type === "tool.started") {
      toolCallCount += 1
      if (!policy.data.capabilities.includes(event.payload.capability)) {
        return {
          success: false,
          error: `Tool capability ${event.payload.capability} is not authorized`,
        }
      }
      if (Date.parse(event.occurredAt) > Date.parse(policy.data.expiresAt)) {
        return { success: false, error: "A tool cannot start after policy expiry" }
      }
    }
    if (event.type === "build.started") {
      if (
        !policy.data.capabilities.includes("build.request") ||
        !policy.data.allowedMutationIntents.includes(event.payload.intentType)
      ) {
        return {
          success: false,
          error: "Build intent is not authorized by the turn policy",
        }
      }
      if (Date.parse(event.occurredAt) > Date.parse(policy.data.expiresAt)) {
        return { success: false, error: "A build cannot start after policy expiry" }
      }
    }
    if (
      event.type === "preview.ready" &&
      event.payload.result.baseRevisionId !== policy.data.baseRevisionId
    ) {
      return {
        success: false,
        error: "Canonical preview must preserve the policy base revision",
      }
    }
  }

  if (toolCallCount > policy.data.maxToolCalls) {
    return { success: false, error: "Turn exceeds its maxToolCalls policy budget" }
  }
  return stream
}

export function validateAgentSessionHistoryV1(
  values: unknown[],
  options: { baseSequence?: number; requireFinalTerminal?: boolean } = {},
): AgentEventStreamValidationV1 {
  const batch = validateAgentEventBatchV1(values, {
    afterSequence: options.baseSequence,
  })
  if (!batch.success || batch.events.length === 0) return batch

  const turnGroups: AgentEventV1[][] = []
  const seenTurnIds = new Set<string>()
  for (const event of batch.events) {
    const current = turnGroups.at(-1)
    if (!current || current[0]?.turnId !== event.turnId) {
      if (seenTurnIds.has(event.turnId)) {
        return { success: false, error: "A terminal turnId cannot be resumed later" }
      }
      seenTurnIds.add(event.turnId)
      turnGroups.push([event])
    } else {
      current.push(event)
    }
  }

  for (const [index, turnEvents] of turnGroups.entries()) {
    const first = turnEvents[0]
    if (!first) continue
    const isFinal = index === turnGroups.length - 1
    const result = validateAgentTurnEventStreamV1(turnEvents, {
      baseSequence: first.sequence - 1,
      requireTerminal: isFinal
        ? options.requireFinalTerminal !== false
        : true,
    })
    if (!result.success) return result
  }

  return batch
}

export const validateAgentEventStreamV1 = validateAgentTurnEventStreamV1
