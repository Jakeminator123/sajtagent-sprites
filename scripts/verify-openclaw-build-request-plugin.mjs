import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"

import {
  SITEAGENT_BUILD_REQUEST_TOOL_NAME,
  createSiteAgentBuildRequestTool,
} from "../openclaw-plugins/siteagent-build-request/dist/tool.js"

const pluginRoot = new URL(
  "../openclaw-plugins/siteagent-build-request/",
  import.meta.url,
)
const packageJson = JSON.parse(
  await readFile(new URL("package.json", pluginRoot), "utf8"),
)
const manifest = JSON.parse(
  await readFile(new URL("openclaw.plugin.json", pluginRoot), "utf8"),
)

assert.equal(SITEAGENT_BUILD_REQUEST_TOOL_NAME, "siteagent_build_request")
assert.deepEqual(packageJson.openclaw.extensions, ["./dist/index.js"])
assert.equal(packageJson.dependencies.typebox, "1.3.17")
assert.match(packageJson.peerDependencies.openclaw, /^>=2026\.5\.17/)
assert.equal(manifest.id, "siteagent-build-request")
assert.deepEqual(manifest.contracts.tools, [SITEAGENT_BUILD_REQUEST_TOOL_NAME])
assert.deepEqual(manifest.toolMetadata[SITEAGENT_BUILD_REQUEST_TOOL_NAME], {
  optional: true,
  sideEffecting: false,
})
assert.deepEqual(manifest.configSchema, {
  type: "object",
  additionalProperties: false,
  properties: {},
})

const definition = createSiteAgentBuildRequestTool((value) => value)
assert.equal(definition.name, SITEAGENT_BUILD_REQUEST_TOOL_NAME)
assert.equal(definition.optional, true)
assert.equal(definition.parameters.type, "object")
assert.equal(definition.parameters.additionalProperties, false)
assert.deepEqual(definition.parameters.properties, {})
assert.deepEqual(
  await definition.execute({}, {}, { signal: new AbortController().signal }),
  { handoff: "requested", authoritative: false },
)

const aborted = new AbortController()
aborted.abort()
assert.throws(
  () => definition.execute({}, {}, { signal: aborted.signal }),
  /aborted/i,
)

console.log("PASS OpenClaw build-request plugin: optional typed signal only")
