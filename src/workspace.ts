import { createHash, randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import { MAX_PREVIEW_ARTIFACT_BYTES_V1 } from "../contracts/artifact-read-v1.ts"
import type { BuildJobV1 } from "../contracts/builder-v1.ts"
import {
  buildSelfContainedPreviewV1,
  RUNTIME_PREVIEW_ARTIFACT_PATH_V1,
  SelfContainedPreviewErrorV1,
} from "./static-preview.ts"

const execFileAsync = promisify(execFile)
const MAX_CANDIDATE_FILES_V1 = 5_000
const MAX_CANDIDATE_FILE_BYTES_V1 = 4 * 1024 * 1024
const MAX_CANDIDATE_TOTAL_BYTES_V1 = 16 * 1024 * 1024
const MAX_GIT_OUTPUT_BYTES_V1 = 20 * 1024 * 1024
const ZERO_OID_V1 = "0".repeat(40)

const STARTER_INDEX_HTML_V1 = `<!doctype html>
<html lang="sv">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Min sajt</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f7f5; color: #171717; }
      main { width: min(42rem, calc(100% - 3rem)); }
    </style>
  </head>
  <body>
    <main>
      <h1>Din nya sajt</h1>
      <p>Beskriv i chatten vad Sajtagent ska bygga här.</p>
    </main>
  </body>
</html>
`

const STARTER_PACKAGE_JSON_V1 = `${JSON.stringify({
  name: "siteagent-static-site",
  private: true,
  version: "1.0.0",
  type: "module",
  scripts: { check: "node scripts/check-static-site.mjs" },
}, null, 2)}\n`

const STARTER_CHECK_SCRIPT_V1 = `import { readFile } from "node:fs/promises"

const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
if (!/<html(?:\\s|>)/iu.test(html) || !/<body(?:\\s|>)/iu.test(html)) {
  throw new Error("index.html must contain html and body elements")
}
console.log("static site check passed")
`

export type PreparedBuildWorkspaceV1 = {
  projectRepoDir: string
  workerDir: string
  baseCommit: string
  workspaceId: string
}

export type WorkspacePreparationErrorCode =
  | "workspace_revision_unavailable"
  | "workspace_base_dirty"
  | "stale_revision"
  | "workspace_prepare_failed"
  | "worker_no_changes"

export class WorkspacePreparationError extends Error {
  readonly code: WorkspacePreparationErrorCode
  readonly retryable: boolean

  constructor(code: WorkspacePreparationErrorCode, message: string, retryable: boolean) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

type CapturedFileV1 = {
  path: string
  mode: "100644" | "100755"
  bytes: Buffer
}

type GitTreeEntryV1 = {
  path: string
  mode: "100644" | "100755"
  oid: string
}

type FrozenStaticCheckV1 = {
  snapshotSha256: string
  summary: string
}

type FrozenPreviewV1 = {
  sourcePath: string
  bytes: Buffer
  sha256: string
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

export function projectRevisionRefV1(revisionId: string): string {
  return `refs/siteagent/revisions/${stableId(revisionId)}`
}

export function candidateRevisionIdV1(
  binding: { tenantId: string; projectId: string },
  baseCommit: string,
  candidateTree: string,
): string {
  return `revision:sha256:${createHash("sha256")
    .update("siteagent-revision-v1\0")
    .update(binding.tenantId)
    .update("\0")
    .update(binding.projectId)
    .update("\0")
    .update(baseCommit)
    .update("\0")
    .update(candidateTree)
    .digest("hex")}`
}

function safeGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const windows = process.platform === "win32"
  return {
    PATH: process.env.PATH || "",
    HOME: tmpdir(),
    TMP: process.env.TMP || tmpdir(),
    TEMP: process.env.TEMP || tmpdir(),
    ...(windows
      ? {
          SystemRoot: process.env.SystemRoot || "C:\\Windows",
          WINDIR: process.env.WINDIR || "C:\\Windows",
        }
      : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: windows ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  }
}

function safeGitArgs(args: string[]): string[] {
  return [
    "--no-replace-objects",
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]
}

async function git(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", safeGitArgs(args), {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES_V1,
    windowsHide: true,
    env: safeGitEnvironment(extraEnv),
  })
  return stdout.trimEnd()
}

async function gitBytes(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Buffer> {
  const result = await execFileAsync("git", safeGitArgs(args), {
    cwd,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT_BYTES_V1,
    windowsHide: true,
    env: safeGitEnvironment(extraEnv),
  }) as unknown as { stdout: Buffer }
  return result.stdout
}

async function gitWithInput(
  cwd: string,
  args: string[],
  input: Buffer,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", safeGitArgs(args), {
      cwd,
      windowsHide: true,
      env: safeGitEnvironment(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_GIT_OUTPUT_BYTES_V1) {
        child.kill()
        return
      }
      target.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.once("error", rejectPromise)
    child.once("close", (code) => {
      if (outputBytes > MAX_GIT_OUTPUT_BYTES_V1) {
        rejectPromise(new Error("git_output_limit_exceeded"))
        return
      }
      if (code !== 0) {
        rejectPromise(new Error(Buffer.concat(stderr).toString("utf8").trim()))
        return
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trimEnd())
    })
    child.stdin.end(input)
  })
}

async function requireContainedPath(root: string, candidate: string): Promise<void> {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const relation = relative(rootPath, candidatePath)
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Det beräknade workspace-målet ligger utanför den konfigurerade roten.",
      false,
    )
  }
}

async function requireRealContainedPath(root: string, candidate: string): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ])
  await requireContainedPath(realRoot, realCandidate)
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

function isRenameConflict(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false
  return ["EEXIST", "ENOTEMPTY", "EPERM"].includes(
    String((error as NodeJS.ErrnoException).code),
  )
}

async function assertRealDirectoryInside(root: string, candidate: string): Promise<void> {
  const stats = await lstat(candidate)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("not_a_real_directory")
  }
  await requireRealContainedPath(root, candidate)
}

function assertPortablePathV1(path: string): void {
  if (
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.split("/").includes("..") ||
    path.split("/").includes(".git") ||
    path.split("/").includes(".gitmodules")
  ) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Kandidaten innehåller en förbjuden workspace-sökväg.",
      false,
    )
  }
}

async function initializeStarterRepositoryV1(
  repoDir: string,
  baseRevisionId: string,
): Promise<void> {
  await git(repoDir, ["init", "--initial-branch=main"])
  await mkdir(join(repoDir, "scripts"))
  await Promise.all([
    writeFile(join(repoDir, "index.html"), STARTER_INDEX_HTML_V1, "utf8"),
    writeFile(join(repoDir, "package.json"), STARTER_PACKAGE_JSON_V1, "utf8"),
    writeFile(
      join(repoDir, "scripts", "check-static-site.mjs"),
      STARTER_CHECK_SCRIPT_V1,
      "utf8",
    ),
    writeFile(join(repoDir, ".gitignore"), "node_modules/\n", "utf8"),
  ])
  await git(repoDir, ["add", "--all"])
  await git(repoDir, [
    "-c",
    "user.name=Sajtagent Runtime",
    "-c",
    "user.email=runtime@siteagent.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "Sajtagent starter revision",
  ])
  const initialCommit = await git(repoDir, ["rev-parse", "HEAD^{commit}"])
  await git(repoDir, [
    "update-ref",
    projectRevisionRefV1(baseRevisionId),
    initialCommit,
    ZERO_OID_V1,
  ])
}

async function bootstrapInitialProjectV1(
  job: BuildJobV1,
  projectsRoot: string,
  projectRepoDir: string,
): Promise<void> {
  if (job.intent.intentType !== "site.create") {
    throw new WorkspacePreparationError(
      "workspace_revision_unavailable",
      "Projektets serverägda Git-checkout finns inte på Spriten ännu.",
      true,
    )
  }
  await mkdir(projectsRoot, { recursive: true })
  await assertRealDirectoryInside(resolve(projectsRoot, ".."), projectsRoot)
  const projectDir = dirname(projectRepoDir)
  await requireContainedPath(projectsRoot, projectDir)
  await mkdir(projectDir, { recursive: true })
  await assertRealDirectoryInside(projectsRoot, projectDir)
  const tempRepoDir = join(projectDir, `repo.tmp-${randomUUID()}`)
  await requireContainedPath(projectDir, tempRepoDir)
  try {
    await mkdir(tempRepoDir)
    await initializeStarterRepositoryV1(tempRepoDir, job.baseRevisionId)
    await git(tempRepoDir, [
      "rev-parse",
      "--verify",
      `${projectRevisionRefV1(job.baseRevisionId)}^{commit}`,
    ])
    try {
      await rename(tempRepoDir, projectRepoDir)
    } catch (error) {
      if (!isRenameConflict(error)) throw error
      await assertRealDirectoryInside(projectsRoot, projectRepoDir)
      await git(projectRepoDir, [
        "rev-parse",
        "--verify",
        `${projectRevisionRefV1(job.baseRevisionId)}^{commit}`,
      ])
    }
  } catch (error) {
    if (error instanceof WorkspacePreparationError) throw error
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Projektets initiala Git-projektion kunde inte skapas atomiskt.",
      true,
    )
  } finally {
    await rm(tempRepoDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function resolveProjectRevisionV1(
  projectRepoDir: string,
  binding: { tenantId: string; projectId: string },
  revisionId: string,
): Promise<string> {
  try {
    const mappedCommit = await git(projectRepoDir, [
      "rev-parse",
      "--verify",
      `${projectRevisionRefV1(revisionId)}^{commit}`,
    ])
    if (/^revision:sha256:[a-f0-9]{64}$/u.test(revisionId)) {
      const parents = (await git(projectRepoDir, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        mappedCommit,
      ])).split(" ")
      if (parents.length !== 2 || !parents[1]) throw new Error("invalid_parent")
      const tree = await git(projectRepoDir, ["rev-parse", `${mappedCommit}^{tree}`])
      if (candidateRevisionIdV1(binding, parents[1], tree) !== revisionId) {
        throw new Error("candidate_identity_mismatch")
      }
    }
    return mappedCommit
  } catch {
    throw new WorkspacePreparationError(
      "stale_revision",
      "BuildJobV1-revisionen saknar en verifierad Git-projektion på Spriten.",
      false,
    )
  }
}

async function readGitTreeEntriesV1(
  projectRepoDir: string,
  commit: string,
): Promise<GitTreeEntryV1[]> {
  const output = await gitBytes(projectRepoDir, ["ls-tree", "-r", "-z", commit])
  const entries: GitTreeEntryV1[] = []
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t")
    const header = tab >= 0 ? record.slice(0, tab) : ""
    const path = tab >= 0 ? record.slice(tab + 1) : ""
    const [mode, type, oid] = header.split(" ")
    assertPortablePathV1(path)
    if (
      type !== "blob" ||
      (mode !== "100644" && mode !== "100755") ||
      !/^[a-f0-9]{40}$/u.test(oid || "")
    ) {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Basrevisionen innehåller en otillåten Git-post.",
        false,
      )
    }
    entries.push({ path, mode, oid: oid! })
  }
  if (entries.length > MAX_CANDIDATE_FILES_V1) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Basrevisionen överskrider V1-gränsen för antal filer.",
      false,
    )
  }
  return entries
}

async function materializeCommitV1(
  projectRepoDir: string,
  baseCommit: string,
  workerDir: string,
): Promise<void> {
  const entries = await readGitTreeEntriesV1(projectRepoDir, baseCommit)
  let totalBytes = 0
  for (const entry of entries) {
    const bytes = await gitBytes(projectRepoDir, ["cat-file", "blob", entry.oid])
    if (bytes.byteLength > MAX_CANDIDATE_FILE_BYTES_V1) {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Basrevisionen innehåller en fil som överskrider V1-gränsen.",
        false,
      )
    }
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_CANDIDATE_TOTAL_BYTES_V1) {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Basrevisionen överskrider V1-gränsen för total filstorlek.",
        false,
      )
    }
    const target = join(workerDir, entry.path)
    await requireContainedPath(workerDir, target)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, {
      mode: entry.mode === "100755" ? 0o755 : 0o644,
    })
  }
}

export async function prepareBuildWorkspaceV1(
  job: BuildJobV1,
  options: { projectsRoot: string; workersRoot: string },
): Promise<PreparedBuildWorkspaceV1> {
  const projectKey = stableId(`${job.tenantId}\0${job.projectId}`)
  const workspaceId = stableId(`${job.jobId}\0${job.idempotencyKey}`)
  const projectRepoDir = join(options.projectsRoot, projectKey, "repo")
  const workerDir = join(options.workersRoot, workspaceId)
  await requireContainedPath(options.projectsRoot, projectRepoDir)
  await requireContainedPath(options.workersRoot, workerDir)
  try {
    await assertRealDirectoryInside(options.projectsRoot, projectRepoDir)
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw new WorkspacePreparationError(
        "workspace_revision_unavailable",
        "Projektets serverägda Git-checkout är inte en säker katalog.",
        false,
      )
    }
    await bootstrapInitialProjectV1(job, options.projectsRoot, projectRepoDir)
  }
  let baseCommit: string
  try {
    await git(projectRepoDir, ["rev-parse", "--is-inside-work-tree"])
    baseCommit = await resolveProjectRevisionV1(
      projectRepoDir,
      { tenantId: job.tenantId, projectId: job.projectId },
      job.baseRevisionId,
    )
  } catch (error) {
    if (error instanceof WorkspacePreparationError) throw error
    throw new WorkspacePreparationError(
      "workspace_revision_unavailable",
      "Projektets workspace är inte en läsbar Git-checkout.",
      true,
    )
  }
  await mkdir(options.workersRoot, { recursive: true })
  await assertRealDirectoryInside(resolve(options.workersRoot, ".."), options.workersRoot)
  try {
    await lstat(workerDir)
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Jobbets worker-katalog finns redan och återanvänds inte efter Runtime-restart.",
      true,
    )
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  const tempWorkerDir = join(
    options.workersRoot,
    `${workspaceId}.tmp-${randomUUID()}`,
  )
  await requireContainedPath(options.workersRoot, tempWorkerDir)
  try {
    await mkdir(tempWorkerDir)
    await materializeCommitV1(projectRepoDir, baseCommit, tempWorkerDir)
    await rename(tempWorkerDir, workerDir)
  } catch (error) {
    if (error instanceof WorkspacePreparationError) throw error
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Kunde inte materialisera jobbets isolerade filworkspace.",
      true,
    )
  } finally {
    await rm(tempWorkerDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await requireRealContainedPath(options.workersRoot, workerDir)
  return { projectRepoDir, workerDir, baseCommit, workspaceId }
}

async function captureWorkspaceFilesV1(workerDir: string): Promise<CapturedFileV1[]> {
  const files: CapturedFileV1[] = []
  let totalBytes = 0
  let visitedEntries = 0
  const realWorkerRoot = await realpath(workerDir)
  const requireCanonicalContainment = async (candidate: string): Promise<void> => {
    if (candidate !== realWorkerRoot) {
      await requireContainedPath(realWorkerRoot, candidate)
    }
  }
  const directoryIdentity = async (directory: string): Promise<{
    canonicalPath: string
    dev: bigint
    ino: bigint
  }> => {
    const linkStats = await lstat(directory, { bigint: true })
    if (!linkStats.isDirectory() || linkStats.isSymbolicLink()) {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Kandidaten innehåller en symlink eller annan otillåten filtyp.",
        false,
      )
    }
    const canonicalPath = await realpath(directory)
    await requireCanonicalContainment(canonicalPath)
    const canonicalStats = await stat(canonicalPath, { bigint: true })
    if (
      !canonicalStats.isDirectory() ||
      canonicalStats.dev !== linkStats.dev ||
      canonicalStats.ino !== linkStats.ino
    ) {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Kandidatens katalogidentitet ändrades under infrysningen.",
        true,
      )
    }
    return {
      canonicalPath,
      dev: canonicalStats.dev,
      ino: canonicalStats.ino,
    }
  }
  const assertSameDirectory = async (
    directory: string,
    expected: { canonicalPath: string; dev: bigint; ino: bigint },
  ): Promise<void> => {
    const current = await directoryIdentity(directory)
    if (
      current.canonicalPath !== expected.canonicalPath ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Kandidatens katalog ändrades under infrysningen.",
        true,
      )
    }
  }
  const visit = async (relativeDir: string): Promise<void> => {
    const directory = relativeDir ? join(workerDir, relativeDir) : workerDir
    const identity = await directoryIdentity(directory)
    const handle = await opendir(directory)
    const entries = []
    try {
      for await (const entry of handle) entries.push(entry)
    } finally {
      await handle.close().catch(() => undefined)
    }
    await assertSameDirectory(directory, identity)
    for (const entry of entries) {
      visitedEntries += 1
      if (visitedEntries > MAX_CANDIDATE_FILES_V1) {
        throw new WorkspacePreparationError(
          "workspace_prepare_failed",
          "Kandidaten överskrider gränsen för antal filer och kataloger.",
          false,
        )
      }
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (path === RUNTIME_PREVIEW_ARTIFACT_PATH_V1) continue
      assertPortablePathV1(path)
      const absolutePath = join(workerDir, path)
      await requireContainedPath(workerDir, absolutePath)
      const stats = await lstat(absolutePath, { bigint: true })
      if (stats.isSymbolicLink()) {
        throw new WorkspacePreparationError(
          "workspace_prepare_failed",
          "Kandidaten innehåller en symlink eller annan otillåten filtyp.",
          false,
        )
      }
      if (stats.isDirectory()) {
        await visit(path)
        continue
      }
      if (!stats.isFile()) {
        throw new WorkspacePreparationError(
          "workspace_prepare_failed",
          "Kandidaten innehåller en otillåten filtyp.",
          false,
        )
      }
      if (files.length >= MAX_CANDIDATE_FILES_V1) {
        throw new WorkspacePreparationError(
          "workspace_prepare_failed",
          "Kandidaten överskrider gränsen för antal filer.",
          false,
        )
      }
      const flags = fsConstants.O_RDONLY |
        (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW)
      const handle = await open(absolutePath, flags)
      try {
        const before = await handle.stat({ bigint: true })
        const canonicalPath = await realpath(absolutePath)
        await requireCanonicalContainment(canonicalPath)
        const canonicalStats = await stat(canonicalPath, { bigint: true })
        if (
          !before.isFile() ||
          !canonicalStats.isFile() ||
          before.dev !== canonicalStats.dev ||
          before.ino !== canonicalStats.ino ||
          before.nlink !== 1n ||
          canonicalStats.nlink !== 1n ||
          before.size > BigInt(MAX_CANDIDATE_FILE_BYTES_V1)
        ) {
          throw new WorkspacePreparationError(
            "workspace_prepare_failed",
            "Kandidaten innehåller en osäker filidentitet eller överskrider V1-gränsen.",
            false,
          )
        }
        const bytes = await handle.readFile()
        const after = await handle.stat({ bigint: true })
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.nlink !== after.nlink ||
          bytes.byteLength !== Number(before.size)
        ) {
          throw new WorkspacePreparationError(
            "workspace_prepare_failed",
            "Kandidaten ändrades medan Runtime frös filinnehållet.",
            true,
          )
        }
        totalBytes += bytes.byteLength
        if (totalBytes > MAX_CANDIDATE_TOTAL_BYTES_V1) {
          throw new WorkspacePreparationError(
            "workspace_prepare_failed",
            "Kandidatens filer överskrider V1-gränsen.",
            false,
          )
        }
        files.push({
          path,
          mode: (before.mode & 0o111n) === 0n ? "100644" : "100755",
          bytes,
        })
      } finally {
        await handle.close()
      }
    }
    await assertSameDirectory(directory, identity)
  }
  await visit("")
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"))
}

async function snapshotWorkspaceV1(
  workspace: PreparedBuildWorkspaceV1,
  writeObjects: boolean,
): Promise<{
  entries: GitTreeEntryV1[]
  changedPaths: string[]
  preview: FrozenPreviewV1 | null
  check: FrozenStaticCheckV1
}> {
  const files = await captureWorkspaceFilesV1(workspace.workerDir)
  const snapshotHash = createHash("sha256").update(
    "siteagent-frozen-workspace-v1\0",
  )
  for (const file of files) {
    snapshotHash
      .update(file.path)
      .update("\0")
      .update(file.mode)
      .update("\0")
      .update(String(file.bytes.byteLength))
      .update("\0")
      .update(file.bytes)
  }
  const snapshotSha256 = snapshotHash.digest("hex")
  const entries: GitTreeEntryV1[] = []
  for (const file of files) {
    const oid = await gitWithInput(
      workspace.projectRepoDir,
      ["hash-object", ...(writeObjects ? ["-w"] : []), "--stdin"],
      file.bytes,
    )
    if (!/^[a-f0-9]{40}$/u.test(oid)) throw new Error("invalid_blob_oid")
    entries.push({ path: file.path, mode: file.mode, oid })
  }
  const baseEntries = await readGitTreeEntriesV1(
    workspace.projectRepoDir,
    workspace.baseCommit,
  )
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]))
  const currentByPath = new Map(entries.map((entry) => [entry.path, entry]))
  const changedPaths = [...new Set([...baseByPath.keys(), ...currentByPath.keys()])]
    .filter((path) => {
      const base = baseByPath.get(path)
      const current = currentByPath.get(path)
      return !base || !current || base.mode !== current.mode || base.oid !== current.oid
    })
    .sort()
  const fileByPath = new Map(files.map((file) => [file.path, file]))
  let previewSourcePath: string | null = null
  for (const path of ["dist/index.html", "build/index.html", "index.html"]) {
    const file = fileByPath.get(path)
    if (!file) continue
    const text = file.bytes.toString("utf8").toLowerCase()
    if (!text.includes("<html") && !text.includes("<!doctype html")) continue
    previewSourcePath = path
    break
  }
  const packageJson = fileByPath.get("package.json")
  if (!packageJson) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Den frysta statiska kandidaten saknar package.json.",
      false,
    )
  }
  try {
    const parsed = JSON.parse(packageJson.bytes.toString("utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("package_json_not_an_object")
    }
  } catch {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Den frysta statiska kandidatens package.json är ogiltig.",
      false,
    )
  }
  if (!previewSourcePath) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Den frysta statiska kandidaten saknar en verifierbar HTML-preview.",
      false,
    )
  }
  const previewFile = fileByPath.get(previewSourcePath)
  const previewText = previewFile?.bytes.toString("utf8") || ""
  if (!/<html(?:\s|>)/iu.test(previewText) || !/<body(?:\s|>)/iu.test(previewText)) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Den frysta statiska kandidatens HTML-preview saknar html eller body.",
      false,
    )
  }
  let previewBytes: Buffer
  try {
    previewBytes = buildSelfContainedPreviewV1(
      files,
      previewSourcePath,
      MAX_PREVIEW_ARTIFACT_BYTES_V1,
    )
  } catch (error) {
    const code = error instanceof SelfContainedPreviewErrorV1
      ? error.code
      : "preview_bundle_failed"
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      `HTML-previewn kunde inte göras självbärande (${code}).`,
      false,
    )
  }
  const preview: FrozenPreviewV1 = {
    sourcePath: previewSourcePath,
    bytes: previewBytes,
    sha256: createHash("sha256").update(previewBytes).digest("hex"),
  }
  return {
    entries,
    changedPaths,
    preview,
    check: {
      snapshotSha256,
      summary: `Runtime verifierade ${files.length} frysta filer och skapade en självbärande preview från ${preview.sourcePath}.`,
    },
  }
}

export async function inspectBuildWorkspaceV1(
  workspace: PreparedBuildWorkspaceV1,
): Promise<{ changedPaths: string[] }> {
  const snapshot = await snapshotWorkspaceV1(workspace, false)
  return { changedPaths: snapshot.changedPaths }
}

async function materializeRuntimePreviewArtifactV1(
  workspace: PreparedBuildWorkspaceV1,
  preview: FrozenPreviewV1,
): Promise<{ path: typeof RUNTIME_PREVIEW_ARTIFACT_PATH_V1; sha256: string }> {
  const artifactPath = join(workspace.workerDir, RUNTIME_PREVIEW_ARTIFACT_PATH_V1)
  await requireContainedPath(workspace.workerDir, artifactPath)
  let handle
  let created = false
  let completed = false
  try {
    handle = await open(artifactPath, "wx", 0o600)
    created = true
    await handle.writeFile(preview.bytes)
    await handle.sync()
    const stats = await handle.stat({ bigint: true })
    if (
      !stats.isFile() ||
      stats.nlink !== 1n ||
      stats.size !== BigInt(preview.bytes.byteLength)
    ) {
      throw new Error("runtime_preview_identity_mismatch")
    }
    completed = true
  } catch (error) {
    if (!created && (error as NodeJS.ErrnoException).code === "EEXIST") {
      let existingHandle
      try {
        const linkStats = await lstat(artifactPath, { bigint: true })
        if (!linkStats.isFile() || linkStats.isSymbolicLink()) {
          throw new Error("runtime_preview_not_regular")
        }
        const flags = fsConstants.O_RDONLY |
          (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW)
        existingHandle = await open(artifactPath, flags)
        const before = await existingHandle.stat({ bigint: true })
        const bytes = await existingHandle.readFile()
        const after = await existingHandle.stat({ bigint: true })
        completed =
          before.isFile() &&
          before.dev === linkStats.dev &&
          before.ino === linkStats.ino &&
          before.nlink === 1n &&
          before.size === BigInt(preview.bytes.byteLength) &&
          before.size === after.size &&
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs === after.ctimeNs &&
          before.dev === after.dev &&
          before.ino === after.ino &&
          bytes.equals(preview.bytes)
      } catch {
        completed = false
      } finally {
        await existingHandle?.close().catch(() => undefined)
      }
    }
  } finally {
    await handle?.close().catch(() => undefined)
    if (created && !completed) {
      await rm(artifactPath, { force: true }).catch(() => undefined)
    }
  }
  if (!completed) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Runtime kunde inte materialisera den självbärande previewn.",
      false,
    )
  }
  return {
    path: RUNTIME_PREVIEW_ARTIFACT_PATH_V1,
    sha256: preview.sha256,
  }
}

export async function recordBuildWorkspaceCandidateV1(
  workspace: PreparedBuildWorkspaceV1,
  binding: { tenantId: string; projectId: string },
): Promise<{
  candidateCommit: string
  candidateRevisionId: string
  changedPaths: string[]
  preview: { path: string; sha256: string } | null
  check: FrozenStaticCheckV1
}> {
  const snapshot = await snapshotWorkspaceV1(workspace, true)
  if (snapshot.changedPaths.length === 0) {
    throw new WorkspacePreparationError(
      "worker_no_changes",
      "OpenClaw slutförde körningen men skapade ingen kandidatändring.",
      false,
    )
  }
  if (!snapshot.preview) {
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Den frysta statiska kandidaten saknar en verifierbar HTML-preview.",
      false,
    )
  }
  const preview = await materializeRuntimePreviewArtifactV1(
    workspace,
    snapshot.preview,
  )
  const indexPath = join(
    dirname(workspace.projectRepoDir),
    `.siteagent-index-${workspace.workspaceId}-${randomUUID()}`,
  )
  await requireContainedPath(dirname(workspace.projectRepoDir), indexPath)
  const indexEnv = { GIT_INDEX_FILE: indexPath }
  try {
    await git(workspace.projectRepoDir, ["read-tree", "--empty"], indexEnv)
    for (const entry of snapshot.entries) {
      await git(
        workspace.projectRepoDir,
        ["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, entry.path],
        indexEnv,
      )
    }
    const candidateTree = await git(
      workspace.projectRepoDir,
      ["write-tree"],
      indexEnv,
    )
    const candidateRevisionId = candidateRevisionIdV1(
      binding,
      workspace.baseCommit,
      candidateTree,
    )
    const commitEnvironment = {
      GIT_AUTHOR_NAME: "Sajtagent Runtime",
      GIT_AUTHOR_EMAIL: "runtime@siteagent.invalid",
      GIT_COMMITTER_NAME: "Sajtagent Runtime",
      GIT_COMMITTER_EMAIL: "runtime@siteagent.invalid",
    }
    let candidateCommit = await gitWithInput(
      workspace.projectRepoDir,
      ["commit-tree", candidateTree, "-p", workspace.baseCommit],
      Buffer.from(`Sajtagent candidate ${workspace.workspaceId}\n`, "utf8"),
      commitEnvironment,
    )
    const revisionRef = projectRevisionRefV1(candidateRevisionId)
    try {
      await git(workspace.projectRepoDir, [
        "update-ref",
        revisionRef,
        candidateCommit,
        ZERO_OID_V1,
      ])
    } catch {
      const existingCommit = await git(workspace.projectRepoDir, [
        "rev-parse",
        "--verify",
        `${revisionRef}^{commit}`,
      ])
      const existingTree = await git(workspace.projectRepoDir, [
        "rev-parse",
        `${existingCommit}^{tree}`,
      ])
      const parents = (await git(workspace.projectRepoDir, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        existingCommit,
      ])).split(" ")
      if (
        existingTree !== candidateTree ||
        parents.length !== 2 ||
        parents[1] !== workspace.baseCommit ||
        candidateRevisionIdV1(binding, parents[1], existingTree) !==
          candidateRevisionId
      ) {
        throw new Error("candidate_revision_projection_conflict")
      }
      candidateCommit = existingCommit
    }
    return {
      candidateCommit,
      candidateRevisionId,
      changedPaths: snapshot.changedPaths,
      preview,
      check: snapshot.check,
    }
  } catch (error) {
    if (error instanceof WorkspacePreparationError) throw error
    throw new WorkspacePreparationError(
      "workspace_prepare_failed",
      "Kandidatens immutable Git-projektion kunde inte registreras.",
      true,
    )
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined)
  }
}

export function parseGitStatusPathsV1(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((path) => (path.includes(" -> ") ? path.split(" -> ").at(-1) || path : path))
    .sort()
}

export async function findPreviewArtifactV1(
  workspace: PreparedBuildWorkspaceV1,
): Promise<{ path: string; sha256: string } | null> {
  const preview = (await snapshotWorkspaceV1(workspace, false)).preview
  if (!preview) return null
  return materializeRuntimePreviewArtifactV1(workspace, preview)
}
