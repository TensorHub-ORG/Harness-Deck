import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface PreparedWorkspace {
  cwd: string;
  isolated: boolean;
  branch?: string;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
}

export class WorktreeManager {
  constructor(private readonly worktreeRoot: string) {
    fs.mkdirSync(path.resolve(worktreeRoot), { recursive: true });
  }

  public isGitRepo(repoPath: string): boolean {
    try {
      const out = runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
      return out === "true";
    } catch {
      return false;
    }
  }

  /**
   * Prepares an isolated git worktree so remote tasks NEVER overwrite or pollute
   * the developer's active dirty working tree.
   */
  public prepare(params: {
    repoPath: string;
    taskId: string;
    sandbox: "L1_READONLY" | "L2_WORKTREE_DEV" | "L3_APPROVED_EXEC";
    gitIsolation: "worktree" | "none";
    existingBranch?: string;
  }): PreparedWorkspace {
    const absRepo = path.resolve(params.repoPath);
    if (!fs.existsSync(absRepo)) {
      throw new Error(`Workspace path does not exist: ${absRepo}`);
    }

    if (params.sandbox === "L1_READONLY" || params.gitIsolation === "none" || !this.isGitRepo(absRepo)) {
      return { cwd: absRepo, isolated: false };
    }

    // Verify repo has at least one commit before creating worktree
    try {
      runGit(absRepo, ["rev-parse", "HEAD"]);
    } catch {
      return { cwd: absRepo, isolated: false };
    }

    const safeTaskId = params.taskId.replace(/[^A-Za-z0-9_-]/g, "_");
    const wtPath = path.resolve(this.worktreeRoot, safeTaskId);
    const branch = params.existingBranch ?? `deck/${safeTaskId}`;

    if (fs.existsSync(wtPath)) {
      return { cwd: wtPath, isolated: true, branch };
    }

    // Check if branch already exists (e.g., rework task)
    let branchExists = false;
    try {
      runGit(absRepo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      runGit(absRepo, ["worktree", "add", wtPath, branch]);
    } else {
      runGit(absRepo, ["worktree", "add", "-b", branch, wtPath]);
    }

    return { cwd: wtPath, isolated: true, branch };
  }

  public collectDiffStat(cwd: string): string {
    if (!this.isGitRepo(cwd)) return "";
    try {
      const status = runGit(cwd, ["status", "--short"]);
      const diffStat = runGit(cwd, ["diff", "--stat"]);
      return [status ? `Status:\n${status}` : "", diffStat ? `Diff:\n${diffStat}` : ""]
        .filter(Boolean)
        .join("\n\n");
    } catch {
      return "";
    }
  }

  public listWorktrees(): string[] {
    const root = path.resolve(this.worktreeRoot);
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  }

  public cleanupWorktree(repoPath: string, taskId: string): boolean {
    const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, "_");
    const wtPath = path.resolve(this.worktreeRoot, safeTaskId);
    if (!fs.existsSync(wtPath)) return false;
    try {
      runGit(path.resolve(repoPath), ["worktree", "remove", "--force", wtPath]);
      return true;
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
      return true;
    }
  }
}
