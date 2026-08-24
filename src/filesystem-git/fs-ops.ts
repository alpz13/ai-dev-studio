/**
 * Operaciones de archivos, acotadas a un "workspace root". Toda ruta que
 * intente salirse de esa raíz (../.. o una ruta absoluta) se rechaza — el
 * agente Dev nunca debería poder tocar nada fuera de su propio workspace.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export function resolveSafePath(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Ruta fuera del workspace permitido: "${relPath}"`);
  }
  return resolved;
}

export async function ensureRoot(root: string): Promise<void> {
  await fs.mkdir(path.resolve(root), { recursive: true });
}

export async function readTextFile(root: string, relPath: string): Promise<string> {
  const full = resolveSafePath(root, relPath);
  return fs.readFile(full, "utf-8");
}

export async function writeTextFile(root: string, relPath: string, content: string): Promise<void> {
  const full = resolveSafePath(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "other";
}

export async function listDirEntries(root: string, relPath = "."): Promise<DirEntry[]> {
  const full = resolveSafePath(root, relPath);
  const entries = await fs.readdir(full, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
  }));
}
