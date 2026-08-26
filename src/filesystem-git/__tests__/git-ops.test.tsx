import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTextFile } from "../../filesystem-git/fs-ops.js";
import { gitAdd, gitCommit, gitDiff, gitInitIfNeeded, gitStatus } from "../../filesystem-git/git-ops.js";

// These tests run real git (via child_process) against a real repo
// in a temporary directory — no mocks, no network.
describe("filesystem-git/git-ops", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-gitops-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("gitInitIfNeeded initializes a new repo and is idempotent", async () => {
    await expect(gitInitIfNeeded(root)).resolves.toBe(true);

    const gitDir = await fs.stat(path.join(root, ".git"));
    expect(gitDir.isDirectory()).toBe(true);

    await expect(gitInitIfNeeded(root)).resolves.toBe(false);
  });

  it("gitStatus reflects an untracked file", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "hello\n");

    const status = await gitStatus(root);

    expect(status).toMatch(/hello\.txt/);
  });

  it("gitAdd + gitCommit create a commit and clear the status", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "hello\n");

    await gitAdd(root, ["."]);
    const sha = await gitCommit(root, "feat: add hello.txt");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(gitStatus(root)).resolves.toBe("");
  });

  it("gitCommit with nothing staged rejects with a readable error", async () => {
    await gitInitIfNeeded(root);

    await expect(gitCommit(root, "empty commit")).rejects.toThrow(/failed/);
  });

  it("gitDiff detects changes against HEAD after a commit", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "v1\n");
    await gitAdd(root, ["."]);
    await gitCommit(root, "feat: v1");

    await writeTextFile(root, "hello.txt", "v2\n");
    const diff = await gitDiff(root);

    expect(diff).toMatch(/hello\.txt/);
    expect(diff).toMatch(/v2/);
  });

  it("gitDiff with staged:true reflects what's in the staging area", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "v1\n");

    await gitAdd(root, ["."]);
    const stagedDiff = await gitDiff(root, { staged: true });

    expect(stagedDiff).toMatch(/hello\.txt/);
  });

  it("gitDiff with no changes returns an empty string", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "v1\n");
    await gitAdd(root, ["."]);
    await gitCommit(root, "feat: v1");

    await expect(gitDiff(root)).resolves.toBe("");
  });
});
