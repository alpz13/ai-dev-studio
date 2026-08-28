import path from "node:path";

/**
 * Chooses how to launch an MCP server subprocess: `tsx` against the TS
 * source in dev (matches the project's no-build-step convention), or
 * plain `node` against the compiled JS in production (NODE_ENV=production,
 * set by the Docker image), which has no `tsx`/`src` available at runtime.
 * Both paths are resolved relative to the process's cwd, matching how
 * `npm run web` / the container's WORKDIR already run.
 */
export function mcpServerCommand(relativeTsPath: string): { command: string; args: string[] } {
  if (process.env.NODE_ENV === "production") {
    const jsPath = path.join("dist", relativeTsPath.replace(/\.ts$/, ".js"));
    return { command: process.execPath, args: [jsPath] };
  }
  return { command: "npx", args: ["tsx", relativeTsPath] };
}
