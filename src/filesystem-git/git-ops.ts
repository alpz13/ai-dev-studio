/**
 * Git wrapper via the system CLI (child_process), without depending on
 * any extra npm package — this way it runs the same on any machine that
 * already has git installed, without adding another dependency to check.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ExecError {
  stdout?: string;
  stderr?: string;
  message: string;
}

async function runGit(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: root });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as ExecError;
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr || e.message}`);
  }
}

/** Initializes the repo if `root` isn't one yet. Returns true if it just created it. */
export async function gitInitIfNeeded(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    return false;
  } catch {
    await runGit(root, ["init"]);
    return true;
  }
}

export async function gitStatus(root: string): Promise<string> {
  const { stdout } = await runGit(root, ["status", "--porcelain=v1"]);
  return stdout;
}

export async function gitAdd(root: string, paths: string[] = ["."]): Promise<void> {
  await runGit(root, ["add", ...paths]);
}

export async function gitCommit(root: string, message: string): Promise<string> {
  // Minimal author in case the repo doesn't have user.name/user.email configured
  // (typical on a freshly started practice machine/container).
  await runGit(root, [
    "-c",
    "user.email=dev-agent@ai-dev-studio.local",
    "-c",
    "user.name=Dev Agent",
    "commit",
    "-m",
    message,
  ]);
  const { stdout } = await runGit(root, ["rev-parse", "HEAD"]);
  return stdout;
}

export async function gitDiff(root: string, opts: { staged?: boolean } = {}): Promise<string> {
  const args = ["diff"];
  if (opts.staged) args.push("--staged");
  const { stdout } = await runGit(root, args);
  return stdout;
}
