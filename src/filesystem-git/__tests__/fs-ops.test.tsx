import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRoot, listDirEntries, readTextFile, resolveSafePath, writeTextFile } from "../../filesystem-git/fs-ops.js";

describe("filesystem-git/fs-ops", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fsops-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("resolveSafePath", () => {
    it("allows a relative path inside the workspace", () => {
      expect(resolveSafePath(root, "a/b.txt")).toBe(path.resolve(root, "a/b.txt"));
    });

    it("allows the root itself ('.')", () => {
      expect(resolveSafePath(root, ".")).toBe(path.resolve(root));
    });

    it("blocks a relative path traversal", () => {
      expect(() => resolveSafePath(root, "../outside.txt")).toThrow(/outside the allowed workspace/);
    });

    it("blocks an absolute path outside the workspace", () => {
      expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(/outside the allowed workspace/);
    });
  });

  describe("ensureRoot / writeTextFile / readTextFile", () => {
    it("creates the root folder if it doesn't exist, including intermediate ones", async () => {
      const nested = path.join(root, "nested", "dir");

      await ensureRoot(nested);

      const stat = await fs.stat(nested);
      expect(stat.isDirectory()).toBe(true);
    });

    it("writes and reads a text file inside the workspace", async () => {
      await writeTextFile(root, "hello.txt", "hello\n");

      await expect(readTextFile(root, "hello.txt")).resolves.toBe("hello\n");
    });

    it("creates intermediate folders when writing to a subpath", async () => {
      await writeTextFile(root, "a/b/c.txt", "content");

      await expect(readTextFile(root, "a/b/c.txt")).resolves.toBe("content");
    });

    it("writing over an existing file overwrites it", async () => {
      await writeTextFile(root, "hello.txt", "v1");
      await writeTextFile(root, "hello.txt", "v2");

      await expect(readTextFile(root, "hello.txt")).resolves.toBe("v2");
    });

    it("reading a nonexistent file rejects", async () => {
      await expect(readTextFile(root, "does-not-exist.txt")).rejects.toThrow();
    });

    it("writing outside the workspace rejects instead of writing to disk", async () => {
      await expect(writeTextFile(root, "../outside.txt", "x")).rejects.toThrow(/outside the allowed workspace/);
    });
  });

  describe("listDirEntries", () => {
    it("lists files and folders with their type", async () => {
      await writeTextFile(root, "file.txt", "x");
      await fs.mkdir(path.join(root, "folder"));

      const entries = await listDirEntries(root, ".");

      expect(entries).toContainEqual({ name: "file.txt", type: "file" });
      expect(entries).toContainEqual({ name: "folder", type: "dir" });
    });

    it("lists the workspace root by default", async () => {
      await writeTextFile(root, "only.txt", "x");

      const entries = await listDirEntries(root);

      expect(entries.some((e) => e.name === "only.txt")).toBe(true);
    });

    it("an empty folder returns []", async () => {
      await fs.mkdir(path.join(root, "empty"));

      const entries = await listDirEntries(root, "empty");

      expect(entries).toEqual([]);
    });
  });
});
