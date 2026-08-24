import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRoot, listDirEntries, readTextFile, resolveSafePath, writeTextFile } from "../fs-ops.js";

describe("filesystem-git/fs-ops", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fsops-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("resolveSafePath", () => {
    it("permite una ruta relativa dentro del workspace", () => {
      expect(resolveSafePath(root, "a/b.txt")).toBe(path.resolve(root, "a/b.txt"));
    });

    it("permite la raíz misma ('.')", () => {
      expect(resolveSafePath(root, ".")).toBe(path.resolve(root));
    });

    it("bloquea un path traversal relativo", () => {
      expect(() => resolveSafePath(root, "../fuera.txt")).toThrow(/fuera del workspace/);
    });

    it("bloquea una ruta absoluta fuera del workspace", () => {
      expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(/fuera del workspace/);
    });
  });

  describe("ensureRoot / writeTextFile / readTextFile", () => {
    it("crea la carpeta raíz si no existe, incluidas intermedias", async () => {
      const nested = path.join(root, "nested", "dir");

      await ensureRoot(nested);

      const stat = await fs.stat(nested);
      expect(stat.isDirectory()).toBe(true);
    });

    it("escribe y lee un archivo de texto dentro del workspace", async () => {
      await writeTextFile(root, "hello.txt", "hola\n");

      await expect(readTextFile(root, "hello.txt")).resolves.toBe("hola\n");
    });

    it("crea carpetas intermedias al escribir en una subruta", async () => {
      await writeTextFile(root, "a/b/c.txt", "contenido");

      await expect(readTextFile(root, "a/b/c.txt")).resolves.toBe("contenido");
    });

    it("escribir sobre un archivo existente lo sobreescribe", async () => {
      await writeTextFile(root, "hello.txt", "v1");
      await writeTextFile(root, "hello.txt", "v2");

      await expect(readTextFile(root, "hello.txt")).resolves.toBe("v2");
    });

    it("leer un archivo inexistente rechaza", async () => {
      await expect(readTextFile(root, "no-existe.txt")).rejects.toThrow();
    });

    it("escribir fuera del workspace rechaza en vez de escribir en disco", async () => {
      await expect(writeTextFile(root, "../fuera.txt", "x")).rejects.toThrow(/fuera del workspace/);
    });
  });

  describe("listDirEntries", () => {
    it("lista archivos y carpetas con su tipo", async () => {
      await writeTextFile(root, "file.txt", "x");
      await fs.mkdir(path.join(root, "carpeta"));

      const entries = await listDirEntries(root, ".");

      expect(entries).toContainEqual({ name: "file.txt", type: "file" });
      expect(entries).toContainEqual({ name: "carpeta", type: "dir" });
    });

    it("por default lista la raíz del workspace", async () => {
      await writeTextFile(root, "solo.txt", "x");

      const entries = await listDirEntries(root);

      expect(entries.some((e) => e.name === "solo.txt")).toBe(true);
    });

    it("una carpeta vacía devuelve []", async () => {
      await fs.mkdir(path.join(root, "vacia"));

      const entries = await listDirEntries(root, "vacia");

      expect(entries).toEqual([]);
    });
  });
});
