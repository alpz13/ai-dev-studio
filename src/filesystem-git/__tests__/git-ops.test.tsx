import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTextFile } from "../../filesystem-git/fs-ops.js";
import { gitAdd, gitCommit, gitDiff, gitInitIfNeeded, gitStatus } from "../../filesystem-git/git-ops.js";

// Estas pruebas corren git de verdad (vía child_process) contra un repo real
// en un directorio temporal — sin mocks, sin red.
describe("filesystem-git/git-ops", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-gitops-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("gitInitIfNeeded inicializa un repo nuevo y es idempotente", async () => {
    await expect(gitInitIfNeeded(root)).resolves.toBe(true);

    const gitDir = await fs.stat(path.join(root, ".git"));
    expect(gitDir.isDirectory()).toBe(true);

    await expect(gitInitIfNeeded(root)).resolves.toBe(false);
  });

  it("gitStatus refleja un archivo sin trackear", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "hola\n");

    const status = await gitStatus(root);

    expect(status).toMatch(/hello\.txt/);
  });

  it("gitAdd + gitCommit crean un commit y limpian el status", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "hola\n");

    await gitAdd(root, ["."]);
    const sha = await gitCommit(root, "feat: agregar hello.txt");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(gitStatus(root)).resolves.toBe("");
  });

  it("gitCommit sin nada en staging rechaza con un error legible", async () => {
    await gitInitIfNeeded(root);

    await expect(gitCommit(root, "commit vacío")).rejects.toThrow(/falló/);
  });

  it("gitDiff detecta cambios contra HEAD después de un commit", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "v1\n");
    await gitAdd(root, ["."]);
    await gitCommit(root, "feat: v1");

    await writeTextFile(root, "hello.txt", "v2\n");
    const diff = await gitDiff(root);

    expect(diff).toMatch(/hello\.txt/);
    expect(diff).toMatch(/v2/);
  });

  it("gitDiff con staged:true refleja lo que está en el staging area", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "v1\n");

    await gitAdd(root, ["."]);
    const stagedDiff = await gitDiff(root, { staged: true });

    expect(stagedDiff).toMatch(/hello\.txt/);
  });

  it("gitDiff sin cambios devuelve string vacío", async () => {
    await gitInitIfNeeded(root);
    await writeTextFile(root, "hello.txt", "v1\n");
    await gitAdd(root, ["."]);
    await gitCommit(root, "feat: v1");

    await expect(gitDiff(root)).resolves.toBe("");
  });
});
