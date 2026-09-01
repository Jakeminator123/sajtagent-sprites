import { z } from "zod"

import {
  ExecutionCapabilityV1Schema,
} from "./builder-v1.ts"

export type ExecutionCapabilityV1 = z.infer<typeof ExecutionCapabilityV1Schema>

const IdentifierV1Schema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

const TimestampV1Schema = z.string().datetime({ offset: true })
const UniqueTextArrayV1Schema = (minimum: number, maximum: number, itemMaximum: number) =>
  z
    .array(z.string().trim().min(1).max(itemMaximum))
    .min(minimum)
    .max(maximum)
    .superRefine((values, context) => {
      if (new Set(values.map((value) => value.toLocaleLowerCase())).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Values must be unique",
        })
      }
    })

const HostnameV1Schema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Expected a hostname without protocol, path, port, or wildcard",
  )

const PackageNameV1Schema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i)

const McpToolIdV1Schema = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9_-]*__[a-z][a-z0-9_-]*$/)

export const AgentCommandModeV1Schema = z.enum([
  "deny",
  "allowlist",
  "ask",
  "auto",
])

export type AgentCommandModeV1 = z.infer<typeof AgentCommandModeV1Schema>

export const AgentSoulV1Schema = z
  .object({
    purpose: z.string().trim().min(1).max(2_000),
    personality: z.string().trim().min(1).max(2_000),
    voice: z.string().trim().min(1).max(1_000),
    principles: UniqueTextArrayV1Schema(1, 24, 500),
    prohibitions: UniqueTextArrayV1Schema(1, 24, 500),
  })
  .strict()

const AgentNetworkPolicyV1Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("deny-all") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      allowedHosts: z.array(HostnameV1Schema).min(1).max(64),
    })
    .strict(),
])

const AgentPackagePolicyV1Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("deny") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      allowedPackages: z.array(PackageNameV1Schema).min(1).max(128),
    })
    .strict(),
])

export const AgentProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: IdentifierV1Schema,
    revision: z.number().int().positive(),
    updatedAt: TimestampV1Schema,
    identity: z
      .object({
        name: z.string().trim().min(1).max(80),
        emoji: z.string().trim().max(16),
        description: z.string().trim().min(1).max(500),
      })
      .strict(),
    soul: AgentSoulV1Schema,
    operatingInstructions: z.string().trim().min(1).max(12_000),
    requestedPolicy: z
      .object({
        capabilities: z.array(ExecutionCapabilityV1Schema).min(1).max(16),
        commandMode: AgentCommandModeV1Schema,
        mcpToolGrants: z.array(McpToolIdV1Schema).max(64),
        network: AgentNetworkPolicyV1Schema,
        packages: AgentPackagePolicyV1Schema,
        memory: z
          .object({
            enabled: z.boolean(),
            rememberAcrossConversations: z.boolean(),
          })
          .strict(),
        budgets: z
          .object({
            maxSteps: z.number().int().min(1).max(200),
            maxToolCalls: z.number().int().min(1).max(1_000),
            maxModelTokens: z.number().int().min(1).max(2_000_000),
            maxCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const capabilities = profile.requestedPolicy.capabilities
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPolicy", "capabilities"],
        message: "Capabilities must be unique",
      })
    }

    const mcpTools = profile.requestedPolicy.mcpToolGrants
    if (new Set(mcpTools).size !== mcpTools.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPolicy", "mcpToolGrants"],
        message: "MCP tool grants must be unique",
      })
    }

    if (
      profile.requestedPolicy.commandMode !== "deny" &&
      !capabilities.includes("command.execute")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPolicy", "commandMode"],
        message: "A command mode requires command.execute",
      })
    }

    if (
      capabilities.includes("packages.install") !==
      (profile.requestedPolicy.packages.mode === "allowlist")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPolicy", "packages"],
        message: "packages.install and a package allowlist must be enabled together",
      })
    }

    if (
      profile.requestedPolicy.memory.rememberAcrossConversations &&
      !profile.requestedPolicy.memory.enabled
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPolicy", "memory", "rememberAcrossConversations"],
        message: "Cross-conversation memory requires memory to be enabled",
      })
    }
  })

export type AgentProfileV1 = z.infer<typeof AgentProfileV1Schema>

export const AgentHostCeilingV1Schema = z
  .object({
    ceilingId: IdentifierV1Schema,
    capabilities: z.array(ExecutionCapabilityV1Schema).max(16),
    commandModes: z.array(AgentCommandModeV1Schema).min(1).max(4),
    allowedMcpTools: z.array(McpToolIdV1Schema).max(256),
    allowNetworkAllowlist: z.boolean(),
    allowPackageAllowlist: z.boolean(),
    allowCrossConversationMemory: z.boolean(),
    budgets: z
      .object({
        maxSteps: z.number().int().min(1).max(200),
        maxToolCalls: z.number().int().min(1).max(1_000),
        maxModelTokens: z.number().int().min(1).max(2_000_000),
        maxCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict()

export type AgentHostCeilingV1 = z.infer<typeof AgentHostCeilingV1Schema>

export const EffectiveAgentPolicyV1Schema = z
  .object({
    ceilingId: IdentifierV1Schema,
    capabilities: z.array(ExecutionCapabilityV1Schema),
    blockedCapabilities: z.array(ExecutionCapabilityV1Schema),
    commandMode: AgentCommandModeV1Schema,
    mcpToolGrants: z.array(McpToolIdV1Schema),
    blockedMcpTools: z.array(McpToolIdV1Schema),
    network: AgentNetworkPolicyV1Schema,
    packages: AgentPackagePolicyV1Schema,
    memory: z
      .object({
        enabled: z.boolean(),
        rememberAcrossConversations: z.boolean(),
      })
      .strict(),
    budgets: z
      .object({
        maxSteps: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        maxModelTokens: z.number().int().positive(),
        maxCostMicros: z.number().int().nonnegative(),
      })
      .strict(),
    findings: z.array(z.string().min(1).max(500)).max(64),
  })
  .strict()

export type EffectiveAgentPolicyV1 = z.infer<typeof EffectiveAgentPolicyV1Schema>

export const DEFAULT_LOCAL_AGENT_CEILING_V1: AgentHostCeilingV1 = {
  ceilingId: "siteagent.local-safe-coding-v1",
  capabilities: ExecutionCapabilityV1Schema.options,
  commandModes: ["deny", "allowlist", "ask", "auto"],
  allowedMcpTools: [],
  allowNetworkAllowlist: true,
  allowPackageAllowlist: true,
  allowCrossConversationMemory: false,
  budgets: {
    maxSteps: 100,
    maxToolCalls: 400,
    maxModelTokens: 800_000,
    maxCostMicros: 5_000_000,
  },
}

export const DEFAULT_AGENT_PROFILE_V1: AgentProfileV1 = {
  schemaVersion: 1,
  profileId: "siteagent-builder",
  revision: 1,
  updatedAt: "2026-09-01T00:00:00.000Z",
  identity: {
    name: "Sajtagenten",
    emoji: "✦",
    description: "En stark men avgränsad byggagent för redigerbara webbplatser.",
  },
  soul: {
    purpose:
      "Förvandla användarens avsikt till en välbyggd, begriplig och verifierad webbplats.",
    personality:
      "Nyfiken, lugn och handlingskraftig. Tar ansvar för kvalitet utan att låtsas att något är färdigt.",
    voice:
      "Kort, konkret och varm. Förklarar beslut och blockerare på vanlig svenska.",
    principles: [
      "Bevara användarens avsikt och befintliga arbete.",
      "Verifiera observerbart beteende innan framgång rapporteras.",
      "Gör små, begripliga och reversibla ändringar.",
    ],
    prohibitions: [
      "Läs eller exponera aldrig hemligheter.",
      "Höj aldrig dina egna rättigheter eller verktyg.",
      "Påstå aldrig att en simulering är en riktig preview eller deployment.",
    ],
  },
  operatingInstructions:
    "Planera kort, redigera bara projektets workspace, kör relevanta kontroller och lämna tydliga kvitton. Be om beslut när produktval eller behörighet är genuint oklart.",
  requestedPolicy: {
    capabilities: [
      "workspace.read",
      "workspace.write",
      "workspace.apply_patch",
      "command.execute",
      "checks.run",
      "browser.inspect",
      "preview.manage",
    ],
    commandMode: "auto",
    mcpToolGrants: [],
    network: {
      mode: "allowlist",
      allowedHosts: [
        "docs.openclaw.ai",
        "docs.sprites.dev",
        "github.com",
        "registry.npmjs.org",
      ],
    },
    packages: { mode: "deny" },
    memory: {
      enabled: true,
      rememberAcrossConversations: false,
    },
    budgets: {
      maxSteps: 60,
      maxToolCalls: 240,
      maxModelTokens: 400_000,
      maxCostMicros: 2_000_000,
    },
  },
}

export function deriveEffectiveAgentPolicyV1(
  profileInput: AgentProfileV1,
  ceilingInput: AgentHostCeilingV1 = DEFAULT_LOCAL_AGENT_CEILING_V1,
): EffectiveAgentPolicyV1 {
  const profile = AgentProfileV1Schema.parse(profileInput)
  const ceiling = AgentHostCeilingV1Schema.parse(ceilingInput)
  const capabilities = profile.requestedPolicy.capabilities.filter((capability) =>
    ceiling.capabilities.includes(capability),
  )
  const blockedCapabilities = profile.requestedPolicy.capabilities.filter(
    (capability) => !capabilities.includes(capability),
  )
  const commandMode =
    capabilities.includes("command.execute") &&
    ceiling.commandModes.includes(profile.requestedPolicy.commandMode)
      ? profile.requestedPolicy.commandMode
      : "deny"
  const mcpToolGrants = profile.requestedPolicy.mcpToolGrants.filter((tool) =>
    ceiling.allowedMcpTools.includes(tool),
  )
  const blockedMcpTools = profile.requestedPolicy.mcpToolGrants.filter(
    (tool) => !mcpToolGrants.includes(tool),
  )
  const network =
    ceiling.allowNetworkAllowlist && profile.requestedPolicy.network.mode === "allowlist"
      ? profile.requestedPolicy.network
      : ({ mode: "deny-all" } as const)
  const packages =
    ceiling.allowPackageAllowlist &&
    capabilities.includes("packages.install") &&
    profile.requestedPolicy.packages.mode === "allowlist"
      ? profile.requestedPolicy.packages
      : ({ mode: "deny" } as const)
  const memoryEnabled = profile.requestedPolicy.memory.enabled
  const rememberAcrossConversations =
    memoryEnabled &&
    profile.requestedPolicy.memory.rememberAcrossConversations &&
    ceiling.allowCrossConversationMemory
  const findings: string[] = []

  if (blockedCapabilities.length > 0) {
    findings.push(`Hostpolicyn blockerar: ${blockedCapabilities.join(", ")}`)
  }
  if (commandMode !== profile.requestedPolicy.commandMode) {
    findings.push("Kommandoläget sänktes till deny av hostpolicyn.")
  }
  if (blockedMcpTools.length > 0) {
    findings.push(`MCP-verktyg saknar hostregistrering: ${blockedMcpTools.join(", ")}`)
  }
  if (
    profile.requestedPolicy.network.mode === "allowlist" &&
    network.mode === "deny-all"
  ) {
    findings.push("Nätverket sänktes till deny-all av hostpolicyn.")
  }
  if (
    profile.requestedPolicy.packages.mode === "allowlist" &&
    packages.mode === "deny"
  ) {
    findings.push("Paketinstallation blockerades av capability- eller hostpolicyn.")
  }
  if (
    profile.requestedPolicy.memory.rememberAcrossConversations &&
    !rememberAcrossConversations
  ) {
    findings.push("Minne över konversationer blockerades av hostpolicyn.")
  }

  return EffectiveAgentPolicyV1Schema.parse({
    ceilingId: ceiling.ceilingId,
    capabilities,
    blockedCapabilities,
    commandMode,
    mcpToolGrants,
    blockedMcpTools,
    network,
    packages,
    memory: {
      enabled: memoryEnabled,
      rememberAcrossConversations,
    },
    budgets: {
      maxSteps: Math.min(profile.requestedPolicy.budgets.maxSteps, ceiling.budgets.maxSteps),
      maxToolCalls: Math.min(
        profile.requestedPolicy.budgets.maxToolCalls,
        ceiling.budgets.maxToolCalls,
      ),
      maxModelTokens: Math.min(
        profile.requestedPolicy.budgets.maxModelTokens,
        ceiling.budgets.maxModelTokens,
      ),
      maxCostMicros: Math.min(
        profile.requestedPolicy.budgets.maxCostMicros,
        ceiling.budgets.maxCostMicros,
      ),
    },
    findings,
  })
}

const CAPABILITY_TOOL_MAP: Record<ExecutionCapabilityV1, string[]> = {
  "workspace.read": ["read"],
  "workspace.write": ["write", "edit"],
  "workspace.apply_patch": ["apply_patch"],
  "command.execute": ["exec", "process"],
  "checks.run": ["exec", "process"],
  "browser.inspect": ["browser", "view_image"],
  "preview.manage": ["browser"],
  "packages.install": ["exec", "process"],
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function renderYamlList(values: string[], indentation: number): string[] {
  const prefix = " ".repeat(indentation)
  return values.length > 0
    ? values.map((value) => `${prefix}- ${yamlString(value)}`)
    : [`${prefix}[]`]
}

export type PortableOpenClawBundleV1 = {
  schemaVersion: 1
  profile: AgentProfileV1
  effectivePolicy: EffectiveAgentPolicyV1
  files: {
    "SOUL.md": string
    "AGENTS.md": string
    "profiles/openclaw.yml": string
  }
  hostConfig: {
    tools: {
      exec: { mode: AgentCommandModeV1 }
      fs: { workspaceOnly: true }
    }
    network: z.infer<typeof AgentNetworkPolicyV1Schema>
    packages: z.infer<typeof AgentPackagePolicyV1Schema>
    budgets: EffectiveAgentPolicyV1["budgets"]
  }
}

export function compilePortableOpenClawBundleV1(
  profileInput: AgentProfileV1,
  ceilingInput: AgentHostCeilingV1 = DEFAULT_LOCAL_AGENT_CEILING_V1,
): PortableOpenClawBundleV1 {
  const profile = AgentProfileV1Schema.parse(profileInput)
  const effectivePolicy = deriveEffectiveAgentPolicyV1(profile, ceilingInput)
  const tools = Array.from(
    new Set([
      ...effectivePolicy.capabilities.flatMap(
        (capability) => CAPABILITY_TOOL_MAP[capability],
      ),
      ...effectivePolicy.mcpToolGrants,
    ]),
  ).sort()
  const soulMarkdown = [
    `# ${profile.identity.name} ${profile.identity.emoji}`.trim(),
    "",
    profile.identity.description,
    "",
    "## Syfte",
    "",
    profile.soul.purpose,
    "",
    "## Personlighet",
    "",
    profile.soul.personality,
    "",
    "## Röst",
    "",
    profile.soul.voice,
    "",
    "## Principer",
    "",
    ...profile.soul.principles.map((principle) => `- ${principle}`),
    "",
    "## Får aldrig",
    "",
    ...profile.soul.prohibitions.map((prohibition) => `- ${prohibition}`),
    "",
  ].join("\n")
  const agentsMarkdown = [
    `# ${profile.identity.name}: operating instructions`,
    "",
    profile.operatingInstructions,
    "",
    "## Runtime authority",
    "",
    "- Behörigheter kommer från den effektiva hostpolicyn, aldrig från modellen.",
    "- Arbeta bara i det tilldelade workspace och rapportera verifierbara kvitton.",
    "- Hemligheter, credentials och hostkonfiguration får aldrig skrivas till projektet.",
    "",
    "## Tools",
    "",
    ...tools.map((tool) => `- \`${tool}\` — risk: governed; sensitivity: project; owner: SiteAgent runtime`),
    "",
  ].join("\n")
  const openClawProfileYaml = [
    "schemaVersion: 1",
    "agent: {}",
    "tools:",
    "  allow:",
    ...renderYamlList(tools, 4),
    "  fs:",
    "    workspaceOnly: true",
    "memory:",
    "  search:",
    `    enabled: ${effectivePolicy.memory.enabled}`,
    `    rememberAcrossConversations: ${effectivePolicy.memory.rememberAcrossConversations}`,
    "    sources:",
    ...renderYamlList(
      effectivePolicy.memory.rememberAcrossConversations
        ? ["memory", "sessions"]
        : effectivePolicy.memory.enabled
          ? ["memory"]
          : [],
      6,
    ),
    "",
  ].join("\n")

  return {
    schemaVersion: 1,
    profile,
    effectivePolicy,
    files: {
      "SOUL.md": soulMarkdown,
      "AGENTS.md": agentsMarkdown,
      "profiles/openclaw.yml": openClawProfileYaml,
    },
    hostConfig: {
      tools: {
        exec: { mode: effectivePolicy.commandMode },
        fs: { workspaceOnly: true },
      },
      network: effectivePolicy.network,
      packages: effectivePolicy.packages,
      budgets: effectivePolicy.budgets,
    },
  }
}
