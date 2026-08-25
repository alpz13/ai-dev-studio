/**
 * Prueba de humo de fs-ops + git-ops contra un repo de git REAL en un
 * directorio temporal (sin MCP, sin red). Uso: tsx scripts/test-filesystem-git-ops.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRoot, listDirEntries, readTextFile, resolveSafePath, writeTextFile } from "../src/filesystem-git/fs-ops.js";
import { gitAdd, gitCommit, gitDiff, gitInitIfNeeded, gitStatus } from "../src/filesystem-git/git-ops.js";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fsgit-test-"));
  await ensureRoot(root);

  // 1. Path traversal fuera del workspace debe bloquearse.
  assert.throws(() => resolveSafePath(root, "../../etc/passwd"));
  assert.throws(() => resolveSafePath(root, "/etc/passwd"));

  // 2. Escribir y leer un archivo dentro del workspace.
  await writeTextFile(root, "hello.txt", "hola desde el Dev agent\n");
  const content = await readTextFile(root, "hello.txt");
  assert.equal(content, "hola desde el Dev agent\n");

  // 3. Listar el directorio.
  const entries = await listDirEntries(root, ".");
  assert.ok(entries.some((e) => e.name === "hello.txt" && e.type === "file"));

  // 4. git init + status + add + commit, contra un repo real.
  const didInit = await gitInitIfNeeded(root);
  assert.equal(didInit, true);

  const statusBefore = await gitStatus(root);
  assert.match(statusBefore, /hello\.txt/);

  await gitAdd(root, ["."]);
  const sha = await gitCommit(root, "feat: agregar hello.txt");
  assert.match(sha, /^[0-9a-f]{40}$/);

  const statusAfter = await gitStatus(root);
  assert.equal(statusAfter, "", "no debe quedar nada pendiente justo después del commit");

  // 5. Modificar el archivo y confirmar que git diff lo detecta.
  await writeTextFile(root, "hello.txt", "hola desde el Dev agent (v2)\n");
  const diff = await gitDiff(root);
  assert.match(diff, /hello\.txt/);
  assert.match(diff, /v2/);

  // 6. gitInitIfNeeded sobre un repo ya existente no debe re-inicializar.
  const didInitAgain = await gitInitIfNeeded(root);
  assert.equal(didInitAgain, false);

  await fs.rm(root, { recursive: true, force: true });

  console.log("✅ Todas las verificaciones de filesystem-git (fs-ops + git-ops) pasaron.");
  console.log("   - path traversal fuera del workspace se bloquea (relativo y absoluto)");
  console.log("   - write/read/list de archivos funciona dentro del workspace");
  console.log("   - git init/status/add/commit/diff corrieron contra un repo real");
  console.log("   - gitInitIfNeeded es idempotente");
}

main().catch((err) => {
  console.error("❌ Falló la prueba:", err);
  process.exit(1);
});
