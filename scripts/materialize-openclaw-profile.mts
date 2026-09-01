import { readFile } from "node:fs/promises"

import {
  AgentProfileV1Schema,
  type AgentProfileV1,
} from "../contracts/agent-profile-v1.ts"
import { materializeOpenClawProfileV1 } from "../src/materialize-profile.ts"

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputDir = optionValue("--output")
if (!outputDir) {
  console.error(
    "Usage: npm run profile:materialize -- --output <workspace> [--profile <AgentProfileV1.json>]",
  )
  process.exit(2)
}

let profile: AgentProfileV1 | undefined
const profilePath = optionValue("--profile")
if (profilePath) {
  const input = JSON.parse(await readFile(profilePath, "utf8")) as unknown
  const candidate =
    typeof input === "object" && input !== null && "profile" in input
      ? (input as { profile: unknown }).profile
      : input
  profile = AgentProfileV1Schema.parse(candidate)
}

const bundle = await materializeOpenClawProfileV1({ outputDir, profile })
console.log(
  JSON.stringify(
    {
      profileId: bundle.profile.profileId,
      revision: bundle.profile.revision,
      ceilingId: bundle.effectivePolicy.ceilingId,
      capabilities: bundle.effectivePolicy.capabilities,
      findings: bundle.effectivePolicy.findings,
      outputDir,
    },
    null,
    2,
  ),
)
