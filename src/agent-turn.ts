import { createHash } from "node:crypto"
import { z } from "zod"

import {
  AgentEventV1Schema,
  AgentSessionV1Schema,
  AgentTurnPolicyV1Schema,
  AgentTurnRequestV1Schema,
  type AgentEventV1,
  type AgentTurnCapabilityV1,
} from "../contracts/agent-session-v1.ts"

export const RUNTIME_AGENT_TURN_CAPABILITIES_V1 = [
  "conversation.respond",
  "build.request",
] as const satisfies readonly AgentTurnCapabilityV1[]

export const MAX_AGENT_TURN_EVENTS_V1 = 4_096
export const MAX_AGENT_EVENT_SSE_BYTES_V1 = 32 * 1024
export const MAX_AGENT_TURN_SSE_BYTES_V1 = 4 * 1024 * 1024
export const AGENT_TURN_TERMINAL_RESERVE_BYTES_V1 = 64 * 1024

export function compileConversationOnlyOpenClawToolPolicyV1() {
  return {
    inheritedToolPolicyVersion: 1 as const,
    inheritedToolAllow: [] as string[],
    inheritedToolDeny: ["*"],
  }
}

export function compileBuildRequestOpenClawToolPolicyV1() {
  return {
    inheritedToolPolicyVersion: 1 as const,
    inheritedToolAllow: ["siteagent_build_request", "build.request"],
    inheritedToolDeny: [] as string[],
  }
}

export function compileAgentTurnOpenClawToolPolicyV1(
  capabilities: readonly AgentTurnCapabilityV1[],
) {
  if (
    capabilities.length === 1 &&
    capabilities[0] === "conversation.respond"
  ) {
    return compileConversationOnlyOpenClawToolPolicyV1()
  }
  const capabilitySet = new Set(capabilities)
  if (
    capabilities.length === 2 &&
    capabilitySet.has("conversation.respond") &&
    capabilitySet.has("build.request")
  ) {
    return compileBuildRequestOpenClawToolPolicyV1()
  }
  throw new Error("agent_turn_tool_policy_not_supported")
}

export const RuntimeAgentTurnIngressV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    session: AgentSessionV1Schema,
    turn: AgentTurnRequestV1Schema,
    policy: AgentTurnPolicyV1Schema,
    baseSequence: z.number().int().safe().min(0),
  })
  .strict()
  .superRefine((value, context) => {
    const bindings: Array<[boolean, Array<string | number>, string]> = [
      [value.session.status === "active", ["session", "status"], "Session must be active"],
      [value.turn.sessionId === value.session.sessionId, ["turn", "sessionId"], "Turn sessionId must match session"],
      [value.policy.sessionId === value.session.sessionId, ["policy", "sessionId"], "Policy sessionId must match session"],
      [value.policy.turnId === value.turn.turnId, ["policy", "turnId"], "Policy turnId must match turn"],
      [value.policy.projectId === value.session.projectId, ["policy", "projectId"], "Policy projectId must match session"],
      [value.policy.baseRevisionId === value.session.activeBaseRevisionId, ["policy", "baseRevisionId"], "Policy baseRevisionId must match active session revision"],
      [value.turn.uiContext.selectedBaseRevisionId === value.session.activeBaseRevisionId, ["turn", "uiContext", "selectedBaseRevisionId"], "Selected UI revision must match active session revision"],
    ]
    for (const [ok, path, message] of bindings) {
      if (!ok) {
        context.addIssue({ code: z.ZodIssueCode.custom, path, message })
      }
    }
  })

export type RuntimeAgentTurnIngressV1 = z.infer<
  typeof RuntimeAgentTurnIngressV1Schema
>

type AgentEventFor<TType extends AgentEventV1["type"]> = Extract<
  AgentEventV1,
  { type: TType }
>

export type AgentEventDraftV1 = {
  [TType in AgentEventV1["type"]]: {
    type: TType
    payload: AgentEventFor<TType>["payload"]
    occurredAt?: string
  }
}[AgentEventV1["type"]]

export interface AgentTurnRunnerV1 {
  health(): Promise<{
    connected: boolean
    runtimeVersion?: string
    reason?: string
  }>
  runTurn(
    input: RuntimeAgentTurnIngressV1,
    emit: (event: AgentEventDraftV1) => void,
  ): Promise<AgentTurnRunResultV1>
}

export type AgentTurnRunResultV1 =
  | { outcome: "terminal" }
  | { outcome: "build_handoff"; toolCallId: string }

export const UNAVAILABLE_AGENT_TURN_RUNNER_V1: AgentTurnRunnerV1 = {
  async health() {
    return { connected: false, reason: "openclaw_turn_runner_not_configured" }
  },
  async runTurn() {
    throw new Error("openclaw_turn_runner_not_configured")
  },
}

export function assertRuntimeAgentTurnSupportedV1(
  input: RuntimeAgentTurnIngressV1,
  now = Date.now(),
): void {
  if (now < Date.parse(input.policy.issuedAt) - 5 * 60_000) {
    throw new Error("agent_turn_policy_not_yet_valid")
  }
  if (now >= Date.parse(input.policy.expiresAt)) {
    throw new Error("agent_turn_policy_expired")
  }
  if (input.turn.replyToQuestionId || input.turn.answerSelections) {
    throw new Error("agent_question_resume_not_implemented")
  }
  if (
    input.policy.capabilities.length === 1 &&
    input.policy.capabilities[0] === "conversation.respond" &&
    input.policy.maxToolCalls === 0
  ) {
    return
  }
  const capabilities = new Set(input.policy.capabilities)
  if (
    capabilities.size !== 2 ||
    !capabilities.has("conversation.respond") ||
    !capabilities.has("build.request") ||
    input.policy.maxToolCalls < 1 ||
    input.policy.allowedMutationIntents.length !== 1
  ) {
    throw new Error("agent_turn_capability_not_implemented")
  }
}

function eventId(turnId: string, sequence: number, type: string): string {
  const digest = createHash("sha256")
    .update(`${turnId}\n${sequence}\n${type}`)
    .digest("base64url")
    .slice(0, 32)
  return `event:${digest}`
}

export function createAgentEventEmitterV1(
  input: RuntimeAgentTurnIngressV1,
  sink: (event: AgentEventV1) => void,
) {
  let count = 0
  let terminal = false
  let lastEvent: AgentEventV1 | undefined

  return {
    emit(draft: AgentEventDraftV1): AgentEventV1 {
      if (terminal) {
        throw new Error("agent_turn_event_after_terminal")
      }
      const sequence = input.baseSequence + count + 1
      if (!Number.isSafeInteger(sequence)) {
        throw new Error("agent_turn_sequence_overflow")
      }
      const event = AgentEventV1Schema.parse({
        schemaVersion: 1,
        sessionId: input.session.sessionId,
        turnId: input.turn.turnId,
        eventId: eventId(input.turn.turnId, sequence, draft.type),
        sequence,
        occurredAt: draft.occurredAt || new Date().toISOString(),
        type: draft.type,
        payload: draft.payload,
      })
      count += 1
      terminal = event.type === "turn.completed" || event.type === "turn.failed"
      lastEvent = event
      sink(event)
      return event
    },
    get count() {
      return count
    },
    get terminal() {
      return terminal
    },
    get lastEvent() {
      return lastEvent
    },
  }
}

export function formatAgentEventSseV1(event: AgentEventV1): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

type GatewayEventFrameV1 = {
  event: string
  payload?: unknown
}

type OpenClawAgentPayloadV1 = {
  runId?: unknown
  ts?: unknown
  stream?: unknown
  data?: unknown
}

export type OpenClawAgentNormalizerStateV1 = {
  assistantText: string
  buildRequestToolCallId: string | null
}

export function createOpenClawAgentNormalizerStateV1(): OpenClawAgentNormalizerStateV1 {
  return { assistantText: "", buildRequestToolCallId: null }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedTimestamp(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? new Date(value).toISOString()
    : undefined
}

function opaqueIdentifier(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("base64url").slice(0, 24)
  return `${prefix}:${digest}`
}

function splitDelta(delta: string): string[] {
  const chunks: string[] = []
  for (let index = 0; index < delta.length; index += 8_000) {
    chunks.push(delta.slice(index, index + 8_000))
  }
  return chunks
}

function toolCapability(name: string): "project.read" | "checks.run" | "build.request" | null {
  if (["read", "grep", "glob", "ls", "find", "project.read"].includes(name)) {
    return "project.read"
  }
  if (name === "checks.run") return "checks.run"
  if (["build.request", "siteagent_build_request"].includes(name)) return "build.request"
  return null
}

function assistantDelta(
  data: Record<string, unknown>,
  state: OpenClawAgentNormalizerStateV1,
): string {
  const text = typeof data.text === "string" ? data.text : undefined
  const rawDelta = typeof data.delta === "string" ? data.delta : undefined
  if (data.replace === true && text !== undefined) {
    if (state.assistantText && !text.startsWith(state.assistantText)) {
      throw new Error("openclaw_assistant_replace_not_append_only")
    }
    const delta = text.slice(state.assistantText.length)
    state.assistantText = text
    return delta
  }
  if (rawDelta !== undefined) {
    state.assistantText = text ?? `${state.assistantText}${rawDelta}`
    return rawDelta
  }
  if (text !== undefined && text.startsWith(state.assistantText)) {
    const delta = text.slice(state.assistantText.length)
    state.assistantText = text
    return delta
  }
  return ""
}

/**
 * Normalize only the documented OpenClaw event families. Unknown streams are
 * intentionally ignored; unexpected or unauthorized tool execution fails
 * closed instead of being re-labelled as product success.
 */
export function normalizeOpenClawGatewayEventV1(
  frame: GatewayEventFrameV1,
  context: {
    runId: string
    turnId: string
    capabilities: readonly AgentTurnCapabilityV1[]
    state: OpenClawAgentNormalizerStateV1
  },
): AgentEventDraftV1[] {
  if (frame.event === "question.requested") {
    const questionRecord = asRecord(frame.payload)
    if (!questionRecord || questionRecord.runId !== context.runId) return []
    const questions = Array.isArray(questionRecord.questions) ? questionRecord.questions : []
    return questions.map((candidate) => {
      const question = asRecord(candidate)
      if (!question || question.isSecret === true || question.secretStore || question.secretStoreExisting) {
        throw new Error("openclaw_secret_question_not_browser_safe")
      }
      return {
        type: "question.requested" as const,
        occurredAt: boundedTimestamp(questionRecord.createdAtMs),
        payload: {
          questionId: question.questionId,
          header: question.header,
          question: question.question,
          options: question.options,
          ...(typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
          ...(typeof question.isOther === "boolean" ? { isOther: question.isOther } : {}),
        },
      } as AgentEventDraftV1
    })
  }

  if (frame.event !== "agent") return []
  const payload = asRecord(frame.payload) as OpenClawAgentPayloadV1 | null
  if (!payload || payload.runId !== context.runId) return []
  const data = asRecord(payload.data)
  if (!data || typeof payload.stream !== "string") return []
  const occurredAt = boundedTimestamp(payload.ts)

  if (payload.stream === "assistant") {
    const delta = assistantDelta(data, context.state)
    return splitDelta(delta).filter(Boolean).map((chunk) => ({
      type: "message.delta" as const,
      occurredAt,
      payload: {
        messageId: opaqueIdentifier("message", context.turnId),
        delta: chunk,
      },
    }))
  }

  if (payload.stream === "lifecycle") {
    if (data.phase === "start") {
      return [{ type: "agent.status", occurredAt, payload: { state: "thinking" } }]
    }
    if (data.phase === "end") {
      return [{ type: "agent.status", occurredAt, payload: { state: "idle" } }]
    }
    if (data.phase === "error") {
      return [{
        type: "turn.failed",
        occurredAt,
        payload: {
          code: "openclaw_run_error",
          message: "OpenClaw avslutade agentkörningen med ett fel.",
          retryable: true,
        },
      }]
    }
    return []
  }

  if (payload.stream === "tool" && (data.phase === "start" || data.phase === "result")) {
    const name = typeof data.name === "string" ? data.name.trim().toLowerCase() : ""
    const rawToolCallId = typeof data.toolCallId === "string" ? data.toolCallId : ""
    const capability = toolCapability(name)
    if (!capability || !context.capabilities.includes(capability)) {
      throw new Error("openclaw_unauthorized_tool_event")
    }
    const toolCallId = opaqueIdentifier("tool", rawToolCallId || `${context.runId}:${name}`)
    if (data.phase === "start") {
      if (capability === "build.request") {
        if (context.state.buildRequestToolCallId !== null) {
          throw new Error("openclaw_duplicate_build_request")
        }
        context.state.buildRequestToolCallId = toolCallId
      }
      return [{
        type: "tool.started",
        occurredAt,
        payload: {
          toolCallId,
          capability,
          safeLabel: name.slice(0, 240),
        },
      }]
    }
    return [{
      type: "tool.completed",
      occurredAt,
      payload: {
        toolCallId,
        status: data.isError === true ? "failed" : "passed",
        receipts: [],
        artifacts: [],
      },
    }]
  }

  return []
}
