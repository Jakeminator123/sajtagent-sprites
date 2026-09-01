import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import {
  ArtifactReadRequestV1Schema,
  ArtifactReadResponseV1Schema,
  validateArtifactReadResponseV1,
} from "../contracts/artifact-read-v1.ts"

const FixtureManifestSchema = z
  .object({
    schemaCases: z.array(
      z
        .object({
          name: z.string().min(1),
          schema: z.enum(["request", "response"]),
          expectValid: z.boolean(),
          value: z.unknown(),
        })
        .strict(),
    ),
    bindingCases: z.array(
      z
        .object({
          name: z.string().min(1),
          expectValid: z.boolean(),
          requestCase: z.number().int().nonnegative(),
          responseCase: z.number().int().nonnegative(),
          responsePatch: z.record(z.unknown()).optional(),
        })
        .strict(),
    ),
  })
  .strict()

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const contractPath = resolve(scriptDirectory, "../contracts/artifact-read-v1.ts")
const fixturePath = resolve(
  scriptDirectory,
  "../contracts/fixtures/artifact-read-v1.fixtures.json",
)
const contractSource = readFileSync(contractPath, "utf8")
const fixtureSource = readFileSync(fixturePath, "utf8")
const fixtures = FixtureManifestSchema.parse(JSON.parse(fixtureSource))

const failures: string[] = []
let assertionCount = 0

for (const fixture of fixtures.schemaCases) {
  const result = fixture.schema === "request"
    ? ArtifactReadRequestV1Schema.safeParse(fixture.value)
    : ArtifactReadResponseV1Schema.safeParse(fixture.value)
  assertionCount += 1
  if (result.success !== fixture.expectValid) {
    failures.push(
      `${fixture.name}: expected valid=${fixture.expectValid}, received valid=${result.success}`,
    )
  }
}

for (const fixture of fixtures.bindingCases) {
  const requestFixture = fixtures.schemaCases[fixture.requestCase]
  const responseFixture = fixtures.schemaCases[fixture.responseCase]
  if (!requestFixture || !responseFixture) {
    failures.push(`${fixture.name}: fixture index is out of range`)
    continue
  }
  const response = {
    ...(responseFixture.value as Record<string, unknown>),
    ...fixture.responsePatch,
  }
  const result = validateArtifactReadResponseV1(requestFixture.value, response)
  assertionCount += 1
  if (result.success !== fixture.expectValid) {
    failures.push(
      `${fixture.name}: expected valid=${fixture.expectValid}, received valid=${result.success}`,
    )
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = 1
} else {
  const digest = createHash("sha256")
    .update(contractSource)
    .update("\0")
    .update(fixtureSource)
    .digest("hex")
  console.log(`PASS artifact read contract v1: ${assertionCount} assertions`)
  console.log(`artifact-read-contract-fixture-sha256 ${digest}`)
}
