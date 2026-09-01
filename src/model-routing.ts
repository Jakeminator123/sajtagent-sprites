import { z } from "zod"

import type { BuildJobV1 } from "../contracts/builder-v1.ts"
import type {
  AgentTurnPolicyV1,
  AgentTurnRequestV1,
} from "../contracts/agent-session-v1.ts"

export const OpenClawModelRouteV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    tier: z.enum(["fast", "balanced", "deep"]),
    model: z.enum([
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
    ]),
    thinkingLevel: z.enum(["off", "low", "medium", "high", "xhigh"]),
    reasoningVisibility: z.literal("off"),
    reasonCode: z.enum([
      "small_bounded_change",
      "routine_workspace_change",
      "complex_or_high_risk_change",
      "simple_conversation",
      "routine_conversation",
      "deep_conversation",
    ]),
  })
  .strict()

export type OpenClawModelRouteV1 = z.infer<
  typeof OpenClawModelRouteV1Schema
>

const COMPLEX_CAPABILITIES = new Set<BuildJobV1["executionPolicy"]["capabilities"][number]>([
  "browser.inspect",
  "command.execute",
  "packages.install",
  "preview.manage",
])

/**
 * Server-owned, deterministic routing. User text can affect the score, but it
 * cannot name a model or grant itself tools, network access, or a larger budget.
 */
export function routeBuildJobModelV1(job: BuildJobV1): OpenClawModelRouteV1 {
  const policy = job.executionPolicy
  const complexCapabilityCount = policy.capabilities.filter((capability) =>
    COMPLEX_CAPABILITIES.has(capability)
  ).length
  const isComplex =
    job.intent.intentType === "site.create" ||
    job.intent.context.planMode === true ||
    complexCapabilityCount >= 2 ||
    policy.maxSteps >= 80 ||
    policy.maxToolCalls >= 200 ||
    policy.maxModelTokens >= 200_000 ||
    job.intent.message.length >= 4_000

  if (isComplex) {
    const useXHigh =
      job.intent.context.planMode === true ||
      policy.maxSteps >= 120 ||
      policy.maxModelTokens >= 500_000 ||
      complexCapabilityCount >= 3
    return OpenClawModelRouteV1Schema.parse({
      schemaVersion: 1,
      tier: "deep",
      model: "openai/gpt-5.6-sol",
      thinkingLevel: useXHigh ? "xhigh" : "high",
      reasoningVisibility: "off",
      reasonCode: "complex_or_high_risk_change",
    })
  }

  const isSmall =
    job.intent.intentType !== "site.create" &&
    job.intent.message.length <= 500 &&
    policy.maxSteps <= 12 &&
    policy.maxToolCalls <= 30 &&
    policy.maxModelTokens <= 20_000 &&
    complexCapabilityCount === 0

  if (isSmall) {
    return OpenClawModelRouteV1Schema.parse({
      schemaVersion: 1,
      tier: "fast",
      model: "openai/gpt-5.6-luna",
      thinkingLevel: "off",
      reasoningVisibility: "off",
      reasonCode: "small_bounded_change",
    })
  }

  return OpenClawModelRouteV1Schema.parse({
    schemaVersion: 1,
    tier: "balanced",
    model: "openai/gpt-5.6-terra",
    thinkingLevel: complexCapabilityCount > 0 ? "medium" : "low",
    reasoningVisibility: "off",
    reasonCode: "routine_workspace_change",
  })
}

/**
 * Direct SiteAgent turns are routed independently from BuildJobV1. The Site
 * supplies a bounded policy, while Runtime alone selects the concrete model
 * and thinking effort. Reasoning visibility remains off: more thinking is a
 * compute choice, not permission to expose hidden reasoning traces.
 */
export function routeAgentTurnModelV1(
  turn: AgentTurnRequestV1,
  policy: AgentTurnPolicyV1,
): OpenClawModelRouteV1 {
  const mode = turn.uiContext.mode
  const isDeep =
    mode === "analyzed" ||
    mode === "audit" ||
    mode === "template" ||
    policy.capabilities.includes("build.request") ||
    policy.maxModelTokens >= 120_000 ||
    turn.message.length >= 4_000

  if (isDeep) {
    const useXHigh =
      mode === "analyzed" ||
      mode === "audit" ||
      policy.maxModelTokens >= 250_000 ||
      turn.message.length >= 8_000
    return OpenClawModelRouteV1Schema.parse({
      schemaVersion: 1,
      tier: "deep",
      model: "openai/gpt-5.6-sol",
      thinkingLevel: useXHigh ? "xhigh" : "high",
      reasoningVisibility: "off",
      reasonCode: "deep_conversation",
    })
  }

  const isSimple =
    turn.message.length <= 500 &&
    policy.maxToolCalls === 0 &&
    policy.maxModelTokens <= 20_000 &&
    (mode === undefined || mode === "freeform")

  if (isSimple) {
    return OpenClawModelRouteV1Schema.parse({
      schemaVersion: 1,
      tier: "fast",
      model: "openai/gpt-5.6-luna",
      thinkingLevel: "off",
      reasoningVisibility: "off",
      reasonCode: "simple_conversation",
    })
  }

  return OpenClawModelRouteV1Schema.parse({
    schemaVersion: 1,
    tier: "balanced",
    model: "openai/gpt-5.6-terra",
    thinkingLevel: policy.maxToolCalls > 0 ? "medium" : "low",
    reasoningVisibility: "off",
    reasonCode: "routine_conversation",
  })
}
