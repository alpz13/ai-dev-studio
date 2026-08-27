/**
 * Smoke test for fs-ops + git-ops against a REAL git repo in a temporary
 * directory (no MCP, no network). Usage: tsx scripts/test-filesystem-git-ops.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRoot, listDirEntries, readTextFile, resolveSafePath, writeTextFile } from "../../src/filesystem-git/fs-ops.js";
import { gitAdd, gitCommit, gitDiff, gitInitIfNeeded, gitStatus } from "../../src/filesystem-git/git-ops.js";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fsgit-test-"));
  await ensureRoot(root);

  // 1. Path traversal outside the workspace must be blocked.
  assert.throws(() => resolveSafePath(root, "../../etc/passwd"));
  assert.throws(() => resolveSafePath(root, "/etc/passwd"));

  // 2. Write and read a file inside the workspace.
  await writeTextFile(root, "hello.txt", "hello from the Dev agent\n");
  const content = await readTextFile(root, "hello.txt");
  assert.equal(content, "hello from the Dev agent\n");

  // 3. List the directory.
  const entries = await listDirEntries(root, ".");
  assert.ok(entries.some((e) => e.name === "hello.txt" && e.type === "file"));

  // 4. git init + status + add + commit, against a real repo.
  const didInit = await gitInitIfNeeded(root);
  assert.equal(didInit, true);

  const statusBefore = await gitStatus(root);
  assert.match(statusBefore, /hello\.txt/);

  await gitAdd(root, ["."]);
  const sha = await gitCommit(root, "feat: add hello.txt");
  assert.match(sha, /^[0-9a-f]{40}$/);

  const statusAfter = await gitStatus(root);
  assert.equal(statusAfter, "", "nothing should be pending right after the commit");

  // 5. Modify the file and confirm git diff detects it.
  await writeTextFile(root, "hello.txt", "hello from the Dev agent (v2)\n");
  const diff = await gitDiff(root);
  assert.match(diff, /hello\.txt/);
  assert.match(diff, /v2/);

  // 6. gitInitIfNeeded on an already-existing repo must not re-initialize it.
  const didInitAgain = await gitInitIfNeeded(root);
  assert.equal(didInitAgain, false);

  await fs.rm(root, { recursive: true, force: true });

  console.log("✅ All filesystem-git checks (fs-ops + git-ops) passed.");
  console.log("   - path traversal outside the workspace is blocked (relative and absolute)");
  console.log("   - write/read/list of files works inside the workspace");
  console.log("   - git init/status/add/commit/diff ran against a real repo");
  console.log("   - gitInitIfNeeded is idempotent");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
