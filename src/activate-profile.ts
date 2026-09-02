import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, parse, relative, resolve, sep } from "node:path"
import { z } from "zod"

import {
  AgentProfileV1Schema,
  compilePortableOpenClawBundleV1,
  type AgentHostCeilingV1,
  type AgentProfileV1,
  type PortableOpenClawBundleV1,
} from "../contracts/agent-profile-v1.ts"
import {
  AgentProfileActivationReceiptV1Schema,
  type AgentProfileActivationReceiptV1,
  type AgentProfileActivationRequestV1,
} from "../contracts/agent-profile-activation-v1.ts"

const PROFILE_BUNDLE_FILE_V1 = ".siteagent-profile-v1.json"
const PROFILE_ACTIVATION_STATE_FILE_V1 = ".siteagent-profile-activation-v1.json"

const AgentProfileActivationStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: z.string().min(1).max(160),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: AgentProfileActivationReceiptV1Schema,
  })
  .strict()

type ActiveProfileV1 = {
  profile: AgentProfileV1
  bundleSha256: string
  state: z.infer<typeof AgentProfileActivationStateV1Schema> | null
}

export class AgentProfileActivationErrorV1 extends Error {
  readonly code:
    | "active_profile_revision_conflict"
    | "activation_idempotency_conflict"
    | "active_profile_state_invalid"
    | "profile_activation_failed"
  readonly activeRevision?: number

  constructor(
    code:
      | "active_profile_revision_conflict"
      | "activation_idempotency_conflict"
      | "active_profile_state_invalid"
      | "profile_activation_failed",
    message: string,
    activeRevision?: number,
  ) {
    super(message)
    this.code = code
    this.activeRevision = activeRevision
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function serializeBundle(bundle: PortableOpenClawBundleV1): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

function requireContainedPath(root: string, candidate: string): void {
  const relation = relative(resolve(root), resolve(candidate))
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`)
  ) {
    throw new AgentProfileActivationErrorV1(
      "profile_activation_failed",
      "Profilaktiveringen beräknade en sökväg utanför OpenClaw-workspacet.",
    )
  }
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

async function readActiveProfileV1(
  outputDir: string,
  ceiling: AgentHostCeilingV1,
): Promise<ActiveProfileV1 | null> {
  const bundleBytes = await readOptional(join(outputDir, PROFILE_BUNDLE_FILE_V1))
  if (!bundleBytes) return null

  try {
    const decoded = JSON.parse(bundleBytes.toString("utf8")) as { profile?: unknown }
    const profile = AgentProfileV1Schema.parse(decoded.profile)
    const bundle = compilePortableOpenClawBundleV1(profile, ceiling)
    const stateBytes = await readOptional(
      join(outputDir, PROFILE_ACTIVATION_STATE_FILE_V1),
    )
    const state = stateBytes
      ? AgentProfileActivationStateV1Schema.parse(
          JSON.parse(stateBytes.toString("utf8")),
        )
      : null
    const bundleSha256 = sha256(serializeBundle(bundle))
    if (
      state &&
      (state.receipt.profileId !== profile.profileId ||
        state.receipt.revision !== profile.revision ||
        state.receipt.bundleSha256 !== bundleSha256)
    ) {
      throw new Error("activation_state_bundle_mismatch")
    }
    return {
      profile,
      bundleSha256,
      state,
    }
  } catch {
    throw new AgentProfileActivationErrorV1(
      "active_profile_state_invalid",
      "Den befintliga OpenClaw-profilens tillstånd kunde inte valideras.",
    )
  }
}

async function replaceKnownProfileFilesV1(options: {
  outputDir: string
  bundle: PortableOpenClawBundleV1
  state: z.infer<typeof AgentProfileActivationStateV1Schema>
}): Promise<void> {
  const outputDir = resolve(options.outputDir)
  if (outputDir === parse(outputDir).root) {
    throw new AgentProfileActivationErrorV1(
      "profile_activation_failed",
      "OpenClaw-profilen får inte aktiveras i filsystemets rot.",
    )
  }

  await mkdir(outputDir, { recursive: true })
  const stageDir = join(outputDir, `.siteagent-profile-stage-${randomUUID()}`)
  requireContainedPath(outputDir, stageDir)
  await mkdir(stageDir, { recursive: false })

  const files = new Map<string, string>([
    ...Object.entries(options.bundle.files),
    [PROFILE_BUNDLE_FILE_V1, serializeBundle(options.bundle)],
    [
      PROFILE_ACTIVATION_STATE_FILE_V1,
      `${JSON.stringify(options.state, null, 2)}\n`,
    ],
  ])
  const previous = new Map<string, Buffer | null>()
  const replaced: string[] = []

  try {
    for (const [relativePath, content] of files) {
      const staged = resolve(stageDir, relativePath)
      const target = resolve(outputDir, relativePath)
      requireContainedPath(stageDir, staged)
      requireContainedPath(outputDir, target)
      await mkdir(dirname(staged), { recursive: true })
      await mkdir(dirname(target), { recursive: true })
      previous.set(relativePath, await readOptional(target))
      await writeFile(staged, content, { encoding: "utf8", mode: 0o644 })
    }

    for (const relativePath of files.keys()) {
      const staged = resolve(stageDir, relativePath)
      const target = resolve(outputDir, relativePath)
      await rename(staged, target)
      replaced.push(relativePath)
    }
  } catch (error) {
    for (const relativePath of replaced.reverse()) {
      const target = resolve(outputDir, relativePath)
      const oldContent = previous.get(relativePath)
      if (oldContent === null) {
        await rm(target, { force: true })
      } else if (oldContent) {
        await writeFile(target, oldContent, { mode: 0o644 })
      }
    }
    if (error instanceof AgentProfileActivationErrorV1) throw error
    throw new AgentProfileActivationErrorV1(
      "profile_activation_failed",
      "OpenClaw-profilens filer kunde inte aktiveras.",
    )
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

export class AgentProfileActivatorV1 {
  private queue: Promise<void> = Promise.resolve()
  private readonly options: {
    outputDir: string
    ceiling: AgentHostCeilingV1
  }

  constructor(options: { outputDir: string; ceiling: AgentHostCeilingV1 }) {
    this.options = options
  }

  activate(
    input: AgentProfileActivationRequestV1,
    requestDigest: string,
  ): Promise<AgentProfileActivationReceiptV1> {
    const operation = this.queue.then(() =>
      this.activateExclusive(input, requestDigest),
    )
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async activateExclusive(
    input: AgentProfileActivationRequestV1,
    requestDigest: string,
  ): Promise<AgentProfileActivationReceiptV1> {
    const current = await readActiveProfileV1(
      this.options.outputDir,
      this.options.ceiling,
    )
    if (current?.state?.idempotencyKey === input.idempotencyKey) {
      if (current.state.requestDigest !== requestDigest) {
        throw new AgentProfileActivationErrorV1(
          "activation_idempotency_conflict",
          "Samma idempotencyKey har använts med ett annat profilinnehåll.",
          current.profile.revision,
        )
      }
      return current.state.receipt
    }

    if (
      input.expectedActiveRevision !== undefined &&
      input.expectedActiveRevision !== current?.profile.revision
    ) {
      throw new AgentProfileActivationErrorV1(
        "active_profile_revision_conflict",
        "Den aktiva profilrevisionen ändrades innan aktiveringen.",
        current?.profile.revision,
      )
    }

    const bundle = compilePortableOpenClawBundleV1(
      input.profile,
      this.options.ceiling,
    )
    const serializedBundle = serializeBundle(bundle)
    const bundleSha256 = sha256(serializedBundle)
    if (
      current &&
      input.profile.revision <= current.profile.revision &&
      bundleSha256 !== current.bundleSha256
    ) {
      throw new AgentProfileActivationErrorV1(
        "active_profile_revision_conflict",
        "En ändrad profil måste ha en högre revision än den aktiva profilen.",
        current.profile.revision,
      )
    }

    const receipt = AgentProfileActivationReceiptV1Schema.parse({
      schemaVersion: 1,
      activated: true,
      profileId: bundle.profile.profileId,
      revision: bundle.profile.revision,
      activatedAt: new Date().toISOString(),
      activationId: input.activationId,
      bundleSha256,
      takesEffect: "next-run",
      effectivePolicy: bundle.effectivePolicy,
      runtime: {
        service: "sajtagent-sprites-runtime",
        mode: "openclaw-workspace",
      },
    })
    const state = AgentProfileActivationStateV1Schema.parse({
      schemaVersion: 1,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      receipt,
    })
    await replaceKnownProfileFilesV1({
      outputDir: this.options.outputDir,
      bundle,
      state,
    })
    return receipt
  }
}
