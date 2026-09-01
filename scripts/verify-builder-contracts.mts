import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import {
  BuilderContractSchemasV1,
  ContractSchemaNameV1Schema,
  validateBuildEventStreamV1,
} from "../contracts/builder-v1.ts"

const FixtureManifestSchema = z
  .object({
    schemaCases: z.array(
      z
        .object({
          name: z.string().min(1),
          schema: ContractSchemaNameV1Schema,
          expectValid: z.boolean(),
          value: z.unknown(),
        })
        .strict(),
    ),
    streamCases: z.array(
      z
        .object({
          name: z.string().min(1),
          expectValid: z.boolean(),
          afterSequence: z.number().int().nonnegative().optional(),
          requireTerminal: z.boolean().optional(),
          events: z.array(z.unknown()),
        })
        .strict(),
    ),
  })
  .strict()

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const contractPath = resolve(scriptDirectory, "../contracts/builder-v1.ts")
const fixturePath = resolve(
  scriptDirectory,
  "../contracts/fixtures/builder-v1.fixtures.json",
)

const contractSource = readFileSync(contractPath, "utf8")
const fixtureSource = readFileSync(fixturePath, "utf8")
const fixtures = FixtureManifestSchema.parse(JSON.parse(fixtureSource))

const failures: string[] = []
let assertionCount = 0

for (const fixture of fixtures.schemaCases) {
  const result = BuilderContractSchemasV1[fixture.schema].safeParse(fixture.value)
  assertionCount += 1
  if (result.success !== fixture.expectValid) {
    failures.push(
      `${fixture.name}: expected valid=${fixture.expectValid}, received valid=${result.success}`,
    )
  }
}

for (const fixture of fixtures.streamCases) {
  const result = validateBuildEventStreamV1(fixture.events, {
    afterSequence: fixture.afterSequence,
    requireTerminal: fixture.requireTerminal,
  })
  assertionCount += 1
  if (result.success !== fixture.expectValid) {
    failures.push(
      `${fixture.name}: expected valid=${fixture.expectValid}, received valid=${result.success}`,
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

  console.log(`PASS builder contract v1: ${assertionCount} assertions`)
  console.log(`contract-fixture-sha256 ${digest}`)
}
