import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import {
  AgentSessionContractNameV1Schema,
  AgentSessionContractSchemasV1,
  validateAgentEventBatchV1,
  validateAgentSessionHistoryV1,
  validateAgentTurnAgainstPolicyV1,
  validateAgentTurnEventStreamV1,
} from "../contracts/agent-session-v1.ts"

const FixtureManifestSchema = z
  .object({
    schemaCases: z.array(
      z
        .object({
          name: z.string().min(1),
          schema: AgentSessionContractNameV1Schema,
          expectValid: z.boolean(),
          value: z.unknown(),
        })
        .strict(),
    ),
    policyCases: z.array(
      z
        .object({
          name: z.string().min(1),
          expectValid: z.boolean(),
          session: z.unknown(),
          policy: z.unknown(),
          baseSequence: z.number().int().nonnegative().optional(),
          events: z.array(z.unknown()),
        })
        .strict(),
    ),
    streamCases: z.array(
      z
        .object({
          name: z.string().min(1),
          expectValid: z.boolean(),
          validation: z
            .enum(["turn", "session-history", "resume-batch"])
            .optional(),
          afterSequence: z.number().int().nonnegative().optional(),
          requireTerminal: z.boolean().optional(),
          events: z.array(z.unknown()),
        })
        .strict(),
    ),
  })
  .strict()

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const contractPath = resolve(
  scriptDirectory,
  "../contracts/agent-session-v1.ts",
)
const fixturePath = resolve(
  scriptDirectory,
  "../contracts/fixtures/agent-session-v1.fixtures.json",
)

const contractSource = readFileSync(contractPath, "utf8")
const fixtureSource = readFileSync(fixturePath, "utf8")
const fixtures = FixtureManifestSchema.parse(JSON.parse(fixtureSource))

const failures: string[] = []
let assertionCount = 0

for (const fixture of fixtures.schemaCases) {
  const result = AgentSessionContractSchemasV1[fixture.schema].safeParse(
    fixture.value,
  )
  assertionCount += 1
  if (result.success !== fixture.expectValid) {
    failures.push(
      `${fixture.name}: expected valid=${fixture.expectValid}, received valid=${result.success}`,
    )
  }
}

for (const fixture of fixtures.policyCases) {
  const result = validateAgentTurnAgainstPolicyV1(
    fixture.session,
    fixture.policy,
    fixture.events,
    { baseSequence: fixture.baseSequence },
  )
  assertionCount += 1
  if (result.success !== fixture.expectValid) {
    failures.push(
      `${fixture.name}: expected valid=${fixture.expectValid}, received valid=${result.success}${result.success ? "" : ` (${result.error})`}`,
    )
  }
}

for (const fixture of fixtures.streamCases) {
  const result =
    fixture.validation === "resume-batch"
      ? validateAgentEventBatchV1(fixture.events, {
          afterSequence: fixture.afterSequence,
        })
      : fixture.validation === "session-history"
        ? validateAgentSessionHistoryV1(fixture.events, {
            baseSequence: fixture.afterSequence,
            requireFinalTerminal: fixture.requireTerminal,
          })
        : validateAgentTurnEventStreamV1(fixture.events, {
            baseSequence: fixture.afterSequence,
            requireTerminal: fixture.requireTerminal,
          })
  assertionCount += 1
  if (result.success !== fixture.expectValid) {
    failures.push(
      `${fixture.name}: expected valid=${fixture.expectValid}, received valid=${result.success}${result.success ? "" : ` (${result.error})`}`,
    )
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`)
  }
  process.exitCode = 1
} else {
  const digest = createHash("sha256")
    .update(contractSource)
    .update("\0")
    .update(fixtureSource)
    .digest("hex")

  console.log(`PASS agent session contract v1: ${assertionCount} assertions`)
  console.log(`agent-session-contract-fixture-sha256 ${digest}`)
}
