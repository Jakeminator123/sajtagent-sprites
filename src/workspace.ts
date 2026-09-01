import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import type { BuildJobV1 } from "../contracts/builder-v1.ts"

const execFileAsync = promisify(execFile)

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

export class WorkspacePreparationError extends Error {
  readonly code: WorkspacePreparationErrorCode
  readonly retryable: boolean

  constructor(code: WorkspacePreparationErrorCode, message: string, retryable: boolean) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  })
  return stdout.trim()
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
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)])
  await requireContainedPath(realRoot, realCandidate)
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
    const repoStats = await lstat(projectRepoDir)
    if (!repoStats.isDirectory() || repoStats.isSymbolicLink()) {
      throw new Error("not_a_real_directory")
    }
    await requireRealContainedPath(options.projectsRoot, projectRepoDir)
  } catch {
    throw new WorkspacePreparationError(
      "workspace_revision_unavailable",
      "Projektets serverägda Git-checkout finns inte på Spriten ännu.",
      true,
    )
  }

  let baseCommit: string
  try {
    baseCommit = await git(projectRepoDir, ["rev-parse", "HEAD"])
  } catch {
    throw new WorkspacePreparationError(
      "workspace_revision_unavailable",
      "Projektets workspace är inte en läsbar Git-checkout.",
      true,
    )
  }
  if (baseCommit !== job.baseRevisionId) {
    throw new WorkspacePreparationError(
      "stale_revision",
      "BuildJobV1 baseRevisionId matchar inte projektets serverägda HEAD.",
      false,
    )
  }
  if ((await git(projectRepoDir, ["status", "--porcelain=v1"])) !== "") {
    throw new WorkspacePreparationError(
      "workspace_base_dirty",
      "Projektets baskatalog har lokala ändringar och får inte användas som byggkälla.",
      true,
    )
  }

  await mkdir(options.workersRoot, { recursive: true })
  let workerExists = true
  try {
    const workerStats = await lstat(workerDir)
    if (!workerStats.isDirectory() || workerStats.isSymbolicLink()) {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Ett befintligt worker-mål är inte en riktig katalog.",
        false,
      )
    }
    await requireRealContainedPath(options.workersRoot, workerDir)
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      workerExists = false
    } else {
      throw error
    }
  }

  if (workerExists) {
    try {
      const existingGitFile = await readFile(join(workerDir, ".git"), "utf8")
      if (!existingGitFile.startsWith("gitdir:")) throw new Error("invalid_worktree")
      const existingBase = await git(workerDir, ["rev-parse", "HEAD"])
      if (existingBase !== baseCommit) throw new Error("wrong_base")
    } catch {
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        "Ett befintligt worker-mål matchar inte jobbets isolerade Git-worktree.",
        false,
      )
    }
  } else {
    try {
      await execFileAsync(
        "git",
        ["worktree", "add", "--detach", workerDir, baseCommit],
        { cwd: projectRepoDir, encoding: "utf8", windowsHide: true },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error"
      throw new WorkspacePreparationError(
        "workspace_prepare_failed",
        `Kunde inte skapa isolerat Git-worktree: ${message}`,
        true,
      )
    }
  }
  await requireRealContainedPath(options.workersRoot, workerDir)

  return { projectRepoDir, workerDir, baseCommit, workspaceId }
}

export async function inspectBuildWorkspaceV1(
  workspace: PreparedBuildWorkspaceV1,
): Promise<{ changedPaths: string[]; candidateRevisionId: string }> {
  const porcelain = await git(workspace.workerDir, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
  const changedPaths = porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((path) => (path.includes(" -> ") ? path.split(" -> ").at(-1) || path : path))
    .sort()

  const digest = createHash("sha256").update(`${workspace.baseCommit}\0`)
  for (const path of changedPaths) {
    digest.update(path).update("\0")
    try {
      digest.update(await readFile(join(workspace.workerDir, path)))
    } catch {
      digest.update("deleted")
    }
    digest.update("\0")
  }

  return {
    changedPaths,
    candidateRevisionId: `candidate:${digest.digest("hex")}`,
  }
}
