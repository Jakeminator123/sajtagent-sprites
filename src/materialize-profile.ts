import { mkdir, writeFile } from "node:fs/promises"
import { parse, resolve } from "node:path"

import {
  DEFAULT_AGENT_PROFILE_V1,
  compilePortableOpenClawBundleV1,
  type AgentProfileV1,
  type PortableOpenClawBundleV1,
} from "../contracts/agent-profile-v1.ts"

export async function materializeOpenClawProfileV1(options: {
  outputDir: string
  profile?: AgentProfileV1
}): Promise<PortableOpenClawBundleV1> {
  const outputDir = resolve(options.outputDir)
  if (outputDir === parse(outputDir).root) {
    throw new Error("Refusing to materialize an OpenClaw profile at a filesystem root")
  }

  const bundle = compilePortableOpenClawBundleV1(
    options.profile ?? DEFAULT_AGENT_PROFILE_V1,
  )
  await mkdir(outputDir, { recursive: true })

  for (const [relativePath, content] of Object.entries(bundle.files)) {
    const target = resolve(outputDir, relativePath)
    if (!target.startsWith(`${outputDir}${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`Profile output escaped its workspace: ${relativePath}`)
    }
    await mkdir(resolve(target, ".."), { recursive: true })
    await writeFile(target, content, { encoding: "utf8", mode: 0o644 })
  }

  await writeFile(
    resolve(outputDir, ".siteagent-profile-v1.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  )
  return bundle
}
